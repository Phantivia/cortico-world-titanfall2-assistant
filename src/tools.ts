/** Tool declarations; `Titanfall2World.tools()` binds the handlers. */
import type { ToolDef } from 'cortico/core/types.ts';

type Decl = Omit<ToolDef, 'handler'>;

export const TITANFALL2_TOOL_DECLS: readonly Decl[] = [
  {
    name: 'titanfall2_scan',
    tags: ['read', 'snapshot'],
    description:
      '读一次完整情报:关卡、目标与方位、铁驭和 BT 的状态、BT 各项支援还要等多久，以及扫描范围内每个敌人的编号、种类、方位(以铁驭视线为 12 点钟)、距离、高低、生命、在打谁、铁驭看不看得见。编号在敌人活着时不变，飞弹按编号指定目标。',
    parameters: {
      type: 'object',
      properties: {
        only: { type: 'string', enum: ['all', 'engaging', 'visible', 'titans'], description: '只列一部分:engaging 正在交火的、visible 铁驭看得见的、titans 泰坦与死神;默认 all' },
      },
      required: [],
    },
  },
  {
    name: 'titanfall2_say',
    tags: ['act'],
    description:
      '以 BT 的身份对铁驭说话：游戏里出 BT 的字幕，同时用 BT 的声音念出来。text 是要说的话，排在 BT 还没说完的话后面;返回时第一句已经出声、字幕已经上屏。interrupt 为 true 时先打断 BT 正在说的和排着的话。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要说的话' },
        interrupt: { type: 'boolean', description: '先打断正在说的话' },
      },
      required: ['text'],
    },
  },
  {
    name: 'titanfall2_missiles',
    tags: ['act'],
    description:
      'BT 发射多目标飞弹，飞弹轮流分给给出的目标并追踪命中。铁驭在驾驶舱里时消耗 BT 飞弹系统的充能(满充能 12 枚，自动回充);BT 单独作战时整轮发射后有冷却。回执写发射了几枚、各打向谁，以及剩余可发数或冷却时间。',
    parameters: {
      type: 'object',
      properties: {
        targets: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12, description: '敌人编号，如 ["E3","E7"]' },
        count: { type: 'integer', minimum: 1, maximum: 12, description: '发射枚数;不给按配置' },
      },
      required: ['targets'],
    },
  },
  {
    name: 'titanfall2_smoke',
    tags: ['act'],
    description: 'BT 在自己周围放出电烟幕：挡住视线，持续电击烟里的敌人，能把骑在 BT 身上的敌方铁驭电下来。有冷却。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'titanfall2_pulse',
    tags: ['act'],
    description: 'BT 以铁驭为中心放一次声纳脉冲：约 32 米内的敌人被高亮几秒，隔墙也看得见。回执列出被照到的敌人。有冷却。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'titanfall2_look',
    tags: ['read'],
    description: '看一眼游戏现在的画面(附一张截图)和关卡、目标。游戏窗口不在前台时截不到图。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'titanfall2_guide',
    tags: ['read'],
    description:
      '地图导引：当前目标的方位与距离，这一关还没拿到的铁驭头盔收集品和 BT 装备拾取物各在哪(方位、距离、高低)，BT 在哪。方位以铁驭视线为 12 点钟。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'titanfall2_mark',
    tags: ['act'],
    description: '把编号指定的敌人在铁驭视野里描边高亮，隔墙也看得见，持续几秒。有冷却。',
    parameters: {
      type: 'object',
      properties: {
        targets: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12, description: '敌人编号，如 ["E3","E7"]' },
      },
      required: ['targets'],
    },
  },
  {
    name: 'titanfall2_focus',
    tags: ['act'],
    description: '让单独作战的 BT 把指定编号的敌人当作攻击目标。铁驭在驾驶舱里时 BT 由铁驭操控，这个指令无效。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '敌人编号，如 "E3"' },
      },
      required: ['target'],
    },
  },
  {
    name: 'titanfall2_launch',
    tags: ['act'],
    description:
      '替玩家打开泰坦陨落 2:没装 Northstar 先下载安装(第一次约 107 MB,要几分钟),装好模组,EA App 没开先启动它并等它登录，在后台启动 BT 的声音，再启动游戏并切到前台。返回时游戏停在主菜单，玩家自己选「继续」或章节进入战役。游戏已经开着时只把窗口切到前台。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];
