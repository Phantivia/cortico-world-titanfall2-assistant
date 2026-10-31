/**
 * Titanfall2World: the bot rides along in BT through the Titanfall 2 campaign.
 *
 * The Northstar mod (mod/) posts the game state to the engine child (sidecar.ts) four times a
 * second; this class turns those frames into events and tool receipts and sends BT's support
 * commands and subtitles back through the child. Game state reaches the context three ways:
 * edge alerts pushed when they happen, a snapshot rendered from the newest frame at delivery
 * (piggyback, only the parts that changed since the last one), and `titanfall2_scan` on demand.
 * Campaign dialogue arrives through a hook the World patches into the game's dialogue script
 * (story.ts); it is queued and rendered at delivery with a game frame read at that moment.
 * BT's voice is VoxCPM2 cloned from a line cut out of the installed game (voice.ts); it starts when a
 * one-click start runs (play.ts) or a level links, so a World left on does not hold the GPU.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childExecArgv } from 'cortico/extensions/runtime.ts';
import type { EventTag, Logger, ToolDef, ToolOutcome, TriggerMode, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { nowIso } from 'cortico/core/util.ts';
import * as OpenCC from 'opencc-js';
import { TITANFALL2_ID, titanfall2ConfigGroups, type Titanfall2ConfigSection } from './config.ts';
import type { CaptureResult, ChildToMain, EngineNotice, EngineRequest, Frame } from './engine-ipc.ts';
import type { Progress } from './download.ts';
import { checkGame, eaAppPath, findGameDirs, installMod, NORTHSTAR_VERSION, runningGame, type GameCheck } from './game.ts';
import {
  Labels, btLine, className, countText, enemiesBlock, enemyText, weaponName as weaponNameOf, frameTokens, mapName, meters, objectiveLine, pct, pilotLine, readiness, relative, seenEnemies, whereText,
  type Lookup, type SeenEnemy,
} from './intel.ts';
import { Play } from './play.ts';
import { Player } from './player.ts';
import type { ClientPost, CommandAck, GameEvent, PoiFrame, ServerCommand, SubtitleCommand } from './protocol.ts';
import { Speech, width as textWidth } from './speech.ts';
import { Captions } from './story.ts';
import { TITANFALL2_TOOL_DECLS } from './tools.ts';
import { Voice, type VoicePhase } from './voice.ts';
import { downloadVoiceAssets, voiceAssets } from './voice-assets.ts';

const ENGINE_FILE = fileURLToPath(new URL('./engine-child.ts', import.meta.url));
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const TICK_MS = 1000;
const COMMAND_TIMEOUT_MS = 4000;
const SUBTITLE_TIMEOUT_MS = 3000;
/** A link that stays down this long is reported; shorter gaps are pauses and loading. */
const LINK_DOWN_REPORT_MS = 10_000;
const SNAPSHOT_ANCHOR_MS = 120_000;
const LABEL_KEEP_MS = 60_000;
const KILL_BATCH_MS = 3000;
const COMBAT_END_MS = 10_000;
const COMBAT_NEAR_M = 40;
/** SONAR_PULSE_RADIUS of mp_titanability_sonar_pulse, in game units. */
const PULSE_RADIUS_UNITS = 1250;
/** A battery this close is worth mentioning while BT is below half health. */
const BATTERY_NEAR_M = 40;
/** An enemy titan this close interrupts; farther ones wait for the next batch. */
const BIG_NEAR_M = 120;
/** A doomed enemy titan this close is worth waking up for even when allies did it. */
const DOOMED_NEAR_M = 100;
const IMAGE_MIME = 'image/jpeg';
const JPEG_QUALITY = 80;
/** Lines kept for one story event; older ones are dropped when nothing delivers them. */
const STORY_LINE_MAX = 40;
const LINE_REPEAT_MS = 10_000;
/** Subtitle RUI metrics in font-size units, measured in game: a CJK character and a line. */
const CHAR_UNIT = 0.76;
const LINE_UNIT = 1.3;

const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' });
const toTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' });

/** BT loadout pickups by their weapon: the loadout's name and its primary weapon. */
const LOADOUT_NAMES: Record<string, string> = {
  mp_titanweapon_xo16_shorty: 'Expedition(XO-16)',
  mp_titanweapon_sticky_40mm: 'Tone(40mm 机炮)',
  mp_titanweapon_meteor: 'Scorch(T-203 铝热剂发射器)',
  mp_titanweapon_leadwall: 'Ronin(铅墙霰弹枪)',
  mp_titanweapon_rocketeer_rocketstream: 'Brute(四联火箭)',
  mp_titanweapon_particle_accelerator: 'Ion(分裂枪)',
  mp_titanweapon_sniper: 'Northstar(电浆磁轨炮)',
  mp_titanweapon_predator_cannon: 'Legion(猎杀者加农炮)',
};

type Args = Record<string, unknown>;

export interface Titanfall2WorldOptions {
  cfg: Titanfall2ConfigSection;
  timezone: string;
  dataDir: string;
  runtimesRoot: string;
  modelsRoot: string;
}

const FAIL_TEXT: Record<NonNullable<CommandAck['reason']>, string> = {
  no_pilot: '铁驭阵亡或不在场',
  no_titan: 'BT 不在场(这一关还没有 BT,或 BT 已被摧毁)',
  no_missiles: 'BT 现在的装备没有多目标飞弹系统',
  no_targets: '这些目标已经不在了',
  cooldown: '还在冷却',
  charging: '飞弹系统充能不足',
  no_weapon: 'BT 手上没有武器',
  embarked: '铁驭正在驾驶 BT,BT 的攻击由铁驭决定',
  script_error: '模组执行时出错(详情在运行日志)',
  unknown_op: '游戏里的模组不认识这个指令(模组版本不对)',
};

interface Segment {
  key: string;
  text: string;
  cmp: string;
}

const bucket = (v: number, size: number): number => Math.floor(v / size);

export class Titanfall2World implements World {
  readonly id = TITANFALL2_ID;
  private readonly cfg: Titanfall2ConfigSection;
  private host: WorldHost | null = null;
  private log: Logger | null = null;
  private stopped = true;

  private engine: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { done: (v: unknown) => void; fail: (e: Error) => void }>();
  private sidecarError: string | null = null;

  private readonly link = { server: false, client: false };
  private linkDownAt: number | null = null;
  private linkDownReported = false;
  private everUp = false;

