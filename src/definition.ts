import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { modelsRoot, runtimesRoot } from 'cortico/paths.ts';
import { TITANFALL2_DEFAULTS, TITANFALL2_ID, type Titanfall2ConfigSection } from './config.ts';
import { TITANFALL2_TOOL_DECLS } from './tools.ts';
import { Titanfall2World } from './world.ts';

export const TITANFALL2: WorldDefinition<Titanfall2ConfigSection> = {
  id: TITANFALL2_ID,
  label: '泰坦陨落 2 陪玩',
  defaults: () => structuredClone(TITANFALL2_DEFAULTS),
  preflight: () => {
    if (process.platform !== 'win32') throw new Error('泰坦陨落 2 陪玩只支持 Windows:游戏、Northstar 和语音服务都是 Windows 程序。');
  },
  // ctx.cfg is the live `worlds.titanfall2` section; everything except the port is read when used
  create: (ctx) => new Titanfall2World({ cfg: ctx.cfg, timezone: ctx.timezone, dataDir: ctx.dataDir, runtimesRoot: runtimesRoot(), modelsRoot: modelsRoot() }),
  describe: {
    tools: describeTools(TITANFALL2_TOOL_DECLS, {
      titanfall2_scan: { zh: '读完整情报：关卡与目标、铁驭和 BT 的状态、支援冷却、每个敌人的编号与方位。', en: 'Full intel: level and objective, pilot and BT status, support cooldowns, and every hostile with label and bearing.' },
      titanfall2_say: { zh: '以 BT 的身份说话：游戏里出 BT 字幕，同时用复刻的 BT 声音念出来。', en: 'Speaks as BT: BT\'s in-game subtitle plus the cloned BT voice.' },
      titanfall2_missiles: { zh: 'BT 向指定编号的敌人发射追踪飞弹。', en: 'BT fires homing missiles at the labelled hostiles.' },
      titanfall2_smoke: { zh: 'BT 在周围放电烟幕。', en: 'BT deploys electric smoke around itself.' },
      titanfall2_pulse: { zh: 'BT 放声纳脉冲高亮附近敌人。', en: 'BT pulses sonar to highlight nearby hostiles.' },
      titanfall2_look: { zh: '截一张游戏当前画面。', en: 'Takes a picture of the game as it is now.' },
      titanfall2_guide: { zh: '地图导引：目标、没拿到的头盔收集品和 BT 装备拾取物在哪。', en: 'Map guide: the objective, uncollected pilot helmets and BT loadout pickups.' },
      titanfall2_mark: { zh: '把指定敌人隔墙描边高亮给铁驭看。', en: 'Outlines the given hostiles for the pilot, through walls.' },
      titanfall2_focus: { zh: '让单独作战的 BT 攻击指定敌人。', en: 'Has BT, fighting on its own, target the given hostile.' },
      titanfall2_launch: { zh: '替玩家打开游戏：按需安装 Northstar 与模组、启动 EA App 和 BT 语音，再启动游戏并切到前台。', en: 'Opens the game for the player: installs Northstar and the mod as needed, starts the EA app and BT\'s voice, then launches the game in front.' },
    }),
    events: [
      { type: 'titanfall2.state', description: { zh: '游戏连上、关闭或停止上报，进入新关卡，读取检查点。', en: 'The game connected, closed or stopped reporting, a level started, or a checkpoint loaded.' }, trigger: 'flush' },
      { type: 'titanfall2.alert', description: { zh: '战况警报：敌方泰坦或死神出现、铁驭低血量或阵亡、BT 护盾破、生命下降、被骑乘、濒死，交火开始。', en: 'Combat alerts: an enemy titan or reaper appears, pilot low or dead, BT shield down, health dropping, rodeoed or doomed, a firefight starts.' }, trigger: 'flush' },
      { type: 'titanfall2.combat', description: { zh: '战斗进展：击杀、敌方泰坦濒死、登机离机、核心就绪、交火结束。', en: 'Combat progress: kills, enemy titans doomed, embark and disembark, core ready, firefight over.' }, trigger: 'debounce' },
      { type: 'titanfall2.story', description: { zh: '战役里播放的剧情台词(说话人与字幕原文),投递时附一张当时的游戏画面。', en: 'Campaign dialogue as it plays (speaker and caption), with a game frame taken at delivery.' }, trigger: 'debounce' },
      { type: 'titanfall2.guide', description: { zh: '铁驭走近一个还没拿到的头盔收集品。', en: 'The pilot is near an uncollected pilot helmet.' }, trigger: 'piggyback' },
      { type: 'titanfall2.objective', description: { zh: '任务目标换了，附目标点方位。', en: 'The objective changed, with its bearing.' }, trigger: 'debounce' },
      { type: 'titanfall2.snapshot', description: { zh: '定时的状态快照，投递时按最新一帧生成，只写变了的部分。', en: 'A periodic snapshot rendered from the newest frame at delivery, with only the parts that changed.' }, trigger: 'piggyback' },
    ],
  },
};
