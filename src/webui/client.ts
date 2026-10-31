/**
 * WebUI panels: `start` (快速启动), the one-click start, the game folder and its Northstar/mod state, and BT's
 * voice with the download of its runtime and weights; `display` (画面与切窗), the display mode, resolution and
 * focus behavior the World sets before launching the game. The browser side imports no Node module.
 */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

interface GameCheck {
  dir: string;
  game: boolean;
  northstar: boolean;
  modCurrent: boolean;
  localHttp: boolean;
  dialogueHook: boolean;
}

interface Progress {
  label: string;
  done: number;
  total: number | null;
}

type VoiceEngineId = 'gpt-sovits' | 'voxcpm2';
type Initiative = 'passive' | 'balanced' | 'active';
const INITIATIVES: readonly Initiative[] = ['passive', 'balanced', 'active'];

interface VoiceFiles {
  external: boolean;
  missing: string[];
  downloadBytes: number;
}

const filesReady = (f: VoiceFiles | null): boolean => !!f && (f.external || f.downloadBytes === 0);
const ENGINES: readonly VoiceEngineId[] = ['gpt-sovits', 'voxcpm2'];
const VERSION_NAMES: Record<string, string> = { v5turbo: 'V5 turbo', v2ProPlus: 'v2ProPlus' };

type PlayStep = 'idle' | 'northstar' | 'mod' | 'ea' | 'launch' | 'menu' | 'playing' | 'error';

interface StartState {
  gameDir: string;
  resolvedDir: string | null;
  check: GameCheck | null;
  running: number[];
  link: { server: boolean; client: boolean };
  sidecarError: string | null;
  play: { step: PlayStep; detail: string; progress: Progress | null } | null;
  northstarVersion: string;
  eaApp: boolean;
  /** Set while Titanfall2.exe runs without Northstar. */
  vanilla: string | null;
  /** Northstar's main menu will ask about its master server. */
  northstarAsks: boolean;
  initiative: Initiative;
  voice: {
    enabled: boolean;
    engine: VoiceEngineId;
    tier: { tier: string; version: string } | null;
    phase: 'off' | 'starting' | 'ready' | 'error';
    detail: string | null;
    files: VoiceFiles | null;
    download: { progress: Progress | null; error: string | null; running: boolean } | null;
  };
  map: string | null;
  objective: string | null;
}

const BUSY: readonly PlayStep[] = ['northstar', 'mod', 'ea', 'launch'];