  private frame: Frame | null = null;
  private map = '';
  private objective = '';
  private readonly localized = new Map<string, string>();
  private readonly asked = new Set<string>();
  private readonly labels = new Labels();
  private readonly lookup: Lookup = {
    text: (t) => {
      if (!t) return null;
      const text = t.startsWith('#') ? this.localized.get(t) ?? null : t;
      return text && this.cfg.story.simplified ? toSimplified(text) : text;
    },
  };

  /* alert edges */
  private readonly lastAlertAt = new Map<string, number>();
  private readonly seenBig = new Set<number>();
  private kills: Array<{ cls: string; by: string; weapon: string; boss?: string }> = [];
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private inCombat = false;
  private quietSince: number | null = null;

  /* snapshot */
  private snapshotArmed = false;
  private lastSnapshotAt = 0;
  private lastAnchorAt = 0;
  private baseline: Map<string, string> | null = null;

  /* story */
  private captions: Captions | null = null;
  private captionsKey = '';
  private storyLines: string[] = [];
  private storyArmed = false;
  private lastLine: { alias: string; at: number } | null = null;
  private lastFrameAt = 0;
  /** Attach a frame to the next story event regardless of the interval (new level, new objective). */
  private frameDue = true;
  private readonly helmetsAnnounced = new Set<string>();

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private voice: Voice | null = null;
  private player: Player | null = null;
  private speech: Speech | null = null;
  private play: Play | null = null;
  /** The Steam copy found at start or by the last detection; used while `gameDir` is empty. */
  private detectedDir: string | null = null;
  private readonly lookups = new Map<string, { at: number; value: unknown; pending: boolean }>();
  private voiceDownload: { progress: Progress | null; error: string | null; running: boolean } = { progress: null, error: null, running: false };

  constructor(private readonly opts: Titanfall2WorldOptions) {
    this.cfg = opts.cfg;
  }

