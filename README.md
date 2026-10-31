# 泰坦陨落 2 陪玩(cortico-world-titanfall2-assistant)

Owner: `src/definition.ts`

让 Coo 接入泰坦陨落 2 单人战役里的 BT,具体能做这些事：
- 实时掌握铁驭、BT 和敌人的情报并提醒玩家。
- 跟着剧情台词和游戏画面走。
- 给出地图导引：目标点、头盔收集品、BT 装备、电池。
- 替 BT 出手：多目标飞弹、电烟幕、声纳、隔墙标记、集火。
- 说话时显示游戏里 BT 的字幕，用 VoxCPM2 复刻的 BT 声音念出来。

```
游戏(Northstar + 本包的模组 mod/Cortico.Titanfall2Assistant)
  ├─ 服务端 VM  每 0.25 秒 POST /server:铁驭、BT、敌人、目标、段落、收集品、事件、指令回执 ← 回包带 BT 支援指令
  └─ 客户端 VM  每 0.15 秒 POST /client:当前目标文字、刚播放的台词、本地化结果   ← 回包带字幕、待本地化的词
        ↕ 127.0.0.1:27941
引擎子进程(sidecar,src/sidecar.ts;截游戏画面也在这里)  ↔ fork IPC ↔  Titanfall2World(src/world.ts)
```

## 要求