const TEXT = {
  zh: {
    playTitle: '一键开始',
    playDesc: '按顺序装好缺的 Northstar 和模组、启动 EA App 和 BT 语音，再打开游戏并切到前台。游戏停在主菜单后，选「继续」或「任务选择」进入战役。',
    play: '一键开始',
    playing: '正在准备…',
    steps: { idle: '', northstar: '安装 Northstar', mod: '安装模组', ea: '启动 EA App', launch: '启动游戏', menu: '在主菜单', playing: '已连上', error: '没能开始' },
    front: '切到游戏',
    ready: {
      folder: (dir: string | null) => (dir ? `游戏 ${dir}` : '没找到游戏目录'),
      northstar: (c: GameCheck | null, v: string) => (c?.northstar ? 'Northstar 已装' : `Northstar 会下载安装 v${v}(约 107 MB)`),
      ea: (ok: boolean) => (ok ? 'EA App 已装' : '没装 EA App'),
      voice: (s: StartState['voice']) => (!s.enabled ? 'BT 语音已关闭' : filesReady(s.files) ? 'BT 语音组件齐全' : 'BT 语音缺组件，只出字幕'),
    },
    initTitle: 'BT 的主动程度',
    initDesc: 'Coo 以 BT 的身份陪玩时，不等铁驭开口就说话、出手的程度。改了立刻告诉 Coo。',
    initiatives: { passive: '被动', balanced: '均衡', active: '主动' } as Record<Initiative, string>,
    initiativeHelp: {
      passive: '铁驭开口或下令才说话、出手;只有要命的时候主动提醒。',
      balanced: '提醒要紧的威胁;战况吃紧时主动用飞弹、烟幕或声纳帮一把。',
      active: '全程配合作战：主动开火、放烟幕、标记，脱战后报下一步该去哪。',
    } as Record<Initiative, string>,
    northstarHint: '第一次经 Northstar 进主菜单会弹出「是否用 EA 令牌登录 Northstar 主服务器」的对话框：单人战役用不到，选「否」。',
    status: (s: StartState) =>
      `${s.running.length ? '游戏在运行' : '游戏没在运行'} · ${s.link.server ? `已连上${s.map ? `,${s.map}` : ''}` : '没有关卡在上报'}${s.objective ? ` · ${s.objective}` : ''}`,
    gameTitle: '游戏目录与模组',
    gameDesc: 'Steam 里的 Titanfall2 会自动找到;装在别处的粘贴目录后按回车。模组随 World 启动和一键开始自动更新。',
    dirPlaceholder: '留空自动查找',
    detect: '自动查找',
    install: '安装/更新模组',
    checks: { game: 'Titanfall2.exe', northstar: 'Northstar', modCurrent: '模组已是最新', localHttp: '-allowlocalhttp', dialogueHook: '剧情钩子' },
    yes: '有',
    no: '没有',
    notFound: '没找到游戏目录',
    voiceTitle: 'BT 语音',
    voiceDesc: '按游戏里截取的 BT 台词复刻声音，一键开始和进入关卡时自动启动。GPT-SoVITS 在 NVIDIA 显卡上用 V5 turbo,没有就用 CPU 跑 v2ProPlus,组件从魔搭下载;VoxCPM2 只能用 NVIDIA 显卡。',
    engines: { 'gpt-sovits': 'GPT-SoVITS', voxcpm2: 'VoxCPM2' } as Record<VoiceEngineId, string>,
    tier: (x: { tier: string; version: string }) => `${x.tier === 'cuda' ? '显卡档' : 'CPU 档'} · ${VERSION_NAMES[x.version] ?? x.version}`,
    voiceStart: '启动语音',
    sample: '重新截取样片',
    test: '试听',
    phase: { off: '未启动', starting: '启动中', ready: '就绪', error: '出错' },
    missing: (f: VoiceFiles, gb: string) => `还缺 ${f.missing.length} 个文件(运行时与模型),共约 ${gb}`,
    download: '下载语音组件',
    saved: '已保存',
    done: '完成',
  },
  en: {
    playTitle: 'One-click start',
    playDesc: 'Installs Northstar and the mod if missing, starts the EA app and BT\'s voice, then opens the game in front. At the main menu, pick Continue or Mission Select.',
    play: 'Start',
    playing: 'Preparing…',
    steps: { idle: '', northstar: 'Installing Northstar', mod: 'Installing mod', ea: 'Starting EA app', launch: 'Launching', menu: 'At main menu', playing: 'Connected', error: 'Did not start' },
    front: 'Show game',
    ready: {
      folder: (dir: string | null) => (dir ? `Game ${dir}` : 'No game folder found'),
      northstar: (c: GameCheck | null, v: string) => (c?.northstar ? 'Northstar installed' : `Northstar v${v} will be downloaded (about 107 MB)`),
      ea: (ok: boolean) => (ok ? 'EA app installed' : 'EA app not installed'),
      voice: (s: StartState['voice']) => (!s.enabled ? 'BT voice off' : filesReady(s.files) ? 'BT voice files present' : 'BT voice files missing: subtitles only'),
    },
    initTitle: 'BT\'s initiative',
    initDesc: 'How readily Coo, riding along as BT, speaks and acts without being asked. Coo is told as soon as it changes.',
    initiatives: { passive: 'Passive', balanced: 'Balanced', active: 'Active' } as Record<Initiative, string>,
    initiativeHelp: {
      passive: 'Speaks and acts when the pilot asks; warns unasked only in mortal danger.',
      balanced: 'Calls out the threats that matter; steps in with missiles, smoke or sonar when the fight turns.',
      active: 'Fights alongside throughout: fires, smokes and marks on its own, and reports where to go next after a fight.',
    } as Record<Initiative, string>,
    northstarHint: 'The first time Northstar reaches the main menu, it asks whether to sign in to the Northstar master server with your EA token: the campaign does not need it, pick No.',
    status: (s: StartState) =>
      `${s.running.length ? 'Game running' : 'Game not running'} · ${s.link.server ? `connected${s.map ? `, ${s.map}` : ''}` : 'no level reporting'}${s.objective ? ` · ${s.objective}` : ''}`,
    gameTitle: 'Game folder and mod',
    gameDesc: 'The Steam copy is found on its own; for another folder, paste it and press Enter. The mod updates when the World starts and on one-click start.',
    dirPlaceholder: 'Empty finds it',
    detect: 'Detect',
    install: 'Install/update mod',
    checks: { game: 'Titanfall2.exe', northstar: 'Northstar', modCurrent: 'Mod up to date', localHttp: '-allowlocalhttp', dialogueHook: 'Story hook' },
    yes: 'yes',
    no: 'no',
    notFound: 'No game folder found',
    voiceTitle: 'BT voice',
    voiceDesc: 'Clones BT from a line cut out of the game; starts on one-click start and when a level connects. GPT-SoVITS runs V5 turbo on NVIDIA GPUs and v2ProPlus on the CPU otherwise, downloaded from ModelScope; VoxCPM2 needs an NVIDIA GPU.',
    engines: { 'gpt-sovits': 'GPT-SoVITS', voxcpm2: 'VoxCPM2' } as Record<VoiceEngineId, string>,
    tier: (x: { tier: string; version: string }) => `${x.tier === 'cuda' ? 'GPU tier' : 'CPU tier'} · ${VERSION_NAMES[x.version] ?? x.version}`,
    voiceStart: 'Start voice',
    sample: 'Cut sample again',
    test: 'Test',
    phase: { off: 'off', starting: 'starting', ready: 'ready', error: 'error' },
    missing: (f: VoiceFiles, gb: string) => `${f.missing.length} files to download (runtime and models), about ${gb}`,
    download: 'Download voice files',
    saved: 'Saved',
    done: 'Done',
  },
};

const startPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const { ui, root } = ctx;
    const t = ctx.language === 'en' ? TEXT.en : TEXT.zh;

    const playCard = ui.sheet({ title: t.playTitle, desc: t.playDesc });
    root.appendChild(playCard.el);
    const readyLine = ui.msgline();
    const hintLine = ui.msgline();
    const playBar = ui.rowbar();
    const playBtn = ui.button(t.play, { variant: 'primary', onClick: () => void play() });
    const frontBtn = ui.button(t.front, { onClick: () => void play() });
    const stepSlot = ui.h('span');
    playBar.append(stepSlot, ui.h('span', 'grow'), frontBtn, playBtn);
    const playProgress = ui.progress({ label: '' });
    const playLine = ui.msgline();
    const playErr = ui.msgline('', true);
    const statusLine = ui.msgline();
    playCard.body.append(readyLine, hintLine, playBar, playProgress.el, playLine, playErr, statusLine);

    const initCard = ui.sheet({ title: t.initTitle, desc: t.initDesc });
    root.appendChild(initCard.el);
    const initSeg = ui.segmented(INITIATIVES.map((value) => ({ value, label: t.initiatives[value] })), {
      onSelect: (v) => void ctx.setConfig('world:titanfall2:intel', { 'worlds.titanfall2.initiative': v }).then(() => load()),
    });
    const initLine = ui.msgline();
    initCard.body.append(initSeg.el, initLine);

    const gameCard = ui.sheet({ title: t.gameTitle, desc: t.gameDesc });
    root.appendChild(gameCard.el);
    const dirInput = ui.input({ cls: 'mono', placeholder: t.dirPlaceholder, onCommit: (v) => void setDir(v) });
    dirInput.style.flex = '1';
    const detectBtn = ui.button(t.detect, { onClick: () => void detect() });
    const installBtn = ui.button(t.install, { onClick: () => void act('install-mod') });
    const dirBar = ui.rowbar();
    dirBar.append(dirInput, detectBtn, installBtn);
    const checkLine = ui.msgline();
    const gameErr = ui.msgline('', true);
    gameCard.body.append(dirBar, checkLine, gameErr);

    const voiceCard = ui.sheet({ title: t.voiceTitle, desc: t.voiceDesc });
    root.appendChild(voiceCard.el);
    const engineBar = ui.rowbar();
    const engines = ui.segmented(ENGINES.map((value) => ({ value, label: t.engines[value] })), {
      onSelect: (v) => void ctx.setConfig('world:titanfall2:voice', { 'worlds.titanfall2.voice.engine': v }).then(() => load()),
    });
    const tierSlot = ui.h('span');
    engineBar.append(engines.el, tierSlot);
    const voiceBar = ui.rowbar();
    const phaseSlot = ui.h('span');
    const voiceStartBtn = ui.button(t.voiceStart, { onClick: () => void act('voice-start') });
    const sampleBtn = ui.button(t.sample, { onClick: () => void act('refresh-sample') });
    const testBtn = ui.button(t.test, { onClick: () => void act('test-voice') });
    voiceBar.append(phaseSlot, ui.h('span', 'grow'), voiceStartBtn, sampleBtn, testBtn);
    const missingBar = ui.rowbar();
    const missingLine = ui.h('span', 'grow');
    const downloadBtn = ui.button(t.download, { variant: 'primary', onClick: () => void act('download-voice') });
    missingBar.append(missingLine, downloadBtn);
    const voiceProgress = ui.progress({ label: '' });
    const voiceLine = ui.msgline('', true);
    voiceCard.body.append(engineBar, voiceBar, missingBar, voiceProgress.el, voiceLine);

    const showProgress = (bar: ReturnType<typeof ui.progress>, p: Progress | null): void => {
      bar.el.hidden = !p;
      if (!p) return;
      bar.setLabel(p.total ? `${p.label} · ${ui.fmt.bytes(p.done)} / ${ui.fmt.bytes(p.total)}` : p.label);
      bar.setValue(p.total ? p.done : 0, p.total ?? 1);
    };

    const play = async (): Promise<void> => {
      playErr.textContent = '';
      playBtn.disabled = true;
      void load();
      try {
        await ctx.invoke('play');
      } catch (e) {
        playErr.textContent = String(e instanceof Error ? e.message : e);
      }
      await load();
    };

    const act = async (method: string): Promise<void> => {
      gameErr.textContent = '';
      voiceLine.textContent = '';
      try {
        await ctx.invoke(method);
        ui.toast(t.done, 'ok');
      } catch (e) {
        (method === 'install-mod' ? gameErr : voiceLine).textContent = String(e instanceof Error ? e.message : e);
      }
      await load();
    };

    const setDir = async (v: string): Promise<void> => {
      await ctx.setConfig('world:titanfall2', { 'worlds.titanfall2.gameDir': v.trim() });
      ui.toast(t.saved, 'ok');
      await load();
    };

    const detect = async (): Promise<void> => {
      const dirs = await ctx.invoke<string[]>('detect');
      if (dirs[0]) await setDir(dirs[0]);
      else gameErr.textContent = t.notFound;
    };

    const load = async (): Promise<void> => {
      const s = await ctx.invoke<StartState>('state');
      const busy = s.play !== null && BUSY.includes(s.play.step);
      readyLine.textContent = [t.ready.folder(s.resolvedDir), t.ready.northstar(s.check, s.northstarVersion), t.ready.ea(s.eaApp), t.ready.voice(s.voice)].join(' · ');
      playBtn.disabled = busy || !s.resolvedDir || s.running.length > 0;
      playBtn.textContent = busy ? t.playing : t.play;
      frontBtn.hidden = s.running.length === 0;
      frontBtn.disabled = busy;
      const step = s.play?.step ?? 'idle';
      stepSlot.replaceChildren(...(step === 'idle' ? [] : [ui.pill(t.steps[step], step === 'error' ? 'off' : step === 'playing' ? 'on' : 'plain')]));
      showProgress(playProgress, busy ? s.play?.progress ?? null : null);
      playLine.textContent = step === 'error' ? '' : s.play?.detail ?? '';
      if (step === 'error') playErr.textContent = s.play?.detail ?? '';
      else if (busy) playErr.textContent = '';
      if (s.sidecarError) playErr.textContent = s.sidecarError;
      if (s.vanilla) playErr.textContent = s.vanilla;
      hintLine.textContent = s.northstarAsks ? t.northstarHint : '';
      hintLine.hidden = !s.northstarAsks;
      initSeg.setValue(s.initiative);
      initLine.textContent = t.initiativeHelp[s.initiative] ?? '';
      statusLine.textContent = t.status(s);

      if (document.activeElement !== dirInput) dirInput.value = s.gameDir;
      const c = s.check;
      checkLine.textContent = c
        ? `${c.dir} · ${(Object.keys(t.checks) as Array<keyof GameCheck & keyof typeof t.checks>).map((k) => `${t.checks[k]} ${c[k] ? t.yes : t.no}`).join(' · ')}`
        : t.notFound;
      installBtn.disabled = !c?.northstar;

      const v = s.voice;
      engines.setValue(v.engine);
      tierSlot.replaceChildren(...(v.tier ? [ui.pill(t.tier(v.tier), 'plain')] : []));
      phaseSlot.replaceChildren(ui.pill(t.phase[v.phase], v.phase === 'ready' ? 'on' : v.phase === 'error' ? 'off' : 'plain'));
      const missing = !filesReady(v.files);
      const downloading = !!v.download?.running;
      missingBar.hidden = !missing && !downloading;
      missingLine.textContent = missing && v.files ? t.missing(v.files, ui.fmt.bytes(v.files.downloadBytes)) : '';
      downloadBtn.disabled = downloading;
      showProgress(voiceProgress, downloading ? v.download?.progress ?? { label: '…', done: 0, total: null } : null);
      if (v.download?.error) voiceLine.textContent = v.download.error;
      else if (v.phase === 'error' && v.detail) voiceLine.textContent = v.detail;
      voiceStartBtn.disabled = !v.enabled || missing || v.phase === 'ready' || v.phase === 'starting';
      testBtn.disabled = v.phase !== 'ready';
    };

    let polling = false;
    const poll = (): void => {
      if (polling) return;
      polling = true;
      void load()
        .catch((e: unknown) => { playErr.textContent = String(e); })
        .finally(() => { polling = false; });
    };
    ctx.interval(poll, 1000);
    poll();
  },
};

