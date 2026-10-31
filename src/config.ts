/** Config section `worlds.titanfall2`, defaults and the WebUI config groups. */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { WorldSection } from 'cortico/world.ts';

export const TITANFALL2_ID = 'titanfall2';

export interface Titanfall2ConfigSection extends WorldSection {
  /** The Titanfall 2 install directory; empty finds the Steam copy. */
  gameDir: string;
  /** Loopback port of the sidecar; the World passes it to the game it launches. */
  port: number;
  /**
   * Arguments added to NorthstarLauncher.exe after `-allowlocalhttp`. The defaults keep the campaign running
   * and audible while another window, such as the pet, has focus, so BT can act and speak while the player types.
   */
  launchArgs: string;
  intel: {
    /** Least time between two state snapshots in the context. */
    snapshotSec: number;
    /** Nearest hostiles listed by label in snapshots; titans and reapers are always listed. */
    maxListed: number;
    /** Least time between two alerts of the same kind. */
    alertCooldownSec: number;
    /** Pilot health percentage below which an alert fires. */
    lowHealthPct: number;
  };
  support: {
    /** Missiles per volley when the tool call names no count. */
    missileCount: number;
    /** Cooldown of BT's missiles while BT fights on its own (the pilot's titan uses the weapon's own charge). */
    autoMissileCooldownSec: number;
    smokeCooldownSec: number;
    pulseCooldownSec: number;
    markCooldownSec: number;
    /** How long marked hostiles stay outlined. */
    markSec: number;
  };
  story: {
    /** Campaign dialogue reaches the context as it plays. */
    enabled: boolean;
    /** Text language of the game: resource/subtitles_<language>.dat. */
    language: string;
    /** Write dialogue in simplified Chinese. */
    simplified: boolean;
    /** Least time between two game frames attached to story events; 0 attaches none. */
    frameSec: number;
    /** Long edge of attached game frames. */
    frameMaxPx: number;
  };
  guide: {
    /** A pilot helmet within this distance is announced once. */
    helmetNearM: number;
  };
  voice: {
    enabled: boolean;
    /** A running VoxCPM2 server; empty starts one from runtimeDir. */
    serverUrl: string;
    /** Directory holding llama-tts-server.exe; empty uses the newest llama.cpp-omni runtime. */
    runtimeDir: string;
    /** Directory holding VoxCPM2-BaseLM-F16.gguf and VoxCPM2-Acoustic-F16.gguf; empty uses <models>/vtuber. */
    modelsDir: string;
    /** Game sound alias cut from the installed game as the voice sample. */
    sampleAlias: string;
    /** What BT says in the sample, word for word. */
    sampleText: string;
    /** Audio language of the sample: the game's `general_<language>.mstr`. */
    sampleLanguage: string;
    volume: number;
    /** Output device name; empty is the system default. */
    outputDevice: string;
    inferenceTimesteps: number;
  };
  subtitle: {
    /** Font size of the subtitle RUI. */
    size: number;
    /** msgPos of the centered text RUI. */
    posX: number;
    posY: number;
    charsPerLine: number;
    /** Shortest time a subtitle stays when there is no voice. */
    minSec: number;
    /** Show subtitles in traditional characters: the game's CJK font has only those. */
    traditional: boolean;
    /** Opacity of the box behind the subtitle; 0 draws none. */
    boxAlpha: number;
  };
}

export const TITANFALL2_DEFAULTS: Titanfall2ConfigSection = {
  enabled: false,
  gameDir: '',
  port: 27941,
  launchArgs: '-noOriginStartup -novid +sp_not_focus_pause 0 +not_focus_sleep 0 +sound_without_focus 1',
  intel: { snapshotSec: 20, maxListed: 6, alertCooldownSec: 20, lowHealthPct: 35 },
  support: { missileCount: 6, autoMissileCooldownSec: 15, smokeCooldownSec: 20, pulseCooldownSec: 12, markCooldownSec: 5, markSec: 10 },
  story: { enabled: true, language: 'tchinese', simplified: true, frameSec: 30, frameMaxPx: 1280 },
  guide: { helmetNearM: 40 },
  voice: {
    enabled: true,
    serverUrl: '',
    runtimeDir: '',
    modelsDir: '',
    sampleAlias: 'diag_sp_Spoke0_BE331_18_01_mcor_bt',
    sampleText: '铁驭，我已连接至你的头盔抬头显示以跟监进度。频道随时开启供你需要时使用。',
    sampleLanguage: 'tchinese',
    volume: 1,
    outputDevice: '',
    inferenceTimesteps: 10,
  },
  subtitle: { size: 30, posX: 0, posY: -0.42, charsPerLine: 26, minSec: 3, traditional: true, boxAlpha: 0.5 },
};

