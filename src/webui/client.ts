/**
 * WebUI panel `start` (快速启动): the game folder and its Northstar/mod state, launching the game,
 * and BT's voice. The browser side imports no Node module.
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

interface StartState {
  gameDir: string;
  resolvedDir: string | null;
  check: GameCheck | null;
  running: number[];
  link: { server: boolean; client: boolean };
  line: string;
  sidecarError: string | null;
  launchError: string | null;
  voice: { enabled: boolean; phase: 'off' | 'starting' | 'ready' | 'error'; detail: string | null };
  map: string | null;
  objective: string | null;
}

const TEXT = {
  zh: {
    gameTitle: '游戏',
    gameDesc: '需要装好 Northstar 的 Titanfall2 目录。模组随 World 启动自动装进去;Steam 版要先装好并登录 EA App。',
    dirPlaceholder: '留空自动找 Steam 里的 Titanfall2,或粘贴目录后按回车',
    detect: '自动查找',
    install: '安装/更新模组',
    launch: '启动游戏',
    launching: '启动中…',
    checks: { game: 'Titanfall2.exe', northstar: 'Northstar', modCurrent: '模组已是最新', localHttp: '-allowlocalhttp', dialogueHook: '剧情钩子' },
    yes: '有',
    no: '没有',
    notFound: '没找到游戏目录',
    running: (pids: number[]) => (pids.length ? `游戏进程 ${pids.join('、')}` : '游戏没在运行'),
    link: (l: StartState['link']) => `上报 ${l.server ? '在线' : '离线'} · 字幕通道 ${l.client ? '在线' : '离线'}`,
    voiceTitle: 'BT 语音',
    voiceDesc: 'VoxCPM2 按游戏里截取的 BT 台词复刻声音;第一次启动要加载模型。',
    voiceStart: '启动语音',
    sample: '重新截取样片',
    test: '试听',
    phase: { off: '未启动', starting: '启动中', ready: '就绪', error: '出错' },
    saved: '已保存',
    done: '完成',
  },
  en: {
    gameTitle: 'Game',
    gameDesc: 'The Titanfall2 folder with Northstar. The World installs its mod on start; the Steam copy needs the EA app installed and signed in.',
    dirPlaceholder: 'Empty finds the Steam copy; or paste a folder and press Enter',
    detect: 'Detect',
    install: 'Install/update mod',
    launch: 'Launch game',
    launching: 'Launching…',
    checks: { game: 'Titanfall2.exe', northstar: 'Northstar', modCurrent: 'Mod up to date', localHttp: '-allowlocalhttp', dialogueHook: 'Story hook' },
    yes: 'yes',
    no: 'no',
    notFound: 'No game folder found',
    running: (pids: number[]) => (pids.length ? `Game process ${pids.join(', ')}` : 'Game not running'),
    link: (l: StartState['link']) => `Reports ${l.server ? 'online' : 'offline'} · subtitles ${l.client ? 'online' : 'offline'}`,
    voiceTitle: 'BT voice',
    voiceDesc: 'VoxCPM2 clones BT from a line cut out of the game; the first start loads the models.',
    voiceStart: 'Start voice',
    sample: 'Cut sample again',
    test: 'Test',
    phase: { off: 'off', starting: 'starting', ready: 'ready', error: 'error' },
    saved: 'Saved',
    done: 'Done',
  },
};

const startPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const { ui, root } = ctx;
    const t = ctx.language === 'en' ? TEXT.en : TEXT.zh;

    const gameCard = ui.sheet({ title: t.gameTitle, desc: t.gameDesc });
    root.appendChild(gameCard.el);
    const dirInput = ui.input({ cls: 'mono', placeholder: t.dirPlaceholder, onCommit: (v) => void setDir(v) });
    dirInput.style.flex = '1';
    const detectBtn = ui.button(t.detect, { onClick: () => void detect() });
    const dirBar = ui.rowbar();
    dirBar.append(dirInput, detectBtn);
    const checkLine = ui.msgline();
    const statusLine = ui.msgline();
    const actBar = ui.rowbar();
    const installBtn = ui.button(t.install, { onClick: () => void act('install-mod') });
    const launchBtn = ui.button(t.launch, { variant: 'primary', onClick: () => void act('launch') });
    actBar.append(ui.h('span', 'grow'), installBtn, launchBtn);
    const errLine = ui.msgline('', true);
    gameCard.body.append(dirBar, checkLine, statusLine, actBar, errLine);

    const voiceCard = ui.sheet({ title: t.voiceTitle, desc: t.voiceDesc });
    root.appendChild(voiceCard.el);
    const voiceBar = ui.rowbar();
    const phaseSlot = ui.h('span');
    const voiceStartBtn = ui.button(t.voiceStart, { onClick: () => void act('voice-start') });
    const sampleBtn = ui.button(t.sample, { onClick: () => void act('refresh-sample') });
    const testBtn = ui.button(t.test, { variant: 'primary', onClick: () => void act('test-voice') });
    voiceBar.append(phaseSlot, ui.h('span', 'grow'), voiceStartBtn, sampleBtn, testBtn);
    const voiceLine = ui.msgline('', true);
    voiceCard.body.append(voiceBar, voiceLine);

    const act = async (method: string): Promise<void> => {
      errLine.textContent = '';
      try {
        await ctx.invoke(method);
        ui.toast(t.done, 'ok');
      } catch (e) {
        errLine.textContent = String(e instanceof Error ? e.message : e);
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
      else errLine.textContent = t.notFound;
    };

    const load = async (): Promise<void> => {
      const s = await ctx.invoke<StartState>('state');
      if (document.activeElement !== dirInput) dirInput.value = s.gameDir;
      const c = s.check;
      checkLine.textContent = c
        ? `${c.dir} · ${(Object.keys(t.checks) as Array<keyof GameCheck & keyof typeof t.checks>).map((k) => `${t.checks[k]} ${c[k] ? t.yes : t.no}`).join(' · ')}`
        : t.notFound;
      statusLine.textContent = `${t.running(s.running)} · ${t.link(s.link)}${s.map ? ` · ${s.map}` : ''}${s.objective ? ` · ${s.objective}` : ''}`;
      if (s.sidecarError || s.launchError) errLine.textContent = s.sidecarError ?? s.launchError ?? '';
      installBtn.disabled = !c?.northstar;
      launchBtn.disabled = !c?.northstar || s.running.length > 0;
      phaseSlot.replaceChildren(ui.pill(t.phase[s.voice.phase], s.voice.phase === 'ready' ? 'on' : 'plain'));
      voiceLine.textContent = s.voice.detail ?? '';
      voiceStartBtn.disabled = !s.voice.enabled || s.voice.phase === 'ready' || s.voice.phase === 'starting';
    };

    ctx.interval(() => void load().catch((e: unknown) => { errLine.textContent = String(e); }), 2000);
    void load().catch((e: unknown) => { errLine.textContent = String(e); });
  },
};

const bundle: WebUiClientBundle = { panels: { start: startPanel } };

export default bundle;