type DisplayMode = 'borderless' | 'windowed' | 'fullscreen' | 'game';

interface GameDisplay {
  fullscreen: boolean;
  borderless: boolean;
  width: number;
  height: number;
}

interface DisplayState {
  display: { mode: DisplayMode; resolution: string };
  focus: { keepRunning: boolean; sound: boolean };
  launchArgs: string;
  command: string;
  screen: { width: number; height: number; modes: string[] } | null;
  file: string | null;
  game: GameDisplay | null;
  pending: boolean;
  running: boolean;
}

const DISPLAY_TEXT = {
  zh: {
    modeTitle: '显示模式',
    modeDesc: '独占全屏会盖住桌宠;无边框窗口铺满屏幕，桌宠显示在游戏上面。一键开始时写进游戏设置，游戏开着时改，下次启动前写入。',
    modes: { borderless: '无边框窗口', windowed: '窗口', fullscreen: '全屏', game: '保持游戏里的设置' } as Record<DisplayMode, string>,
    resolution: '分辨率',
    fitScreen: (s: DisplayState['screen']) => (s ? `跟随主屏(${s.width}×${s.height})` : '跟随主屏'),
    keepGame: '保持游戏里的大小',
    current: (g: GameDisplay | null) => (g ? `游戏设置现在是 ${g.fullscreen ? '全屏' : g.borderless ? '无边框窗口' : '窗口'} ${g.width}×${g.height}` : '游戏还没有显示设置文件，一键开始时按上面的设置新建'),
    pending: '一键开始时会改成上面的设置',
    apply: '现在写入',
    running: '游戏开着，关掉后再写入',
    focusTitle: '切到别的窗口时',
    focusDesc: '比如在桌宠里打字。下次启动游戏生效。',
    keepRunning: '游戏继续运行，不暂停、不降帧',
    keepRunningTip: '关掉时游戏会暂停，BT 不能出手和说话',
    sound: '保留游戏声音',
    argsTitle: '启动参数',
    argsDesc: '上面的选项会生成对应的参数，排在这里填的参数后面。',
    argsPlaceholder: '其他启动参数',
    saved: '已保存',
  },
  en: {
    modeTitle: 'Display mode',
    modeDesc: 'Exclusive fullscreen hides the pet; a borderless window fills the screen with the pet on top. Written into the game\'s settings on one-click start; changed while the game runs, it is written before the next launch.',
    modes: { borderless: 'Borderless window', windowed: 'Window', fullscreen: 'Fullscreen', game: 'Keep the game\'s setting' } as Record<DisplayMode, string>,
    resolution: 'Resolution',
    fitScreen: (s: DisplayState['screen']) => (s ? `Primary screen (${s.width}×${s.height})` : 'Primary screen'),
    keepGame: 'Keep the game\'s size',
    current: (g: GameDisplay | null) => (g ? `The game is set to ${g.fullscreen ? 'fullscreen' : g.borderless ? 'borderless window' : 'window'} ${g.width}×${g.height}` : 'The game has no display settings file yet; one-click start creates it with the setting above'),
    pending: 'One-click start changes it to the setting above',
    apply: 'Write now',
    running: 'The game is open; close it to write',
    focusTitle: 'When another window has focus',
    focusDesc: 'Such as typing to the pet. Applies from the next launch.',
    keepRunning: 'Keep the game running at full frame rate',
    keepRunningTip: 'Off: the game pauses and BT cannot act or speak',
    sound: 'Keep the game\'s sound',
    argsTitle: 'Launch arguments',
    argsDesc: 'The options above add their own arguments after these.',
    argsPlaceholder: 'Other launch arguments',
    saved: 'Saved',
  },
};