const K = `worlds.${TITANFALL2_ID}`;

export function titanfall2ConfigGroups(language?: string): ConfigGroup[] {
  const en = language === 'en';
  const id = `world:${TITANFALL2_ID}`;
  const sec = 'x-suffix';
  return [
    {
      id,
      owner: id,
      schema: {
        type: 'object',
        title: en ? 'Game' : '游戏',
        properties: {
          [`${K}.gameDir`]: { type: 'string', title: en ? 'Game directory' : '游戏目录', description: en ? 'The Titanfall2 folder with Northstar installed. Empty: the Steam copy.' : '装了 Northstar 的 Titanfall2 目录;留空找 Steam 里的那份。', 'x-hot': true },
          [`${K}.launchArgs`]: { type: 'string', title: en ? 'Launch arguments' : '启动参数', description: en ? 'Added after -allowlocalhttp when the World starts the game.' : 'World 启动游戏时加在 -allowlocalhttp 之后。', 'x-hot': true },
          [`${K}.port`]: { type: 'integer', title: en ? 'Sidecar port' : 'sidecar 端口', minimum: 1024, maximum: 65535, 'x-hot': false },
        },
      },
    },
    {
      id: `${id}:intel`,
      owner: id,
      schema: {
        type: 'object',
        title: en ? 'Intel and support' : '情报与支援',
        properties: {
          [`${K}.intel.snapshotSec`]: { type: 'integer', title: en ? 'Snapshot interval' : '快照间隔', minimum: 5, maximum: 300, [sec]: 's', 'x-hot': true },
          [`${K}.intel.maxListed`]: { type: 'integer', title: en ? 'Hostiles listed' : '快照列出的敌人', minimum: 0, maximum: 20, 'x-hot': true },
          [`${K}.intel.alertCooldownSec`]: { type: 'integer', title: en ? 'Alert spacing' : '同类警报间隔', minimum: 0, maximum: 300, [sec]: 's', 'x-hot': true },
          [`${K}.intel.lowHealthPct`]: { type: 'integer', title: en ? 'Low health alert' : '低血量警报', minimum: 0, maximum: 90, [sec]: '%', 'x-hot': true },
          [`${K}.support.missileCount`]: { type: 'integer', title: en ? 'Missiles per volley' : '每轮飞弹', minimum: 1, maximum: 12, 'x-hot': true },
          [`${K}.support.autoMissileCooldownSec`]: { type: 'integer', title: en ? 'Missile cooldown (BT on its own)' : '飞弹冷却(BT 单独作战)', minimum: 0, maximum: 120, [sec]: 's', 'x-hot': true },
          [`${K}.support.smokeCooldownSec`]: { type: 'integer', title: en ? 'Smoke cooldown' : '电烟幕冷却', minimum: 0, maximum: 120, [sec]: 's', 'x-hot': true },
          [`${K}.support.pulseCooldownSec`]: { type: 'integer', title: en ? 'Sonar cooldown' : '声纳冷却', minimum: 0, maximum: 120, [sec]: 's', 'x-hot': true },
          [`${K}.support.markCooldownSec`]: { type: 'integer', title: en ? 'Mark cooldown' : '标记冷却', minimum: 0, maximum: 120, [sec]: 's', 'x-hot': true },
          [`${K}.support.markSec`]: { type: 'integer', title: en ? 'Mark duration' : '标记持续', minimum: 2, maximum: 60, [sec]: 's', 'x-hot': true },
          [`${K}.guide.helmetNearM`]: { type: 'integer', title: en ? 'Helmet call-out distance' : '头盔提示距离', minimum: 0, maximum: 200, [sec]: 'm', 'x-hot': true },
        },
      },
    },
    {
      id: `${id}:story`,
      owner: id,
      schema: {
        type: 'object',
        title: en ? 'Story' : '剧情',
        properties: {
          [`${K}.story.enabled`]: { type: 'boolean', title: en ? 'Campaign dialogue' : '剧情台词', 'x-hot': true },
          [`${K}.story.language`]: { type: 'string', title: en ? 'Game text language' : '游戏文字语言', description: en ? 'resource/subtitles_<language>.dat, e.g. tchinese, english.' : '游戏的字幕语言，如 tchinese、english。', 'x-hot': true },
          [`${K}.story.simplified`]: { type: 'boolean', title: en ? 'Simplified Chinese' : '转成简体', 'x-hot': true },
          [`${K}.story.frameSec`]: { type: 'integer', title: en ? 'Game frame interval' : '附画面间隔', minimum: 0, maximum: 600, [sec]: 's', description: en ? 'Least time between two game frames attached to story events; 0 attaches none.' : '剧情事件附游戏画面的最短间隔;0 不附。', 'x-hot': true },
          [`${K}.story.frameMaxPx`]: { type: 'integer', title: en ? 'Frame width' : '画面宽度', minimum: 480, maximum: 1920, [sec]: 'px', 'x-hot': true },
        },
      },
    },
    {
      id: `${id}:voice`,
      owner: id,
      schema: {
        type: 'object',
        title: en ? 'BT voice and subtitles' : 'BT 语音与字幕',
        properties: {
          [`${K}.voice.enabled`]: { type: 'boolean', title: en ? 'Voice' : '语音', 'x-hot': true },
          [`${K}.voice.serverUrl`]: { type: 'string', title: en ? 'VoxCPM2 server' : 'VoxCPM2 服务', description: en ? 'Empty: start llama-tts-server from the runtime directory.' : '留空时从运行时目录启动 llama-tts-server。', 'x-hot': true },
          [`${K}.voice.runtimeDir`]: { type: 'string', title: en ? 'Runtime directory' : '运行时目录', description: en ? 'Empty: the newest installed llama.cpp-omni runtime.' : '留空用已装的最新 llama.cpp-omni 运行时。', 'x-hot': true },
          [`${K}.voice.modelsDir`]: { type: 'string', title: en ? 'Model directory' : '模型目录', description: en ? 'Empty: <models>/vtuber.' : '留空即 <models>/vtuber。', 'x-hot': true },
          [`${K}.voice.sampleAlias`]: { type: 'string', title: en ? 'Sample line' : '样片台词', description: en ? 'Sound alias of the BT line cut from the game as the voice sample.' : '从游戏里截取作样片的 BT 台词音频名。', 'x-hot': true },
          [`${K}.voice.sampleText`]: { type: 'string', title: en ? 'Sample text' : '样片文字', description: en ? 'What the sample line says, word for word.' : '样片台词的逐字稿。', 'x-hot': true },
          [`${K}.voice.sampleLanguage`]: { type: 'string', title: en ? 'Sample language' : '样片语言', description: en ? 'Audio language file of the game, e.g. tchinese, english.' : '游戏语音包，如 tchinese、english。', 'x-hot': true },
          [`${K}.voice.volume`]: { type: 'number', title: en ? 'Volume' : '音量', minimum: 0, maximum: 1, 'x-hot': true },
          [`${K}.voice.outputDevice`]: { type: 'string', title: en ? 'Output device' : '输出设备', 'x-hot': true },
          [`${K}.voice.inferenceTimesteps`]: { type: 'integer', title: en ? 'Inference steps' : '推理步数', minimum: 4, maximum: 30, 'x-hot': true },
          [`${K}.subtitle.size`]: { type: 'number', title: en ? 'Subtitle size' : '字幕字号', minimum: 12, maximum: 80, 'x-hot': true },
          [`${K}.subtitle.posX`]: { type: 'number', title: en ? 'Subtitle X' : '字幕横向位置', minimum: -1, maximum: 1, 'x-hot': true },
          [`${K}.subtitle.posY`]: { type: 'number', title: en ? 'Subtitle Y' : '字幕纵向位置', minimum: -1, maximum: 1, 'x-hot': true },
          [`${K}.subtitle.charsPerLine`]: { type: 'integer', title: en ? 'Characters per line' : '每行字数', minimum: 8, maximum: 60, 'x-hot': true },
          [`${K}.subtitle.minSec`]: { type: 'number', title: en ? 'Shortest subtitle' : '字幕最短停留', minimum: 1, maximum: 20, [sec]: 's', 'x-hot': true },
          [`${K}.subtitle.traditional`]: { type: 'boolean', title: en ? 'Traditional characters' : '字幕用繁体', description: en ? 'The game\'s Chinese font has traditional characters only.' : '游戏的中文字体只有繁体字。', 'x-hot': true },
          [`${K}.subtitle.boxAlpha`]: { type: 'number', title: en ? 'Subtitle box opacity' : '字幕底框不透明度', minimum: 0, maximum: 1, 'x-hot': true },
        },
      },
    },
  ];
}
