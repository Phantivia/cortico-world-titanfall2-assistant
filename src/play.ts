/**
 * Getting from "the World is on" to "the game is open in front", in two parts:
 * - prepare (一键准备): the game folder, Northstar, the mod, the display settings, and BT's voice files if missing;
 * - launch (启动游戏): the EA app, BT's voice, the game and its window. Launching needs Northstar in place; it
 *   brings the mod up to date itself.
 * The panel has a button for each; the launch tool runs both. One run at a time: a request while one runs joins it.
 *
 * The EA app gives no signal that its sign-in finished. When the World starts it, the game is launched
 * a fixed while after the app's LSX port opens (a fallback for that missing signal); a game that
 * still finds no signed-in account shows #ORIGIN_LOGGED_OUT and exits, which the run reports.
 */
import type { Logger } from 'cortico/core/types.ts';
import type { Progress } from './download.ts';
import { checkGame, eaAppPath, eaAppRunning, eaLsxListening, installMod, installNorthstar, launchGame, runningGame, startEaApp, vanillaGame } from './game.ts';

export type PlayStep = 'idle' | 'northstar' | 'mod' | 'prepared' | 'ea' | 'launch' | 'menu' | 'playing' | 'error';

export interface PlayState {
  step: PlayStep;
  /** What is happening or what to do next, for people. */
  detail: string;
  progress: Progress | null;
}

export interface PlayDeps {
  /** The configured game folder, else the one found in Steam. */
  gameDir: () => Promise<string | null>;
  /** Where downloads are kept while they unpack. */
  workDir: string;
  /** Arguments after `-allowlocalhttp`. */
  launchArgs: () => string[];
  /** Writes the configured display settings into the game's video config; returns what it did, for people. */
  applyDisplay: () => Promise<string>;
  port: () => number;
  /** Starts BT's voice without waiting for it. */
  startVoice: () => void;
  /** Starts downloading BT's voice files when the voice is on and some are missing; returns what it did, for people, or null. */
  downloadVoice: () => string | null;
  /** Restores and fronts the game window; false while it has none. */
  focus: () => Promise<boolean>;
  /** The mod in a level is posting to the sidecar. */
  linked: () => boolean;
  log: Logger;
}

const EA_PORT_WAIT_MS = 120_000;
const EA_SIGN_IN_WAIT_MS = 15_000;
const WINDOW_WAIT_MS = 90_000;
/** A game gone this soon after launch without reaching a level did not get past sign-in. */
const EARLY_EXIT_MS = 90_000;
const WATCH_MS = 2000;