const DISPLAY_GROUP = 'world:titanfall2';
const KEY = 'worlds.titanfall2';

const displayPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const { ui, root } = ctx;
    const t = ctx.language === 'en' ? DISPLAY_TEXT.en : DISPLAY_TEXT.zh;
    let state: DisplayState | null = null;

    const save = async (values: Record<string, string | boolean>): Promise<void> => {
      errLine.textContent = '';
      try {
        await ctx.setConfig(DISPLAY_GROUP, values);
        ui.toast(t.saved, 'ok');
      } catch (e) {
        errLine.textContent = String(e instanceof Error ? e.message : e);
      }
      await load();
    };

    const modeCard = ui.sheet({ title: t.modeTitle, desc: t.modeDesc });
    root.appendChild(modeCard.el);
    const modes = ui.segmented(
      (Object.keys(t.modes) as DisplayMode[]).map((value) => ({ value, label: t.modes[value] })),
      { onSelect: (v) => void save({ [`${KEY}.display.mode`]: v }) },
    );
    const resolution = ui.select({ onChange: (v) => void save({ [`${KEY}.display.resolution`]: v }) });
    const resBar = ui.rowbar();
    resBar.append(ui.field(t.resolution, resolution));
    const gameLine = ui.msgline();
    const applyBar = ui.rowbar();
    const pendingLine = ui.h('span', 'grow');
    const applyBtn = ui.button(t.apply, { onClick: () => void apply() });
    applyBar.append(pendingLine, applyBtn);
    const errLine = ui.msgline('', true);
    modeCard.body.append(modes.el, resBar, gameLine, applyBar, errLine);

    const focusCard = ui.sheet({ title: t.focusTitle, desc: t.focusDesc });
    root.appendChild(focusCard.el);
    const keepRunning = ui.checkbox(t.keepRunning, { title: t.keepRunningTip, onChange: (v) => void save({ [`${KEY}.focus.keepRunning`]: v }) });
    const sound = ui.checkbox(t.sound, { onChange: (v) => void save({ [`${KEY}.focus.sound`]: v }) });
    const keepBar = ui.rowbar();
    keepBar.append(keepRunning.el);
    const soundBar = ui.rowbar();
    soundBar.append(sound.el);
    focusCard.body.append(keepBar, soundBar);

    const argsCard = ui.sheet({ title: t.argsTitle, desc: t.argsDesc });
    root.appendChild(argsCard.el);
    const args = ui.input({ cls: 'mono', placeholder: t.argsPlaceholder, onCommit: (v) => void save({ [`${KEY}.launchArgs`]: v.trim() }) });
    args.style.flex = '1';
    const argsBar = ui.rowbar();
    argsBar.append(args);
    const commandLine = ui.msgline();
    commandLine.classList.add('mono');
    argsCard.body.append(argsBar, commandLine);

    const apply = async (): Promise<void> => {
      errLine.textContent = '';
      try {
        ui.toast(await ctx.invoke<string>('apply'), 'ok');
      } catch (e) {
        errLine.textContent = String(e instanceof Error ? e.message : e);
      }
      await load();
    };

    const load = async (): Promise<void> => {
      const s = await ctx.invoke<DisplayState>('state');
      state = s;
      modes.setValue(s.display.mode);
      const sizes = s.screen?.modes ?? [];
      const options = [{ value: '', label: s.display.mode === 'windowed' ? t.keepGame : t.fitScreen(s.screen) }, ...sizes.map((m) => ({ value: m, label: m.replace('x', '×') }))];
      if (s.display.resolution && !sizes.includes(s.display.resolution)) options.push({ value: s.display.resolution, label: s.display.resolution.replace('x', '×') });
      resolution.replaceChildren(...options.map((o) => {
        const el = document.createElement('option');
        el.value = o.value;
        el.textContent = o.label;
        return el;
      }));
      resolution.value = s.display.resolution;
      resolution.disabled = s.display.mode === 'game';
      gameLine.textContent = t.current(s.game);
      pendingLine.textContent = s.pending ? (s.running ? t.running : t.pending) : '';
      applyBtn.hidden = !s.pending;
      applyBtn.disabled = s.running;
      keepRunning.setChecked(s.focus.keepRunning);
      sound.setChecked(s.focus.sound);
      if (document.activeElement !== args) args.value = s.launchArgs;
      commandLine.textContent = s.command;
    };

    void load().catch((e: unknown) => { errLine.textContent = String(e); });
    ctx.interval(() => {
      if (state && document.activeElement !== resolution) void load().catch(() => undefined);
    }, 5000);
  },
};

const bundle: WebUiClientBundle = { panels: { start: startPanel, display: displayPanel } };

export default bundle;