- Windows,Node.js 22+。
- 自备泰坦陨落 2,装好并登录 EA App(Steam 版也通过它登录)。
- [Northstar](https://github.com/R2Northstar/Northstar/releases):没装时一键开始会下载 v1.31.14 装进游戏目录。
- BT 语音要 NVIDIA 显卡和两样文件，缺了面板上可以下载(共约 5.6 GB),放在 vtuber 扩展用的同一位置，两个扩展共用：
  - llama.cpp-omni 运行时(`llama-tts-server.exe`),装在 `<运行时根>/llama.cpp-omni/`。
  - VoxCPM2 模型文件 `VoxCPM2-BaseLM-F16.gguf` 和 `VoxCPM2-Acoustic-F16.gguf`,在 `<模型根>/vtuber/`。
- 截样片要 PATH 上有 ffmpeg,版本需带 binka 解复用器(2021 年以后的版本都有)。

## 安装与启动

装好本扩展，启用 `worlds.titanfall2`。World 启动时做这几件事：

1. 找到游戏目录。`gameDir` 留空时找 Steam 库。
2. 把 `mod/Cortico.Titanfall2Assistant` 复制进 `R2Northstar/mods/`,并在 `ns_startup_args.txt` 加上 `-allowlocalhttp`(Northstar 默认不许模组访问 127.0.0.1)。
3. 从游戏自己的 VPK 读出 `sp/sh_sp_dialogue.gnut`,在台词播放处插入上报钩子，写进模组目录作覆盖文件。见下文「剧情」。
4. 在 `127.0.0.1:<port>` 起 sidecar。

开始玩用「快速启动」页签的「一键开始」,或让 Coo 打开游戏(`titanfall2_launch`),两者走同一套流程(`src/play.ts`):

1. 游戏目录里没有 Northstar 时，下载 v1.31.14 解到游戏目录。
2. 安装或更新模组。
3. EA App 没在运行时先启动它，等它的 LSX 端口(127.0.0.1:3216)打开后再等 15 秒让它登录。
4. 在后台启动 BT 语音：从游戏的 `r2/sound` 截出样片台词，启动 VoxCPM2 服务。
5. 把「画面与切窗」页签的显示模式和分辨率写进游戏的 `videoconfig.txt`。
6. 用 `NorthstarLauncher.exe -allowlocalhttp <参数> +cortico_tf2_port <port>` 启动游戏，窗口出现后恢复并切到前台。游戏停在主菜单，玩家选「继续」或「任务选择」进入战役。

「画面与切窗」页签(配置项 `display.*`、`focus.*`、`launchArgs`)管这些，启动命令的预览也在这一页：
- 显示模式：无边框窗口(默认)、窗口、全屏、保持游戏里的设置。
  - 游戏的独占全屏会盖住桌宠这类置顶窗口;无边框窗口铺满屏幕，桌宠显示在游戏上面。
  - 无边框窗口要两样都有：`videoconfig.txt` 里 `setting.fullscreen` 为 0、`setting.nowindowborder` 为 1,以及启动参数 `-noborder`(只改文件游戏仍会画边框)。
  - 分辨率留空时，无边框和全屏用主屏分辨率，窗口保持游戏里的大小。混合显卡笔记本上独占全屏的分辨率列表可能来自外接屏，所以列不出主屏的分辨率;无边框窗口不受这个限制。
  - `videoconfig.txt` 在「文档」外壳文件夹(注册表 User Shell Folders 的 Personal,可能不在 C 盘)的 `Respawn\Titanfall2\local\` 下。游戏退出时会把它写回去，所以只在游戏没运行时改。
- 切到别的窗口时：单人战役默认会暂停、降帧、静音。「继续运行」加 `+sp_not_focus_pause 0 +not_focus_sleep 0`,让玩家在桌宠里打字时 BT 仍能出手和说话;「保留游戏声音」传 `+sound_without_focus 1` 或 `0`,这一项存进游戏的 profile。
- 其他启动参数：默认 `-noOriginStartup -novid`。Northstar 默认去找 Origin,本机只有 EA App 时会报「failed reading Origin path」,所以加 `-noOriginStartup`。

几点说明：
- EA App 没登录完游戏就会弹出 `#ORIGIN_LOGGED_OUT`,点确定后退出;游戏在启动 90 秒内没进关卡就退出时，面板写明这个原因。
- BT 语音不随 World 启动：一键开始或有关卡连上时才启动，World 开着不玩游戏时不占显存。
- 暂停菜单、读图和过场时模组不上报;停止上报超过 10 秒，World 会推一条状态事件。

## 工具

| 工具 | 作用 |
|---|---|
| `titanfall2_scan` | 完整情报：关卡与目标方位、铁驭、BT、支援冷却，每个敌人的编号、方位、距离、生命、在打谁、看不看得见，附近飞来的敌方弹药 |
| `titanfall2_look` | 游戏现在的画面(截图)与关卡、目标 |
| `titanfall2_guide` | 地图导引：目标点，这一关还没拿到的铁驭头盔，BT 装备拾取物，地上的泰坦电池，BT 的位置 |
| `titanfall2_say` | BT 字幕 + BT 语音;返回时第一句已出声 |
| `titanfall2_missiles` | 向编号指定的敌人发射追踪飞弹 |
| `titanfall2_smoke` | BT 周围放电烟幕 |
| `titanfall2_pulse` | 以铁驭为中心放声纳脉冲，回执列出照到的敌人 |
| `titanfall2_mark` | 把指定敌人对铁驭隔墙描边高亮 `support.markSec` 秒 |
| `titanfall2_focus` | 铁驭步行时让 BT 把指定敌人当攻击目标 |
| `titanfall2_launch` | 一键开始：按需装 Northstar 与模组、启动 EA App 和 BT 语音，打开游戏并切到前台 |

几项约定：
- 方位以铁驭视线为 12 点钟;距离按 1 米 = 39.37 游戏单位换算。
- 敌人编号(E1、E2…)跟着实体走，换关清零，60 秒没再出现的编号作废。
- 游戏本地化的文字(武器、敌人、目标、台词)在 `story.simplified` 开着时转成简体。

飞弹用 BT 装备里的多目标飞弹系统(`mp_titanweapon_shoulder_rockets`)发射：
- 铁驭在驾驶舱里时，消耗这件装备的充能(满充能 12 枚),和玩家按键发射共用。
- BT 单独作战时，按 `support.autoMissileCooldownSec` 冷却。
- 没有这件装备的配装发不了。

其余几项支援都调用游戏自己的函数，冷却由配置决定：
- 电烟幕：`Smokescreen`。
- 声纳：`PulseLocation`。
- 标记：`SonarStart` / `SonarEnd`。
- 集火：`SetEnemy`。

## 事件

| type | 内容 | 触发 |
|---|---|---|
| `titanfall2.state` | 游戏连上、关闭或停止上报超过 10 秒，进入新关卡，读取检查点 | flush / debounce |
| `titanfall2.alert` | 敌方泰坦、死神出现，铁驭低血量、阵亡或弹药见底，BT 护盾破、生命降到 50%/25%、被骑乘、濒死，交火开始 | flush / debounce |
| `titanfall2.combat` | 击杀(3 秒内合并，用泰坦武器打死的记在 BT 名下)、敌方泰坦濒死、登机离机、核心就绪、交火结束 | debounce / piggyback |
| `titanfall2.story` | 剧情台词(说话人与字幕原文)、推进到关卡的下一段 | debounce / piggyback |
| `titanfall2.guide` | 走近还没拿到的头盔，BT 残血时附近有电池 | piggyback / debounce |
| `titanfall2.objective` | 任务目标换了，附目标点方位 | debounce |
| `titanfall2.snapshot` | 状态快照：投递时按最新一帧生成，只写和上一份比变了的段;120 秒出一次全量 | piggyback |

同类警报的最短间隔是 `intel.alertCooldownSec`。

## 剧情

单人战役的台词几乎都经过游戏的 `sp/sh_sp_dialogue.gnut` 播放：
- 原版脚本里 772 处台词调用走这套系统，直接播放的只有 47 处。
- 这个脚本在客户端有 5 处按变量播放台词音频，World 在每处前面插一行 `CorticoTF2_OnDialogue( 台词名, 说话者 )`,其余原样不动。
- 插好钩子的脚本按 Northstar 的同路径覆盖规则装进模组目录。
- 脚本来自玩家自己的游戏文件，本包不含任何游戏脚本;读 VPK 用的是 `vendor/tf2lzham` 的 WebAssembly(重生改过的 LZHAM alpha8)。

台词文字查 `resource/subtitles_<story.language>.dat`(VCCD,键是小写台词名的 CRC32)。剧情事件的处理方式：
- 先进缓冲，挂一条 `pushDeferred`。
- 投递时取出缓冲里的全部台词，必要时当场截一张游戏画面附上。
- 画面每 `story.frameSec` 秒最多附一张，换关、换目标、进入新段落后的下一条剧情必附。
- 模型不收图时不附。

段落是关卡当前起始点的序号(`GetCurrentStartPointIndex()`),随检查点推进而变。起始点的名字会透露接下来的剧情，所以只报序号。各关卡的起始点见 [docs/campaign.md](docs/campaign.md)。

## 画面

截图在引擎子进程里用 koffi 读屏幕上游戏窗口客户区的位置：
- 游戏是 DirectX 11,`PrintWindow` 读出来是黑屏或旧画面，所以只读屏幕。
- 只有游戏在前台时能截到。
- 挡在游戏上面的窗口(桌宠、浮层)也会被截进去。
- 游戏在读图或黑屏时不附图。

## BT 的声音与字幕

样片默认是 `diag_sp_Spoke0_BE331_18_01_mcor_bt`,国语，6.2 秒，原文是「铁驭，我已连接至你的头盔抬头显示以跟监进度。频道随时开启供你需要时使用。」

截取方式：`src/sample.ts` 读 `general.mbnk`,找到这条台词在 `general_<语言>.mstr` 里的位置，拼出 Bink Audio 交给 ffmpeg 解码，存成部署数据目录下的 `titanfall2-bt-sample.wav`。样片不随包分发。

要换样片，改 `voice.sampleAlias` 和 `voice.sampleText`,逐字稿要和音频一致。

字幕的画法：
- 用游戏头盔读数的文字 RUI(`ui/cockpit_console_text_center.rpak`)画在屏幕上方。
- 背后用 `ui/screen_fade.rpak` 在只覆盖文字块的平面上画半透明底框，和游戏自己的字幕一样，格式也是「BT: …」。
- 繁中版游戏的中文字体只有繁体字，所以 `subtitle.traditional` 开着时字幕先转成繁体。

字幕的节奏：
- 一句话按 `subtitle.charsPerLine` 折行。第一页只放一行，合成快、开口早;之后两行一页，在前一页播放时合成。
- 每页在它的语音开始播放时上屏，停留到语音结束。
- 语音没就绪时只出字幕。
- `titanfall2_say` 在第一页出声时返回。Cortico 按顺序执行同一次回复里的工具调用，所以紧跟在它后面的调用(比如桌宠气泡)和 BT 开口同时发生。
- 游戏暂停或读图时字幕送不进去，声音照样播出;回执写明这句已经说出口，免得 Coo 重说。

## 开发

```bash
corepack pnpm install
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build:webui
```

`describe.json` 用 Cortico 的 `pnpm describe:extension <本目录>` 生成。

模组脚本只能在游戏里验证：改完复制进游戏(World 启动时会做),Squirrel 编译错误写在 `R2Northstar/logs/nslog*.txt`。运行时出错的读数不会中断上报，错误文本随帧送到 World,记进运行日志。