export const MENU_HINT = '游戏已打开：在主菜单选「继续」或「任务选择」进入战役。';
/** Said when Titanfall2.exe runs without Northstar, where the mod never loads. */
export const VANILLA_TEXT = '从 Steam 启动的是原版，请用「启动游戏」:先关掉游戏，再点「启动游戏」。';
const NOT_PREPARED = '游戏里还没装 Northstar:先点「一键准备」。';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class Play {
  state: PlayState = { step: 'idle', detail: '', progress: null };
  private running: Promise<PlayState> | null = null;
  private watch: ReturnType<typeof setInterval> | null = null;
  private launchedAt = 0;

  constructor(private readonly deps: PlayDeps) {}

  /** 一键准备: resolves once Northstar, the mod and the display settings are in place (voice files may still be downloading). */
  prepare(): Promise<PlayState> {
    return this.once(async () => {
      await this.doPrepare();
      return this.state;
    });
  }

  /** 启动游戏: resolves once the game window is in front (or the run failed) with the state then. */
  launch(): Promise<PlayState> {
    return this.once(() => this.doLaunch());
  }

  /** Both, for the launch tool. */
  run(): Promise<PlayState> {
    return this.once(async () => {
      if (!(await runningGame()).length) await this.doPrepare();
      return this.doLaunch();
    });
  }

  private once(work: () => Promise<PlayState>): Promise<PlayState> {
    this.running ??= work()
      .catch((err: unknown) => this.set('error', err instanceof Error ? err.message : String(err)))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** The mod in a level started posting. */
  onLinked(): void {
    this.stop();
    this.set('playing', '游戏已连上。');
  }

  stop(): void {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
  }

  private set(step: PlayStep, detail: string, progress: Progress | null = null): PlayState {
    this.state = { step, detail, progress };
    return this.state;
  }

  private async gameFolder(): Promise<string> {
    const dir = await this.deps.gameDir();
    if (!dir) throw new Error('没找到泰坦陨落 2:Steam 里装的会自动找到，装在别处的在「游戏目录」里填写。');
    if (!checkGame(dir).game) throw new Error(`${dir} 里没有 Titanfall2.exe。`);
    return dir;
  }

  private async doPrepare(): Promise<void> {
    const d = this.deps;
    const dir = await this.gameFolder();
    if (!checkGame(dir).northstar) {
      this.set('northstar', '正在下载并安装 Northstar。');
      await installNorthstar(dir, d.workDir, (p) => this.set('northstar', '正在下载并安装 Northstar。', p));
      d.log.info('Northstar 已装进游戏', { dir });
    }
    this.set('mod', '正在安装模组。');
    installMod(dir);
    const display = await d.applyDisplay().catch((err: unknown) => `写显示设置失败:${err instanceof Error ? err.message : String(err)}`);
    const voice = d.downloadVoice();
    this.set('prepared', ['准备好了：Northstar 和模组已装好', `显示设置：${display}`, voice].filter(Boolean).join('。') + '。可以点「启动游戏」。');
  }

  private async doLaunch(): Promise<PlayState> {
    const d = this.deps;
    const dir = await this.gameFolder();

    if ((await runningGame()).length) {
      if ((await vanillaGame()).length) throw new Error(VANILLA_TEXT);
      d.startVoice();
      await d.focus();
      return d.linked() ? this.set('playing', '游戏已连上。') : this.set('menu', MENU_HINT);
    }

    const check = checkGame(dir);
    if (!check.northstar) throw new Error(NOT_PREPARED);
    if (!check.modCurrent || !check.localHttp || !check.dialogueHook) installMod(dir);

    const ea = await eaAppPath();
    if (!ea) throw new Error('没装 EA App:Steam 版泰坦陨落 2 通过 EA App 登录，装好并登录后再点「启动游戏」。');
    if (!(await eaAppRunning())) {
      this.set('ea', '正在启动 EA App,等它登录。');
      startEaApp(ea);
      const deadline = Date.now() + EA_PORT_WAIT_MS;
      while (!(await eaLsxListening())) {
        if (Date.now() > deadline) throw new Error('EA App 启动后两分钟还没就绪。打开 EA App 确认已登录，再点「启动游戏」。');
        await sleep(1000);
      }
      await sleep(EA_SIGN_IN_WAIT_MS);
    }

    d.startVoice();
    try {
      d.log.info('游戏显示设置', { result: await d.applyDisplay() });
    } catch (err) {
      d.log.warn('写游戏显示设置失败', { err: String(err) });
    }
    this.set('launch', '正在启动游戏。');
    launchGame(dir, d.launchArgs(), d.port());
    this.launchedAt = Date.now();
    const deadline = this.launchedAt + WINDOW_WAIT_MS;
    for (;;) {
      await sleep(1000);
      if (await d.focus()) break;
      if (Date.now() - this.launchedAt > 5000 && !(await runningGame()).length) throw new Error(this.exitText());
      if (Date.now() > deadline) throw new Error('游戏启动后一分半还没出现窗口。');
    }
    this.watchGame();
    return d.linked() ? this.set('playing', '游戏已连上。') : this.set('menu', MENU_HINT);
  }

  /** Follows the launched game until a level links or the game exits. */
  private watchGame(): void {
    this.stop();
    this.watch = setInterval(() => {
      void runningGame().then((pids) => {
        if (this.state.step !== 'menu' || pids.length) return;
        this.stop();
        if (Date.now() - this.launchedAt < EARLY_EXIT_MS) this.set('error', this.exitText());
        else this.set('idle', '游戏已关闭。');
      });
    }, WATCH_MS);
  }

  private exitText(): string {
    const sec = Math.round((Date.now() - this.launchedAt) / 1000);
    return `游戏启动 ${sec} 秒后退出了，没进关卡。EA App 没登录时游戏会弹出 #ORIGIN_LOGGED_OUT,点确定后退出：确认 EA App 已登录后再点「启动游戏」。`;
  }
}
