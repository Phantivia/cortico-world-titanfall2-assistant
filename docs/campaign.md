# 战役关卡与起始点

Owner: `src/intel.ts`(`MAP_NAMES`)

**有剧透。** 下表给维护者对照关卡文件和测试用，不进提示词。起始点的序号就是模组上报的 `section`,也是控制台变量
`sp_startpoint` 的值：`NorthstarLauncher.exe … +sp_startpoint <序号> +map <关卡>` 直接从这一段开始。名字摘自各关卡脚本的
`AddStartPoint`,序号从 0 起;训练关和方舟里 `DEV_`、`TestBed` 之后的是开发用起始点，正常游玩到不了。

| 章 | 关卡文件 | 起始点 |
|---|---|---|
| 1 铁驭训练场 | `sp_training` | Pod Intro, Basic Movement, Zen Garden, Firing Range, Gauntlet, Gauntlet Challenge, Titanfall, Pod Outro, Meet OG, Gauntlet Mode |
| 2 BT-7274 | `sp_crashsite` | LevelStart, BT_Intro, Blisk_Intro, FamilyPhoto, Waking_Up, Field_Promotion, Grave, Battery2_Path, Battery2_Combat, Battery2_Ship, Battery3_Path, Battery3_Combat, Battery3_Ship, PilotLink |
| 3 血与锈 | `sp_sewers1` | Channel Mortar Run, Sewer Split, Sludge Falls, Corkscrew Room, Pipe Room Climb, Sewer Arena, Sewer Arena Defend, Kane Arena |
| 4 坠入深渊 | `sp_boomtown_start` | Intro, Prop House, Narrow Hallway, Titan Arena, Loading Dock |
| | `sp_boomtown` | Start, Assembly_Start, Assembly_Dirt, Assembly_Wallrun, Assembly_Furniture, Assembly_Walls, Assembly_Highway, Town_Climb_Entry, ReaperTown |
| | `sp_boomtown_end` | Intro Caves, Prowler Towers, Above The Dome, Pre Ash Fight, Ash Fight |
| 5 因果效应 | `sp_hub_timeshift` | LECTURE HALLS, OVERGROWN CAMPUS, Corpse Search, BT EXPLAINS IT ALL, Zipline, Security, Skybridge, PRISTINE CAMPUS, Hub Fight, Extended Bridge, REACTOR MELTDOWN, Core Scan, Level End |
| | `sp_timeshift_spoke02` | Timeshift Device, WILDLIFE RESEARCH, First Timeshift Fight, Elevator Fight, HUMAN RESEARCH, Sphere Room, Human Room, CAMPUS RETURN, Fan Drop, Fan Drop End |
| 6 信标 | `sp_beacon` | Level Start, Control Room, Spoke_0_Complete, Power Relays Online, Fastball to Spoke 1, Spoke 1 Start, Spoke 1 First Combat, Spoke 1 Second Combat, Spoke 1 Pillar Room, Double Crane Puzzle, Second Beacon, Spoke 1 Arena, Wallrun Panels, Back at HUB, Climb Dish, Final Battle, Send Signal, Beacon Ending |
| | `sp_beacon_spoke0` | Level Start, First Fight, Get Arc Tool, Got Arc Tool, Horizontal Fan, Horizontal Fan Complete, Fan Wallrun |
| 7 烈火试炼 | `sp_tday` | Trailer - Drop, Intro, Wall Bombardment, Militia Big Charge, Underground Fuel Storage, Elevator, VTOL, Fire on the Runway, OLA Launch |
| 8 方舟 | `sp_s2s` | Level Start, Intro, Gibraltar, Boss Intro, Widow Fall, Barker Ship, FastBall 1, Malta Intro, Malta Drone Room, Malta Guns, Malta Widow Jump, Malta Hangar, Malta Breach, Malta Bridge, Reunite with BT, Malta Deck, BT Tackle, Boss Fight, Viper Dead, Life Boats, Core Room, OLA Crash |
| 9 折叠武器 | `sp_skyway_v1` | Level Start, Torture Room B, Smart Pistol Run, Bridge Fight, BT Reunion, Titan Hill, Titan Smash Hallway, Sculptor Climb, Targeting Room, Injector Room, Blisk's Farewell, BT Sacrifice, Rising World Run, Rising World Jump, Exploding Planet, Harmony |

有的段落里玩家没有宠物泰坦(第 1 章全程，第 2 章开头，第 4 章 BT 被带走的那段):这时快照写「BT:不在这一关」,BT 的支援指令回报 BT 不在场。
