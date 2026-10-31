/**
 * Titanfall2World: the bot rides along in BT through the Titanfall 2 campaign.
 *
 * The Northstar mod (mod/) posts the game state to the engine child (sidecar.ts) four times a
 * second; this class turns those frames into events and tool receipts and sends BT's support
 * commands and subtitles back through the child. Game state reaches the context three ways:
 * edge alerts pushed when they happen, a snapshot rendered from the newest frame at delivery
 * (piggyback, only the parts that changed since the last one), and `titanfall2_scan` on demand.
 * BT's voice is VoxCPM2 cloned from a line cut out of the installed game (voice.ts).
 */
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childExecArgv } from 'cortico/extensions/runtime.ts';
import type { EventTag, Logger, ToolDef, ToolOutcome, TriggerMode, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { nowIso } from 'cortico/core/util.ts';
import { TITANFALL2_ID, titanfall2ConfigGroups, type Titanfall2ConfigSection } from './config.ts';
import type { ChildToMain, EngineNotice, EngineRequest, Frame } from './engine-ipc.ts';
import { checkGame, findGameDirs, installMod, launchGame, runningGame, type GameCheck } from './game.ts';
import {
  Labels, btLine, className, enemiesBlock, enemyText, frameTokens, mapName, meters, objectiveLine, pct, pilotLine, readiness, relative, seenEnemies, whereText,
  type Lookup, type SeenEnemy,
} from './intel.ts';
import { Player } from './player.ts';
import type { ClientPost, CommandAck, GameEvent, ServerCommand } from './protocol.ts';
import { Speech } from './speech.ts';
import { TITANFALL2_TOOL_DECLS } from './tools.ts';
import { Voice, type VoicePhase } from './voice.ts';

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
    text: (t) => (!t ? null : t.startsWith('#') ? this.localized.get(t) ?? null : t),
  };

  /* alert edges */
  private readonly lastAlertAt = new Map<string, number>();
  private readonly seenBig = new Set<number>();
  private kills: Array<{ cls: string; by: string; boss?: string }> = [];
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private inCombat = false;
  private quietSince: number | null = null;

  /* snapshot */
  private snapshotArmed = false;
  private lastSnapshotAt = 0;
  private lastAnchorAt = 0;
  private baseline: Map<string, string> | null = null;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private voice: Voice | null = null;
  private player: Player | null = null;
  private speech: Speech | null = null;
  private launchError: string | null = null;

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
    const dir = this.gameDir();
    if (dir) {
      try {
        const before = checkGame(dir);
        if (before.northstar && (!before.modCurrent || !before.localHttp)) {
          installMod(dir);
          log.info('模组已装进游戏', { dir });
        }
      } catch (err) {
        log.warn('安装模组失败', { err: String(err) });
      }
    }
    if (this.cfg.voice.enabled) void this.voice.start().catch(() => undefined);
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = null;
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
      if (!this.everUp || this.linkDownReported) {
        this.everUp = true;
        this.linkDownReported = false;
        this.emit('titanfall2.state', `游戏连上了。${this.frame ? `现在在 ${mapName(this.frame.map)}。` : ''}`, 'flush');
        this.host?.log.info('游戏已连上');
      }
    } else {
      this.linkDownAt = Date.now();
    }
  }

  private onFrame(frame: Frame): void {
    const prev = this.frame;
    if (frame.map !== this.map) {
      const first = this.map === '';
      this.map = frame.map;
      this.labels.reset();
      this.seenBig.clear();
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
    if (prev && prev.map === frame.map) this.edgeAlerts(prev, frame);
  }

  private onClient(post: ClientPost): void {
    for (const [k, v] of Object.entries(post.localized ?? {})) {
      this.localized.set(k, v);
      this.asked.delete(k);
    }
    const objective = (post.objective ?? '').trim();
    if (objective !== this.objective) {
      const had = this.objective;
      this.objective = objective;
      if (objective && this.frame) this.emit('titanfall2.objective', `新目标:${objective}${had ? `(上一个目标是「${had}」)` : ''}。${this.objectiveWhere()}`, 'debounce');
    }
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
    for (const s of list) {
      const big = s.e.cls === 'npc_titan' || s.e.cls === 'npc_super_spectre';
      if (!big || this.seenBig.has(s.e.id)) continue;
      this.seenBig.add(s.e.id);
      const what = s.e.boss ? `Boss 泰坦 ${s.name}` : s.e.cls === 'npc_titan' ? `敌方泰坦 ${s.name}` : `死神`;
      this.emit('titanfall2.alert', `${what}出现:${enemyText(s)}。`, s.e.cls === 'npc_titan' ? 'flush' : 'debounce');
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
        return this.emit('titanfall2.combat', `敌方${e.boss ? ` Boss ${e.boss}` : '泰坦'} ${label} 进入濒死状态(${who(e.by)}),可以处决。`, 'debounce');
      }
      case 'embark':
        return this.emit('titanfall2.combat', '铁驭登上了 BT。', 'debounce');
      case 'disembark':
        return this.emit('titanfall2.combat', '铁驭离开了 BT。', 'debounce');
      case 'kill':
        this.kills.push({ cls: e.cls, by: e.by, boss: e.boss });
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
      const by = k.by === 'pilot' ? '铁驭' : k.by === 'bt' ? 'BT' : '其他';
      groups.set(`${name}(${by})`, (groups.get(`${name}(${by})`) ?? 0) + 1);
    }
    this.emit('titanfall2.combat', `击杀:${[...groups].map(([k, n]) => `${k}×${n}`).join('、')}。`, kills.some((k) => k.boss || k.cls === 'npc_titan') ? 'debounce' : 'piggyback');
  }

  private tick(): void {
    const now = Date.now();
    this.labels.prune(now, LABEL_KEEP_MS);
    if (this.linkDownAt !== null && !this.linkDownReported && now - this.linkDownAt >= LINK_DOWN_REPORT_MS) {
      this.linkDownReported = true;
      const running = runningGame().length > 0;
      this.emit('titanfall2.state', running ? '游戏停止上报了(暂停菜单、读图或过场)。' : '游戏关闭了。', running ? 'piggyback' : 'flush');
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
    return `${head.join('\n')}\n${enemies}`;
  }

  private async toolSay(a: Args): Promise<string> {
    const text = typeof a.text === 'string' ? a.text.trim() : '';
    if (!text) throw new Error('text 不能为空');
    if (!this.link.client) throw new Error('游戏没有连上，字幕和声音都没有出。');
    if (a.interrupt === true) await this.speech!.hush();
    const r = await this.speech!.say(text);
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

  private subtitleOf(lines: string[], sec: number): { lines: string[]; sec: number; pos: [number, number]; size: number; alpha: number; color: [number, number, number] } {
    const s = this.cfg.subtitle;
    return { lines, sec, pos: [s.posX, s.posY], size: s.size, alpha: 0.95, color: [1, 1, 1] };
  }

  private onVoicePhase(phase: VoicePhase, detail: string | null): void {
    if (phase === 'error') this.log?.warn('BT 语音不可用', { detail });
  }

  /* ---------- game ---------- */

  private gameDir(): string | null {
    const configured = this.cfg.gameDir.trim().replace(/^"|"$/g, '');
    if (configured) return existsSync(configured) ? configured : null;
    return findGameDirs()[0] ?? null;
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
      panels: [{ id: 'start', title: en ? 'Quick start' : '快速启动', description: en ? 'Game folder, mod, launch, and BT\'s voice.' : '游戏目录、模组、启动游戏和 BT 语音。' }],
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

  private gameState(): Record<string, unknown> {
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
      running: runningGame(),
      link: this.link,
      line: this.stateLine(),
      sidecarError: this.sidecarError,
      launchError: this.launchError,
      voice: { enabled: this.cfg.voice.enabled, phase: this.voice?.phase ?? 'off', detail: this.voice?.detail ?? null },
      map: this.map ? mapName(this.map) : null,
      objective: this.objective || null,
    };
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
      case 'launch': {
        const dir = this.gameDir();
        if (!dir) throw new Error('没找到游戏目录');
        this.launchError = null;
        try {
          installMod(dir);
          return { pid: launchGame(dir, this.cfg.launchArgs, this.cfg.port) };
        } catch (err) {
          this.launchError = err instanceof Error ? err.message : String(err);
          throw err;
        }
      }
      case 'voice-start':
        await this.voice?.start();
        return { phase: this.voice?.phase };
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