  /* ---------- lifecycle ---------- */

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.log = host.log;
    this.stopped = false;
    const log = host.log;
    this.player = new Player({ device: () => this.cfg.voice.outputDevice, volume: () => this.cfg.voice.volume, log });
    this.voice = new Voice({
      cfg: () => this.cfg.voice,
      gameDir: () => this.gameDir(),
      sampleFile: join(this.opts.dataDir, 'titanfall2-bt-sample.wav'),
      runtimesRoot: this.opts.runtimesRoot,
      modelsRoot: this.opts.modelsRoot,
      log,
      onPhase: (phase, detail) => this.onVoicePhase(phase, detail),
    });
    this.speech = new Speech({
      cfg: () => this.cfg,
      voice: this.voice,
      voiceReady: () => this.cfg.voice.enabled && this.voice?.phase === 'ready',
      player: this.player,
      sink: {
        show: (lines, sec) => this.call<void>({ op: 'subtitle', timeoutMs: SUBTITLE_TIMEOUT_MS, sub: this.subtitleOf(lines, sec) }, SUBTITLE_TIMEOUT_MS + 1000),
        hide: () => this.call<void>({ op: 'hide-subtitle' }),
      },
      log,
    });
    try {
      await this.call<number>({ op: 'listen', port: this.cfg.port });
      this.sidecarError = null;
    } catch (err) {
      this.sidecarError = `sidecar 没能在 127.0.0.1:${this.cfg.port} 监听:${err instanceof Error ? err.message : String(err)}`;
      log.warn(this.sidecarError);
    }
    await this.detectGameDir();
    const dir = this.gameDir();
    if (dir) {
      try {
        const before = checkGame(dir);
        if (before.northstar && (!before.modCurrent || !before.localHttp || !before.dialogueHook)) {
          installMod(dir);
          log.info('模组已装进游戏', { dir });
        }
      } catch (err) {
        log.warn('安装模组失败', { err: String(err) });
      }
    }
    this.play = new Play({
      gameDir: async () => this.gameDir() ?? (await this.detectGameDir()),
      workDir: this.opts.dataDir,
      launchArgs: () => this.cfg.launchArgs,
      port: () => this.cfg.port,
      startVoice: () => this.startVoice(),
      focus: () => this.call<boolean>({ op: 'focus' }).catch(() => false),
      linked: () => this.link.server,
      log,
    });
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = null;
    this.play?.stop();
    await this.speech?.hush().catch(() => undefined);
    this.voice?.stop();
    this.player?.close();
    const child = this.engine;
    this.engine = null;
    if (child) {
      child.send({ id: this.nextId++, req: { op: 'close' } });
      setTimeout(() => child.kill(), 500).unref();
    }
    this.host = null;
  }

  /* ---------- engine ---------- */

  private spawn(): ChildProcess {
    const child = fork(ENGINE_FILE, [], { execArgv: childExecArgv(), serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const log = this.log?.child('engine');
    const forward = (d: Buffer): void => {
      for (const line of d.toString().split(/\r?\n/)) if (line.trim()) log?.warn(line);
    };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);
    child.on('message', (msg: ChildToMain) => {
      if ('notice' in msg) {
        this.onNotice(msg.notice);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.done(msg.value);
      else p.fail(new Error(msg.error));
    });
    child.on('exit', (code) => {
      if (this.engine === child) this.engine = null;
      for (const [id, p] of this.pending) {
        p.fail(new Error(`engine child exited (${code})`));
        this.pending.delete(id);
      }
      if (!this.stopped) {
        this.sidecarError = `sidecar 进程退出(退出码 ${code})`;
        this.onLink('server', false);
        this.onLink('client', false);
      }
    });
    return child;
  }

  private call<T>(req: EngineRequest, timeoutMs = 10_000): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('World stopped'));
    if (!this.engine) this.engine = this.spawn();
    const child = this.engine;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('sidecar did not answer'));
      }, timeoutMs);
      this.pending.set(id, {
        done: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        fail: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.send({ id, req });
    });
  }

  private onNotice(n: EngineNotice): void {
    switch (n.notice) {
      case 'frame':
        return this.onFrame(n.frame);
      case 'events':
        for (const e of n.events) this.onGameEvent(e);
        return;
      case 'client':
        return this.onClient(n.post);
      case 'link':
        return this.onLink(n.side, n.up);
      case 'log':
        this.log?.[n.level](n.text);
        return;
    }
  }

  /* ---------- game state ---------- */

  private onLink(side: 'server' | 'client', up: boolean): void {
    if (this.link[side] === up) return;
    this.link[side] = up;
    if (side !== 'server') return;
    if (up) {
      this.linkDownAt = null;
      // frames from before the gap may belong to another level; the next post brings a fresh one
      this.frame = null;
      if (!this.everUp || this.linkDownReported) {
        this.everUp = true;
        this.linkDownReported = false;
        this.emit('titanfall2.state', '游戏连上了。', 'flush');
        this.host?.log.info('游戏已连上');
      }
      this.play?.onLinked();
      this.startVoice();
    } else {
      this.linkDownAt = Date.now();
    }
  }

  private readonly modErrorsLogged = new Set<string>();

  private onFrame(frame: Frame): void {
    const prev = this.frame;
    for (const err of frame.errors ?? []) {
      if (this.modErrorsLogged.has(err) || this.modErrorsLogged.size > 50) continue;
      this.modErrorsLogged.add(err);
      this.log?.warn('模组脚本出错', { err });
    }
    if (frame.map !== this.map) {
      const first = this.map === '';
      this.map = frame.map;
      this.labels.reset();
      this.seenBig.clear();
      this.helmetsAnnounced.clear();
      this.frameDue = true;
      this.inCombat = false;
      this.baseline = null;
      if (!first || this.everUp) this.emit('titanfall2.state', `进入关卡 ${mapName(frame.map)}。`, 'flush');
    }
    this.frame = frame;
    const tokens = frameTokens(frame).filter((t) => !this.localized.has(t) && !this.asked.has(t));
    if (tokens.length) {
      for (const t of tokens) this.asked.add(t);
      void this.call({ op: 'localize', tokens }).catch(() => undefined);
    }
    if (prev && prev.map === frame.map) {
      if (frame.section !== undefined && prev.section !== undefined && frame.section > prev.section) {
        this.frameDue = true;
        this.emit('titanfall2.story', `剧情推进到这一关的第 ${frame.section + 1} 段。`, 'piggyback');
      }
      this.edgeAlerts(prev, frame);
    }
  }

  private onClient(post: ClientPost): void {
    for (const [k, v] of Object.entries(post.localized ?? {})) {
      this.localized.set(k, v);
      this.asked.delete(k);
    }
    const raw = (post.objective ?? '').trim();
    const objective = (raw && this.cfg.story.simplified ? toSimplified(raw) : raw).replace(/[。.]+$/, '');
    if (objective !== this.objective) {
      const had = this.objective;
      this.objective = objective;
      if (objective && this.frame) {
        this.frameDue = true;
        this.emit('titanfall2.objective', `新目标:「${objective}」${had ? `,上一个目标是「${had}」` : ''}。${this.objectiveWhere()}`, 'debounce');
      }
    }
    if (post.dialogue?.length && this.cfg.story.enabled) this.onDialogue(post.dialogue.map((d) => d.alias));
  }

  /* ---------- story ---------- */

  private captionTable(): Captions | null {
    const dir = this.gameDir();
    const key = `${dir}|${this.cfg.story.language}`;
    if (this.captionsKey !== key) {
      this.captionsKey = key;
      this.captions = null;
      if (dir) {
        try {
          this.captions = Captions.load(dir, this.cfg.story.language);
        } catch (err) {
          this.log?.warn('读不到游戏字幕表', { err: String(err) });
        }
      }
    }
    return this.captions;
  }

  /** Queues the lines' captions and arms one deferred story event for them. */
  private onDialogue(aliases: string[]): void {
    const table = this.captionTable();
    const now = Date.now();
    for (const alias of aliases) {
      // the game replays some lines back to back; one copy is enough
      if (this.lastLine?.alias === alias && now - this.lastLine.at < LINE_REPEAT_MS) continue;
      this.lastLine = { alias, at: now };
      const cap = table?.get(alias);
      if (!cap || !cap.text) continue;
      const conv = (t: string): string => (this.cfg.story.simplified ? toSimplified(t) : t);
      this.storyLines.push(cap.speaker ? `${conv(cap.speaker)}:${conv(cap.text)}` : conv(cap.text));
    }
    if (this.storyLines.length > STORY_LINE_MAX) this.storyLines.splice(0, this.storyLines.length - STORY_LINE_MAX);
    if (!this.storyLines.length || this.storyArmed || !this.host) return;
    this.storyArmed = true;
    this.host.pushDeferred({ type: 'titanfall2.story', senderKey: this.id, render: () => this.renderStory() }, { trigger: 'debounce' });
  }

  private async renderStory(): Promise<string | { text: string; blobs: Array<{ bytes: Uint8Array; mime: string; name: string; fallbackText: string }> } | null> {
    this.storyArmed = false;
    const lines = this.storyLines.splice(0);
    if (!lines.length) return null;
    const text = `[泰坦陨落2 剧情] ${lines.join('\n')}`;
    const due = this.frameDue || (this.cfg.story.frameSec > 0 && Date.now() - this.lastFrameAt >= this.cfg.story.frameSec * 1000);
    if (!due || this.cfg.story.frameSec <= 0 || !this.acceptsImages()) return text;
    const shot = await this.capture(this.cfg.story.frameMaxPx).catch(() => null);
    if (!shot) return text;
    this.frameDue = false;
    this.lastFrameAt = Date.now();
    return { text, blobs: [{ bytes: shot.jpeg, mime: IMAGE_MIME, name: 'titanfall2-story.jpg', fallbackText: `游戏画面 ${shot.width}×${shot.height}` }] };
  }

  private acceptsImages(): boolean {
    try {
      return this.host?.modelFacts.accepts(IMAGE_MIME) ?? false;
    } catch {
      return false;
    }
  }

  private capture(maxWidth: number): Promise<CaptureResult> {
    return this.call<CaptureResult>({ op: 'capture', maxWidth, quality: JPEG_QUALITY }, 5000);
  }

  private objectiveWhere(): string {
    const f = this.frame;
    if (!f?.objective?.pos || !f.player) return '';
    return `目标点在铁驭 ${whereText(relative(f.player.pos, f.player.yaw, f.objective.pos))}。`;
  }

  private alertDue(kind: string): boolean {
    const now = Date.now();
    const last = this.lastAlertAt.get(kind) ?? 0;
    if (now - last < this.cfg.intel.alertCooldownSec * 1000) return false;
    this.lastAlertAt.set(kind, now);
    return true;
  }

  private seen(frame: Frame): SeenEnemy[] {
    return seenEnemies(frame, this.labels, this.lookup, Date.now());
  }

  /** Alerts for changes between two frames of the same level. Facts only; no advice. */
  private edgeAlerts(prev: Frame, cur: Frame): void {
    const p = cur.player;
    const list = this.seen(cur);
    // titans and reapers that showed up in this frame go out as one alert; only a boss or a titan
    // within BIG_NEAR_M preempts, a far-off battle waits for the next batch
    const fresh = list.filter((s) => (s.e.cls === 'npc_titan' || s.e.cls === 'npc_super_spectre') && !this.seenBig.has(s.e.id));
    if (fresh.length) {
      for (const s of fresh) this.seenBig.add(s.e.id);
      const what = (s: SeenEnemy): string => (s.e.boss ? `Boss 泰坦 ${s.name}` : s.e.cls === 'npc_titan' ? `敌方泰坦 ${s.name}` : '死神');
      const urgent = fresh.some((s) => s.e.boss || (s.e.cls === 'npc_titan' && s.rel.meters <= BIG_NEAR_M));
      const text = fresh.length === 1
        ? `${what(fresh[0])}出现:${enemyText(fresh[0])}。`
        : `出现 ${fresh.length} 个大型敌人(${countText(fresh)}):\n${fresh.slice(0, 6).map((s) => `- ${enemyText(s)}`).join('\n')}`;
      this.emit('titanfall2.alert', text, urgent ? 'flush' : 'debounce');
    }

    if (p && prev.player && p.alive && !p.titan) {
      const low = this.cfg.intel.lowHealthPct;
      const was = pct(prev.player.hp, prev.player.hpMax);
      const now = pct(p.hp, p.hpMax);
      if (now < low && was >= low && this.alertDue('pilot-low')) this.emit('titanfall2.alert', `铁驭生命只剩 ${now}%。${this.attackersText(list, 'pilot')}`, 'flush');
    }

    const bt = cur.bt;
    const pb = prev.bt;
    if (bt && pb && bt.alive) {
      if (bt.rodeo && !pb.rodeo) this.emit('titanfall2.alert', '有敌方铁驭骑上了 BT。', 'flush');
      if ((pb.shield ?? 0) > 0 && (bt.shield ?? 0) <= 0 && bt.shieldMax && this.alertDue('bt-shield')) this.emit('titanfall2.alert', `BT 护盾被打穿，生命 ${pct(bt.hp, bt.hpMax)}%。${this.attackersText(list, 'bt')}`, 'debounce');
      const was = pct(pb.hp, pb.hpMax);
      const now = pct(bt.hp, bt.hpMax);
      for (const line of [50, 25]) {
        if (now < line && was >= line) this.emit('titanfall2.alert', `BT 生命降到 ${now}%。`, line === 25 ? 'flush' : 'debounce');
      }
      const coreReady = (f: typeof bt): boolean => f.coreValue !== undefined && (f.coreFromDamage ? f.coreValue >= 1 : f.coreValue - cur.time <= 0);
      if (coreReady(bt) && !coreReady(pb)) this.emit('titanfall2.combat', 'BT 的核心能力充能完毕。', 'debounce');
    }

    const near = this.cfg.guide.helmetNearM;
    if (p && near > 0) {
      for (const poi of cur.pois ?? []) {
        if (poi.kind !== 'helmet') continue;
        const key = String(poi.id);
        if (this.helmetsAnnounced.has(key)) continue;
        const r = relative(p.pos, p.yaw, poi.pos);
        if (r.meters > near) continue;
        this.helmetsAnnounced.add(key);
        this.emit('titanfall2.guide', `附近有一个还没拿到的铁驭头盔收集品：在铁驭 ${whereText(r)}。`, 'piggyback');
      }
    }

    if (p && bt && bt.alive && !bt.doomed && pct(bt.hp, bt.hpMax) < 50) {
      const nearest = (cur.pois ?? [])
        .filter((x) => x.kind === 'battery')
        .map((x) => ({ x, r: relative(p.pos, p.yaw, x.pos) }))
        .sort((a, b) => a.r.meters - b.r.meters)[0];
      if (nearest && nearest.r.meters <= BATTERY_NEAR_M && this.alertDue('battery')) {
        this.emit('titanfall2.guide', `BT 生命 ${pct(bt.hp, bt.hpMax)}%,附近地上有泰坦电池：在铁驭 ${whereText(nearest.r)}。`, 'debounce');
      }
    }

    const gun = p?.weapons.find((w) => w.name === p.active);
    const prevGun = prev.player?.weapons.find((w) => w.name === gun?.name);
    if (p && !p.titan && gun && prevGun && gun.clipMax > 0) {
      const left = (w: typeof gun): number => w.clip + Math.max(0, w.stock);
      if (left(gun) <= gun.clipMax && left(prevGun) > gun.clipMax && this.alertDue('ammo')) {
        this.emit('titanfall2.alert', `铁驭手上的 ${weaponNameOf(gun, this.lookup)} 只剩 ${left(gun)} 发(弹匣 ${gun.clip},备弹 ${Math.max(0, gun.stock)})。`, 'debounce');
      }
    }

    const engaging = list.filter((s) => s.e.target);
    const now = Date.now();
    if (engaging.length && !this.inCombat) {
      this.inCombat = true;
      this.quietSince = null;
      if (this.alertDue('combat')) this.emit('titanfall2.alert', `交火开始:${engaging.length} 个敌人在攻击。\n${engaging.slice(0, 5).map((s) => `- ${enemyText(s)}`).join('\n')}`, 'debounce');
    } else if (this.inCombat) {
      const near = list.some((s) => s.e.target || s.rel.meters < COMBAT_NEAR_M);
      if (near) this.quietSince = null;
      else if (this.quietSince === null) this.quietSince = now;
      else if (now - this.quietSince >= COMBAT_END_MS) {
        this.inCombat = false;
        this.quietSince = null;
        this.emit('titanfall2.combat', `附近 ${COMBAT_NEAR_M} 米内没有敌人了，也没有敌人在攻击。`, 'piggyback');
      }
    }
  }

  private attackersText(list: SeenEnemy[], who: 'pilot' | 'bt'): string {
    const hitting = list.filter((s) => s.e.target === who);
    if (!hitting.length) return '';
    return `正在攻击${who === 'pilot' ? '铁驭' : ' BT '}的:${hitting.slice(0, 4).map((s) => `${s.label} ${s.name} ${whereText(s.rel)}`).join(';')}。`;
  }

  private onGameEvent(e: GameEvent): void {
    const who = (by: string): string => (by === 'pilot' ? '铁驭' : by === 'bt' ? 'BT' : by ? className(by) : '不明来源');
    switch (e.kind) {
      case 'level':
        return;
      case 'save_loaded':
        return this.emit('titanfall2.state', '读取了检查点存档。', 'debounce');
      case 'pilot_died':
        return this.emit('titanfall2.alert', `铁驭阵亡(${who(e.by)})。`, 'flush');
      case 'bt_doomed':
        return this.emit('titanfall2.alert', `BT 进入濒死状态(${who(e.by)})。`, 'flush');
      case 'titan_doomed': {
        const label = this.labels.label(e.id, Date.now());
        const p = this.frame?.player;
        const enemy = this.frame?.enemies?.find((x) => x.id === e.id);
        const rel = p && enemy ? relative(p.pos, p.yaw, enemy.pos) : null;
        const ours = e.by === 'pilot' || e.by === 'bt';
        const where = rel ? `,在铁驭 ${whereText(rel)}` : '';
        const trigger: TriggerMode = ours || e.boss || (rel && rel.meters <= DOOMED_NEAR_M) ? 'debounce' : 'piggyback';
        return this.emit('titanfall2.combat', `敌方${e.boss ? ` Boss ${e.boss}` : '泰坦'} ${label} 进入濒死状态(${who(e.by)})${where},靠近可以处决。`, trigger);
      }
      case 'embark':
        return this.emit('titanfall2.combat', '铁驭登上了 BT。', 'debounce');
      case 'disembark':
        return this.emit('titanfall2.combat', '铁驭离开了 BT。', 'debounce');
      case 'kill':
        this.kills.push({ cls: e.cls, by: e.by, weapon: e.weapon, boss: e.boss });
        this.killTimer ??= setTimeout(() => this.flushKills(), KILL_BATCH_MS);
        return;
    }
  }

  private flushKills(): void {
    this.killTimer = null;
    const kills = this.kills;
    this.kills = [];
    if (!kills.length) return;
    const groups = new Map<string, number>();
    for (const k of kills) {
      const name = k.boss ?? className(k.cls);
      // the game credits BT's kills to the pilot; titan weapons tell them apart
      const titanWeapon = /^mp_titan(weapon|core|ability)_/.test(k.weapon);
      const by = k.by === 'bt' || (k.by === 'pilot' && titanWeapon) ? 'BT' : k.by === 'pilot' ? '铁驭' : '其他';
      groups.set(`${name}(${by})`, (groups.get(`${name}(${by})`) ?? 0) + 1);
    }
    this.emit('titanfall2.combat', `击杀:${[...groups].map(([k, n]) => `${k}×${n}`).join('、')}。`, kills.some((k) => k.boss || (k.cls === 'npc_titan' && (k.by === 'pilot' || k.by === 'bt'))) ? 'debounce' : 'piggyback');
  }

  private tick(): void {
    const now = Date.now();
    this.labels.prune(now, LABEL_KEEP_MS);
    if (this.linkDownAt !== null && !this.linkDownReported && now - this.linkDownAt >= LINK_DOWN_REPORT_MS) {
      this.linkDownReported = true;
      void runningGame().then((pids) => {
        const running = pids.length > 0;
        this.emit('titanfall2.state', running ? '游戏停止上报了(暂停菜单、读图或过场)。' : '游戏关闭了。', running ? 'piggyback' : 'flush');
      });
    }
    if (this.link.server && !this.snapshotArmed && now - this.lastSnapshotAt >= this.cfg.intel.snapshotSec * 1000) this.armSnapshot();
  }

  /* ---------- snapshot ---------- */

  private armSnapshot(): void {
    if (!this.host) return;
    this.snapshotArmed = true;
    this.host.pushDeferred(
      { type: 'titanfall2.snapshot', senderKey: this.id, tags: ['snapshot'], render: () => this.renderSnapshot() },
      { trigger: 'piggyback' },
    );
  }

  private segments(frame: Frame): Segment[] {
    const list = this.seen(frame);
    const p = frame.player;
    const bt = frame.bt;
    const r = readiness(frame);
    const objPos = frame.objective?.pos && p ? relative(p.pos, p.yaw, frame.objective.pos) : null;
    const counts = list.map((s) => s.name).sort().join(',');
    return [
      { key: 'place', text: `关卡:${mapName(frame.map)}\n${objectiveLine(frame, this.objective)}`, cmp: `${frame.map}|${this.objective}|${objPos ? `${objPos.clock}:${bucket(objPos.meters, 25)}` : ''}` },
      { key: 'pilot', text: pilotLine(frame, this.lookup), cmp: p ? `${p.alive}|${p.titan}|${bucket(pct(p.hp, p.hpMax), 20)}|${p.active}` : '' },
      {
        key: 'bt',
        text: btLine(frame),
        cmp: bt ? `${bt.alive}|${bt.embarked}|${bt.doomed}|${bt.rodeo}|${bucket(pct(bt.hp, bt.hpMax), 10)}|${bucket(pct(bt.shield ?? 0, bt.shieldMax ?? 1), 25)}|${(r.missiles ?? 0) > 0}` : '',
      },
      { key: 'enemies', text: enemiesBlock(list, this.cfg.intel.maxListed), cmp: `${counts}|${list.filter((s) => s.e.target).length}|${list.slice(0, 3).map((s) => s.label).join(',')}` },
    ];
  }

  /** Rendered at delivery from the newest frame; null when nothing changed since the last one. */
  private renderSnapshot(): string | null {
    this.snapshotArmed = false;
    const frame = this.frame;
    if (!frame || !this.link.server) return null;
    const now = Date.now();
    this.lastSnapshotAt = now;
    const segs = this.segments(frame);
    const anchor = this.baseline === null || now - this.lastAnchorAt >= SNAPSHOT_ANCHOR_MS;
    const dirty = anchor ? segs : segs.filter((s) => this.baseline!.get(s.key) !== s.cmp);
    this.baseline = new Map(segs.map((s) => [s.key, s.cmp]));
    if (!dirty.length) return null;
    if (anchor) this.lastAnchorAt = now;
    return `[泰坦陨落2${anchor ? '' : ' 变化'}] ${dirty.map((s) => s.text).join('\n')}`;
  }

  /* ---------- tools ---------- */

  tools(): ToolDef[] {
    const handlers: Record<string, (a: Args) => Promise<string | ToolOutcome>> = {
      titanfall2_scan: (a) => this.toolScan(a),
      titanfall2_say: (a) => this.toolSay(a),
      titanfall2_missiles: (a) => this.toolMissiles(a),
      titanfall2_smoke: () => this.toolSupport('smoke'),
      titanfall2_pulse: () => this.toolSupport('pulse'),
      titanfall2_look: () => this.toolLook(),
      titanfall2_guide: () => this.toolGuide(),
      titanfall2_mark: (a) => this.toolMark(a),
      titanfall2_focus: (a) => this.toolFocus(a),
      titanfall2_launch: () => this.toolLaunch(),
    };
    return TITANFALL2_TOOL_DECLS.map((d) => ({ ...d, handler: (args) => handlers[d.name](args) }));
  }

  private requireFrame(): Frame {
    if (this.sidecarError) throw new Error(this.sidecarError);
    if (!this.link.server || !this.frame) throw new Error('游戏没有连上：没开、还在主菜单，或在暂停、读图。');
    return this.frame;
  }

  private readinessLine(frame: Frame): string {
    const r = readiness(frame);
    const sec = (s: number): string => (s > 0 ? `还要 ${s} 秒` : '就绪');
    const missiles = r.missiles === null ? '没有飞弹系统' : r.missiles > 0 ? `可发 ${r.missiles} 枚` : r.missilesSec > 0 ? `冷却还要 ${r.missilesSec} 秒` : '充能中';
    return `支援:飞弹 ${missiles};电烟幕 ${sec(r.smokeSec)};声纳 ${sec(r.pulseSec)}`;
  }

  private async toolLaunch(): Promise<string> {
    const s = await this.play!.run();
    if (s.step === 'error') throw new Error(s.detail);
    if (s.step === 'playing') return '游戏已经在关卡里，连上了。';
    return '游戏已打开并切到前台，停在主菜单。玩家选「继续」或「任务选择」进入战役后，会收到「游戏连上了」。';
  }

  private async toolScan(a: Args): Promise<string> {
    const frame = this.requireFrame();
    const only = typeof a.only === 'string' ? a.only : 'all';
    let list = this.seen(frame);
    const total = list.length;
    if (only === 'engaging') list = list.filter((s) => s.e.target);
    else if (only === 'visible') list = list.filter((s) => s.e.los);
    else if (only === 'titans') list = list.filter((s) => s.e.cls === 'npc_titan' || s.e.cls === 'npc_super_spectre');
    const head = [`关卡:${mapName(frame.map)}`, objectiveLine(frame, this.objective), pilotLine(frame, this.lookup), btLine(frame), this.readinessLine(frame)];
    const enemies = total === 0 ? '敌人:扫描范围内没有' : `敌人:范围内 ${total} 个${only !== 'all' ? `,其中符合「${only}」的 ${list.length} 个` : ''}\n${list.map((s) => `- ${enemyText(s)}`).join('\n')}`;
    const p = frame.player;
    const threats = p ? (frame.threats ?? []).map((t) => `${t.weapon || t.cls} 在铁驭 ${whereText(relative(p.pos, p.yaw, t.pos))}`) : [];
    return `${head.join('\n')}\n${enemies}${threats.length ? `\n飞来的弹药:${threats.join(';')}` : ''}`;
  }

  private async toolLook(): Promise<string | ToolOutcome> {
    const frame = this.requireFrame();
    const text = [`关卡:${mapName(frame.map)}`, objectiveLine(frame, this.objective)].join('\n');
    try {
      const shot = await this.capture(this.cfg.story.frameMaxPx);
      this.lastFrameAt = Date.now();
      return { text, blobs: [{ bytes: shot.jpeg, mime: IMAGE_MIME, name: 'titanfall2-look.jpg', fallbackText: `游戏画面 ${shot.width}×${shot.height}` }] };
    } catch (err) {
      return `${text}\n没有截到画面:${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private poiText(frame: Frame, poi: PoiFrame): string {
    const p = frame.player!;
    const where = whereText(relative(p.pos, p.yaw, poi.pos));
    if (poi.kind === 'helmet') return `铁驭头盔 ${where}`;
    if (poi.kind === 'battery') return `泰坦电池 ${where}`;
    return `BT 装备 ${LOADOUT_NAMES[poi.weapon ?? ''] ?? poi.weapon} ${where}`;
  }

  private async toolGuide(): Promise<string> {
    const frame = this.requireFrame();
    const p = frame.player;
    if (!p) throw new Error('还没有铁驭的读数');
    const dist = (x: PoiFrame): number => relative(p.pos, p.yaw, x.pos).meters;
    const pois = [...(frame.pois ?? [])].sort((a, b) => dist(a) - dist(b));
    const helmets = pois.filter((x) => x.kind === 'helmet');
    const loadouts = pois.filter((x) => x.kind === 'loadout');
    const batteries = pois.filter((x) => x.kind === 'battery');
    const lines = [`关卡:${mapName(frame.map)}`, objectiveLine(frame, this.objective)];
    if (frame.bt && !frame.bt.embarked) lines.push(`BT 在铁驭 ${whereText(relative(p.pos, p.yaw, frame.bt.pos))}`);
    lines.push(helmets.length ? `这一关还没拿到的铁驭头盔 ${helmets.length} 个:\n${helmets.map((x) => `- ${this.poiText(frame, x)}`).join('\n')}` : '这一关没有还没拿到的铁驭头盔。');
    if (loadouts.length) lines.push(`可拾取的 BT 装备:\n${loadouts.map((x) => `- ${this.poiText(frame, x)}`).join('\n')}`);
    if (batteries.length) lines.push(`地上的泰坦电池(给 BT 补生命):\n${batteries.slice(0, 5).map((x) => `- ${this.poiText(frame, x)}`).join('\n')}`);
    return lines.join('\n');
  }

  private targetIds(frame: Frame, raw: string[]): { ids: number[]; unknown: string[] } {
    const ids: number[] = [];
    const unknown: string[] = [];
    for (const label of raw) {
      const id = this.labels.idOf(label);
      if (id === null || !frame.enemies?.some((e) => e.id === id)) unknown.push(label);
      else ids.push(id);
    }
    return { ids, unknown };
  }

  private async toolMark(a: Args): Promise<string> {
    const frame = this.requireFrame();
    const raw = Array.isArray(a.targets) ? a.targets.map(String) : [];
    const { ids, unknown } = this.targetIds(frame, raw);
    if (!ids.length) throw new Error(`没有可用的目标:${unknown.join('、')} 不在当前扫描里。`);
    const ack = await this.command({ op: 'mark', targets: ids, durationSec: this.cfg.support.markSec, cooldownSec: this.cfg.support.markCooldownSec });
    if (!ack.ok) throw new Error(`没有标记:${FAIL_TEXT[ack.reason ?? 'unknown_op']}。`);
    const marked = raw.filter((l) => !unknown.includes(l));
    return `已把 ${marked.join('、')} 描边高亮 ${this.cfg.support.markSec} 秒，铁驭隔墙也看得见。${unknown.length ? `${unknown.join('、')} 不在当前扫描里。` : ''}`;
  }

  private async toolFocus(a: Args): Promise<string> {
    const frame = this.requireFrame();
    const label = typeof a.target === 'string' ? a.target : '';
    const { ids } = this.targetIds(frame, [label]);
    if (!ids.length) throw new Error(`${label} 不在当前扫描里。`);
    const ack = await this.command({ op: 'focus', targets: ids });
    if (!ack.ok) throw new Error(`BT 没有改换目标:${FAIL_TEXT[ack.reason ?? 'unknown_op']}。`);
    return `BT 把 ${label} 当作攻击目标了。`;
  }

  private async toolSay(a: Args): Promise<string> {
    const text = typeof a.text === 'string' ? a.text.trim() : '';
    if (!text) throw new Error('text 不能为空');
    if (!this.link.client) throw new Error('游戏没有连上，字幕和声音都没有出。');
    if (a.interrupt === true) await this.speech!.hush();
    const r = await this.speech!.say(text);
    if (!r.shown && r.voiced) return 'BT 的声音已经播出，这句已经说出口;字幕没上屏，游戏这时没在接收字幕(暂停、读图或过场)。';
    if (!r.shown) throw new Error(r.problem ?? '字幕没有显示');
    const voice = r.voiced ? 'BT 的声音已经开始播放' : this.cfg.voice.enabled ? `只出了字幕(${r.problem ?? this.voiceText()})` : '只出了字幕(语音已关闭)';
    return `字幕已上屏，${voice}。`;
  }

  private voiceText(): string {
    const v = this.voice;
    if (!v) return '语音没有启动';
    if (v.phase === 'starting') return '语音服务还在启动';
    if (v.phase === 'error') return `语音不可用:${v.detail ?? ''}`;
    if (v.phase === 'off') return '语音没有启动';
    return '语音就绪';
  }

  private async command(cmd: Omit<ServerCommand, 'id'>): Promise<CommandAck> {
    try {
      return await this.call<CommandAck>({ op: 'command', cmd, timeoutMs: COMMAND_TIMEOUT_MS }, COMMAND_TIMEOUT_MS + 1000);
    } catch (err) {
      throw new Error(`游戏没有执行(${err instanceof Error ? err.message : String(err)}),可能在暂停或读图。`);
    }
  }

  private async toolMissiles(a: Args): Promise<string> {
    const frame = this.requireFrame();
    const raw = Array.isArray(a.targets) ? a.targets.map(String) : [];
    const ids: number[] = [];
    const unknown: string[] = [];
    for (const label of raw) {
      const id = this.labels.idOf(label);
      if (id === null || !frame.enemies?.some((e) => e.id === id)) unknown.push(label);
      else ids.push(id);
    }
    if (!ids.length) throw new Error(`没有可用的目标:${unknown.join('、')} 不在当前扫描里。先看快照或 titanfall2_scan 拿编号。`);
    const before = readiness(frame);
    const count = typeof a.count === 'number' ? Math.round(a.count) : this.cfg.support.missileCount;
    const ack = await this.command({ op: 'missiles', targets: ids, count, cooldownSec: this.cfg.support.autoMissileCooldownSec });
    if (!ack.ok) {
      const extra = ack.reason === 'cooldown' ? `,还要 ${before.missilesSec} 秒` : ack.reason === 'charging' && ack.charge !== undefined ? `,现在 ${Math.round((1 - ack.charge) * 100)}%` : '';
      throw new Error(`飞弹没有发射:${FAIL_TEXT[ack.reason ?? 'unknown_op']}${extra}。`);
    }
    const targets = ids.map((id) => raw.find((l) => this.labels.idOf(l) === id)!).slice(0, ack.fired ?? ids.length);
    const left = frame.bt?.embarked
      ? `飞弹系统还剩 ${Math.max(0, (before.missiles ?? 0) - (ack.fired ?? 0))} 枚，自动回充`
      : `BT 单独作战，飞弹冷却 ${this.cfg.support.autoMissileCooldownSec} 秒`;
    return `发射了 ${ack.fired} 枚多目标飞弹，轮流打向 ${targets.join('、')}。${left}。${unknown.length ? `${unknown.join('、')} 不在当前扫描里，没有算进去。` : ''}`;
  }

  private async toolSupport(op: 'smoke' | 'pulse'): Promise<string> {
    const frame = this.requireFrame();
    const cooldownSec = op === 'smoke' ? this.cfg.support.smokeCooldownSec : this.cfg.support.pulseCooldownSec;
    const ack = await this.command({ op, cooldownSec });
    const name = op === 'smoke' ? '电烟幕' : '声纳脉冲';
    if (!ack.ok) {
      const r = readiness(frame);
      const extra = ack.reason === 'cooldown' ? `,还要 ${op === 'smoke' ? r.smokeSec : r.pulseSec} 秒` : '';
      throw new Error(`${name}没有放出:${FAIL_TEXT[ack.reason ?? 'unknown_op']}${extra}。`);
    }
    if (op === 'smoke') return `BT 在${frame.bt?.embarked ? '自己(铁驭在驾驶)' : '自己'}周围放出了电烟幕，冷却 ${cooldownSec} 秒。`;
    const p = frame.player!;
    const hit = this.seen(frame).filter((s) => Math.hypot(s.e.pos[0] - p.pos[0], s.e.pos[1] - p.pos[1], s.e.pos[2] - p.pos[2]) <= PULSE_RADIUS_UNITS);
    const radius = Math.round(meters(PULSE_RADIUS_UNITS));
    return `声纳脉冲已放出(半径约 ${radius} 米),冷却 ${cooldownSec} 秒。${hit.length ? `照到 ${hit.length} 个敌人:\n${hit.map((s) => `- ${enemyText(s)}`).join('\n')}` : '范围内没有敌人。'}`;
  }

  /* ---------- voice ---------- */

  /** The page as the client draws it: traditional characters when set, and a box sized to the longest line. */
  private subtitleOf(lines: string[], sec: number): SubtitleCommand {
    const s = this.cfg.subtitle;
    const shown = s.traditional ? lines.map((l) => toTraditional(l)) : lines;
    const sub: SubtitleCommand = { lines: shown, sec, pos: [s.posX, s.posY], size: s.size, alpha: 0.95, color: [1, 1, 1] };
    if (s.boxAlpha > 0) sub.box = { width: Math.max(...shown.map((l) => textWidth(l))) * CHAR_UNIT, lineHeight: LINE_UNIT, padX: 0.6, padY: 0.35, alpha: s.boxAlpha };
    return sub;
  }

  /** Starts BT's voice in the background when it is on and not already up or starting. */
  private startVoice(): void {
    const v = this.voice;
    if (!this.cfg.voice.enabled || !v || v.phase === 'ready' || v.phase === 'starting') return;
    void v.start().catch(() => undefined);
  }

  private onVoicePhase(phase: VoicePhase, detail: string | null): void {
    if (phase === 'error') this.log?.warn('BT 语音不可用', { detail });
  }

  /* ---------- game ---------- */

  private gameDir(): string | null {
    const configured = this.cfg.gameDir.trim().replace(/^"|"$/g, '');
    if (configured) return existsSync(configured) ? configured : null;
    return this.detectedDir;
  }

  private async detectGameDir(): Promise<string | null> {
    this.detectedDir = (await findGameDirs())[0] ?? null;
    return this.detectedDir;
  }

  /**
   * The last result of a lookup, refreshed in the background once older than `maxAgeMs`; only the first
   * call waits. The panel polls every second and tasklist takes seconds while the game loads a level.
   */
  private async cached<T>(key: string, maxAgeMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.lookups.get(key);
    if (!hit) {
      const value = await fn();
      this.lookups.set(key, { at: Date.now(), value, pending: false });
      return value;
    }
    if (!hit.pending && Date.now() - hit.at >= maxAgeMs) {
      hit.pending = true;
      void fn()
        .then((value) => Object.assign(hit, { at: Date.now(), value }))
        .finally(() => {
          hit.pending = false;
        });
    }
    return hit.value as T;
  }

  private emit(type: string, text: string, trigger: TriggerMode, tags?: readonly EventTag[]): void {
    if (!this.host) return;
    this.host
      .pushEvent({ ts: nowIso(this.opts.timezone), source: this.id, type, text: `[泰坦陨落2] ${text}`, senderKey: this.id, tags }, { trigger })
      .catch((e: unknown) => this.host?.log.warn('事件投递失败', { type, err: String(e) }));
  }

  private stateLine(): string {
    if (this.sidecarError) return `连接不可用(${this.sidecarError})`;
    if (!this.link.server) return '游戏没有连上(没开、在主菜单，或在暂停、读图)';
    return `游戏已连上，在 ${mapName(this.map)}`;
  }

  envPromptVars(): Record<string, string> {
    return { 'titanfall2.state': this.stateLine() };
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const en = language === 'en';
    const v = this.voice;
    const voiceLamp = !this.cfg.voice.enabled ? 'offline' : v?.phase === 'ready' ? 'online' : v?.phase === 'starting' ? 'loading' : v?.phase === 'error' ? 'error' : 'offline';
    return {
      label: en ? 'Titanfall 2 Assistant' : '泰坦陨落 2 陪玩',
      lamps: [
        { label: en ? 'Game' : '游戏', state: this.sidecarError ? 'error' : this.link.server ? 'online' : 'offline', hint: this.stateLine() },
        { label: en ? 'Subtitles' : '字幕', state: this.link.client ? 'online' : 'offline' },
        { label: en ? 'BT voice' : 'BT 语音', state: voiceLamp, hint: this.voiceText() },
      ],
      badges: this.map ? [{ label: en ? 'Level' : '关卡', value: mapName(this.map), tone: this.link.server ? 'on' : 'plain' }] : [],
      panels: [{ id: 'start', title: en ? 'Quick start' : '快速启动', description: en ? 'Start everything with one button; game folder, mod and BT\'s voice.' : '一键开始;游戏目录、模组和 BT 语音。' }],
      invoke: (panel, method, args) => this.invoke(panel, method, args),
      config: titanfall2ConfigGroups(language),
      promptDocs: [
        {
          key: `worlds.${TITANFALL2_ID}.envPrompt`,
          title: en ? 'Titanfall 2 environment' : '泰坦陨落 2 环境',
          description: en ? 'How the bot rides along as BT.' : '怎么以 BT 的身份陪玩。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [{ name: 'titanfall2.state', description: en ? 'Whether the game is connected, and the level' : '游戏连没连上、在哪一关' }],
        },
      ],
    };
  }

  private async gameState(): Promise<Record<string, unknown>> {
    const dir = this.gameDir();
    let check: GameCheck | null = null;
    try {
      check = dir ? checkGame(dir) : null;
    } catch {
      check = null;
    }
    return {
      gameDir: this.cfg.gameDir,
      resolvedDir: dir,
      check,
      running: await this.cached('running', 2000, runningGame),
      link: this.link,
      line: this.stateLine(),
      sidecarError: this.sidecarError,
      play: this.play?.state ?? null,
      northstarVersion: NORTHSTAR_VERSION,
      eaApp: (await this.cached('ea', 30_000, eaAppPath)) !== null,
      voice: {
        enabled: this.cfg.voice.enabled,
        phase: this.voice?.phase ?? 'off',
        detail: this.voice?.detail ?? null,
        assets: voiceAssets(this.cfg.voice, this.opts.runtimesRoot, this.opts.modelsRoot),
        download: this.voiceDownload,
      },
      map: this.map ? mapName(this.map) : null,
      objective: this.objective || null,
    };
  }

  /** Downloads the missing voice runtime and weights in the background, then starts the voice. */
  private downloadVoice(): void {
    if (this.voiceDownload.running) return;
    this.voiceDownload = { progress: null, error: null, running: true };
    void downloadVoiceAssets(this.cfg.voice, this.opts.runtimesRoot, this.opts.modelsRoot, (p) => {
      this.voiceDownload.progress = p;
    })
      .then(() => {
        this.voiceDownload = { progress: null, error: null, running: false };
        this.log?.info('BT 语音组件已下载');
        this.startVoice();
      })
      .catch((err: unknown) => {
        this.voiceDownload = { progress: null, error: err instanceof Error ? err.message : String(err), running: false };
        this.log?.warn('BT 语音组件下载失败', { err: this.voiceDownload.error });
      });
  }

  private async invoke(panel: string, method: string, args: unknown[] = []): Promise<unknown> {
    if (panel !== 'start') throw new Error(`unknown panel ${panel}`);
    switch (method) {
      case 'state':
        return this.gameState();
      case 'detect':
        return findGameDirs();
      case 'install-mod': {
        const dir = this.gameDir();
        if (!dir) throw new Error('没找到游戏目录');
        return installMod(dir);
      }
      case 'play':
        return this.play?.run();
      case 'voice-start':
        await this.voice?.start();
        return { phase: this.voice?.phase };
      case 'download-voice':
        this.downloadVoice();
        return null;
      case 'refresh-sample':
        return this.voice?.refreshSample();
      case 'test-voice': {
        const text = String(args[0] ?? '铁驭，神经连接已建立。我会全程协助你。');
        if (!this.link.client) {
          const pcm = await this.voice!.synth(text);
          await this.player!.write(pcm.sampleRate, pcm.pcm);
          this.player!.flush();
          return { voiced: true, shown: false };
        }
        return this.speech!.say(text);
      }
    }
    throw new Error(`unknown method ${panel}/${method}`);
  }
}
