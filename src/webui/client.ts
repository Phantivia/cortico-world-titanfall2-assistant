/**
 * WebUI panel `start` (快速启动): the one-click start, the game folder and its Northstar/mod state,
 * and BT's voice with the download of its runtime and weights. The browser side imports no Node module.
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
  voice: {
    enabled: boolean;
    phase: 'off' | 'starting' | 'ready' | 'error';
    detail: string | null;
    assets: { external: boolean; runtimeDir: string | null; modelsDir: string; missingModels: string[]; downloadBytes: number };
    download: { progress: Progress | null; error: string | null; running: boolean };
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
      voice: (s: StartState['voice']) => (!s.enabled ? 'BT 语音已关闭' : s.assets.external || s.assets.downloadBytes === 0 ? 'BT 语音组件齐全' : 'BT 语音缺组件，只出字幕'),
    },
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
    voiceDesc: 'VoxCPM2 按游戏里截取的 BT 台词复刻声音，要 NVIDIA 显卡;截取样片用 PATH 里的 ffmpeg。一键开始和进入关卡时自动启动。',
    voiceStart: '启动语音',
    sample: '重新截取样片',
    test: '试听',
    phase: { off: '未启动', starting: '启动中', ready: '就绪', error: '出错' },
    missing: (a: StartState['voice']['assets'], gb: string) =>
      `缺少${a.runtimeDir ? '' : ' llama.cpp-omni 运行时'}${a.missingModels.length ? ` ${a.missingModels.join('、')}` : ''},共约 ${gb}`,
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
      voice: (s: StartState['voice']) => (!s.enabled ? 'BT voice off' : s.assets.external || s.assets.downloadBytes === 0 ? 'BT voice files present' : 'BT voice files missing: subtitles only'),
    },
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
    voiceDesc: 'VoxCPM2 clones BT from a line cut out of the game and needs an NVIDIA GPU; the sample is cut with ffmpeg from PATH. Starts on one-click start and when a level connects.',
    voiceStart: 'Start voice',
    sample: 'Cut sample again',
    test: 'Test',
    phase: { off: 'off', starting: 'starting', ready: 'ready', error: 'error' },
    missing: (a: StartState['voice']['assets'], gb: string) =>
      `Missing${a.runtimeDir ? '' : ' the llama.cpp-omni runtime'}${a.missingModels.length ? ` ${a.missingModels.join(', ')}` : ''}, about ${gb}`,
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
    const playBar = ui.rowbar();
    const playBtn = ui.button(t.play, { variant: 'primary', onClick: () => void play() });
    const frontBtn = ui.button(t.front, { onClick: () => void play() });
    const stepSlot = ui.h('span');
    playBar.append(stepSlot, ui.h('span', 'grow'), frontBtn, playBtn);
    const playProgress = ui.progress({ label: '' });
    const playLine = ui.msgline();
    const playErr = ui.msgline('', true);
    const statusLine = ui.msgline();
    playCard.body.append(readyLine, playBar, playProgress.el, playLine, playErr, statusLine);

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
    voiceCard.body.append(voiceBar, missingBar, voiceProgress.el, voiceLine);

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
      statusLine.textContent = t.status(s);

      if (document.activeElement !== dirInput) dirInput.value = s.gameDir;
      const c = s.check;
      checkLine.textContent = c
        ? `${c.dir} · ${(Object.keys(t.checks) as Array<keyof GameCheck & keyof typeof t.checks>).map((k) => `${t.checks[k]} ${c[k] ? t.yes : t.no}`).join(' · ')}`
        : t.notFound;
      installBtn.disabled = !c?.northstar;

      const v = s.voice;
      phaseSlot.replaceChildren(ui.pill(t.phase[v.phase], v.phase === 'ready' ? 'on' : v.phase === 'error' ? 'off' : 'plain'));
      const missing = !v.assets.external && v.assets.downloadBytes > 0;
      missingBar.hidden = !missing && !v.download.running;
      missingLine.textContent = missing ? t.missing(v.assets, ui.fmt.bytes(v.assets.downloadBytes)) : '';
      downloadBtn.disabled = v.download.running;
      showProgress(voiceProgress, v.download.running ? v.download.progress ?? { label: '…', done: 0, total: null } : null);
      if (v.download.error) voiceLine.textContent = v.download.error;
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

const bundle: WebUiClientBundle = { panels: { start: startPanel } };

export default bundle;
