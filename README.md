# 泰坦陨落 2 陪玩(cortico-world-titanfall2-assistant)

Owner: `src/definition.ts`

让 Coo 接入泰坦陨落 2 单人战役里的 BT:实时掌握铁驭、BT 和敌人的情报并提醒玩家，替 BT 发射多目标飞弹、放电烟幕和声纳脉冲，用游戏里的 BT 字幕和 VoxCPM2 复刻的 BT 声音说话。

```
游戏(Northstar + 本包的模组 mod/Cortico.Titanfall2Assistant)
  ├─ 服务端 VM  每 0.25 秒 POST /server:铁驭、BT、敌人、目标、事件、指令回执 ← 回包带 BT 支援指令
  └─ 客户端 VM  每 0.15 秒 POST /client:当前目标文字、本地化结果           ← 回包带字幕、待本地化的词
        ↕ 127.0.0.1:27941
引擎子进程(sidecar,src/sidecar.ts)  ↔ fork IPC ↔  Titanfall2World(src/world.ts)
```

## 要求

- Windows,Node.js 22+。
- 自备泰坦陨落 2。Steam 版要装好并登录 EA App。
- 游戏目录装好 [Northstar](https://github.com/R2Northstar/Northstar/releases)(按 v1.31.14 开发)。
- BT 语音：一个 llama.cpp-omni 运行时(`llama-tts-server.exe`,vtuber 扩展装的那个)和 VoxCPM2 模型 `VoxCPM2-BaseLM-F16.gguf`、`VoxCPM2-Acoustic-F16.gguf`;截样片要 PATH 上有 ffmpeg(需带 binka 解复用器，2021 年以后的版本都有)。

## 安装与启动

在 Cortico 里按本机目录装本扩展，启用 `worlds.titanfall2`。World 启动时：

1. 找游戏目录(`gameDir` 留空找 Steam 库),把 `mod/Cortico.Titanfall2Assistant` 复制进 `R2Northstar/mods/`,并在 `ns_startup_args.txt` 加上 `-allowlocalhttp`(Northstar 默认不许模组访问 127.0.0.1)。
2. 在 `127.0.0.1:<port>` 起 sidecar。
3. 语音开着时，从游戏的 `r2/sound` 截出样片台词，启动 VoxCPM2 服务。

游戏从「快速启动」页签启动：`NorthstarLauncher.exe -allowlocalhttp <launchArgs> +cortico_tf2_port <port>`。`launchArgs` 默认 `-noOriginStartup`:Northstar 默认去找 Origin,装的是 EA App 时会报「failed reading Origin path」。

## 工具

| 工具 | 作用 |
|---|---|
| `titanfall2_scan` | 完整情报：关卡与目标方位、铁驭、BT、支援冷却，每个敌人的编号、方位、距离、生命、在打谁、看不看得见 |
| `titanfall2_say` | BT 字幕 + BT 语音;返回时第一句已出声 |
| `titanfall2_missiles` | 向编号指定的敌人发射追踪飞弹 |
| `titanfall2_smoke` | BT 周围放电烟幕 |
| `titanfall2_pulse` | 以铁驭为中心放声纳脉冲，回执列出照到的敌人 |

方位以铁驭视线为 12 点钟;距离按 1 米 = 39.37 游戏单位换算。敌人编号(E1、E2…)跟着实体走，换关清零，60 秒没再出现的编号作废。

飞弹用 BT 装备里的多目标飞弹系统(`mp_titanweapon_shoulder_rockets`)发射：铁驭在驾驶舱里时消耗它的充能(满充能 12 枚),和玩家按键发射共用;BT 单独作战时按 `support.autoMissileCooldownSec` 冷却。没有这件装备的配装发不了。电烟幕和声纳调用游戏自己的 `Smokescreen` 与 `PulseLocation`,冷却由配置决定。

## 事件

| type | 内容 | 触发 |
|---|---|---|
| `titanfall2.state` | 游戏连上、关闭或停止上报超过 10 秒，进入新关卡，读取检查点 | flush / debounce |
| `titanfall2.alert` | 敌方泰坦、死神出现，铁驭低血量或阵亡，BT 护盾破、生命降到 50%/25%、被骑乘、濒死，交火开始 | flush / debounce |
| `titanfall2.combat` | 击杀(3 秒内合并)、敌方泰坦濒死、登机离机、核心就绪、交火结束 | debounce / piggyback |
| `titanfall2.objective` | 任务目标换了 | debounce |
| `titanfall2.snapshot` | 状态快照：投递时按最新一帧生成，只写和上一份比变了的段;120 秒出一次全量 | piggyback |

同类警报的最短间隔是 `intel.alertCooldownSec`。

## BT 的声音与字幕

样片默认是 `diag_sp_Spoke0_BE331_18_01_mcor_bt`(国语，6.2 秒):「铁驭，我已连接至你的头盔抬头显示以跟监进度。频道随时开启供你需要时使用。」`src/sample.ts` 读 `general.mbnk` 找到这条台词在 `general_<语言>.mstr` 里的位置，拼出 Bink Audio 交给 ffmpeg 解码，存成部署数据目录下的 `titanfall2-bt-sample.wav`。样片不随包分发。换样片时改 `voice.sampleAlias` 与 `voice.sampleText`(逐字稿要和音频一致),台词名和字幕见游戏的 `resource/subtitles_<语言>.dat`。

字幕用游戏头盔读数的文字 RUI(`ui/cockpit_console_text_center.rpak`)画在屏幕下方，格式同游戏字幕「BT: …」。一句话按 `subtitle.charsPerLine` 折行，两行一页;每页在它的语音开始播放时上屏，停留到语音结束。语音没就绪时只出字幕。

## 开发

```bash
corepack pnpm install
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build:webui
```

`describe.json` 用 Cortico 的 `pnpm describe:extension <本目录>` 生成。模组脚本只能在游戏里验证：改完复制进游戏(World 启动时会做),Squirrel 编译错误写在 `R2Northstar/logs/nslog*.txt`。
