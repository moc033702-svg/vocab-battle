# 英语词汇擂台 v2

局域网 / 课堂用的**多人英语词汇对战**：一个人开房间，其他人用手机或电脑打开同一个网址加入，
同题竞速答题，实时出分、实时排行、实时公屏。一套 C++ 游戏内核，两种前端形态——**网页版**和**命令行桌面版**。

- **零依赖前端**：原生 ES 模块 + 手写 CSS，没有框架、没有构建步骤、没有 CDN、没有网络字体
- **实时**：Node 网关 + SSE 推送，选择题点完立刻看到别人提交状态
- **跨端**：一套页面同时适配电脑与手机（吸底提交按钮、安全区适配、暗色模式、减少动效）

---

## 目录结构

```
英语词汇擂台_v2/
├─ src/                  C++ 游戏内核（出题、判分、计分、赛程、存档）
├─ CMakeLists.txt        编译入口
├─ data/words.csv        词库（六级/考研/雅思/托福/GRE，每行 6 个字段）
├─ 游戏/                 桌面版发布目录（exe + bat + 词库，需自行编译生成）
└─ 网页/
   ├─ gateway/           Node 网关：HTTP 接口 + SSE 推送 + 会话/公屏/排行
   ├─ public/            前端（index.html / css / js）
   ├─ bin/               编译产出的 vocab_battle.exe（不入库）
   ├─ data/              运行时数据：words.csv + 成绩 csv（成绩不入库）
   ├─ tests/             node --test 用：协议、集成、规则、回归
   └─ tools/             音效生成脚本
```

---

## 快速开始

### 网页版（推荐）

```powershell
# 1. 先编译游戏内核（需要 CMake + MSVC 或 MinGW）
cmake -S . -B build
cmake --build build --config Release
#    把产出的 vocab_battle.exe 放到 网页\bin\

# 2. 起服务器
cd 网页
node gateway\server.js
#    浏览器打开 http://127.0.0.1:3000

# 3. 只调界面、不启服务器
#    http://127.0.0.1:3000/?mock=1   ← 假后端，自带两个机器人
```

第一个进来的人自动是房主，点右上角「分享链接」把地址发出去，至少 2 人即可开赛。

### 桌面版

```powershell
cmake -S . -B build && cmake --build build --config Release
# 或 MinGW：
g++ -std=c++17 -O2 -o vocab_battle.exe src/*.cpp -lws2_32 -static
```

把 exe 和 `data/words.csv` 一起放进 `游戏/`，双击 `启动服务器.bat` 与 `启动客户端.bat`。
局域网内服务器每秒 UDP 广播 `VOCAB_SERVER <端口>`，客户端 `auto` 会自动发现。

> MinGW 的 make 不支持中文路径，请在纯英文路径下构建。

---

## 技术要点

**三层结构**：浏览器 ←SSE→ Node 网关 ←TCP 行协议→ C++ 游戏服务器。
C++ 只给每个玩家发他自己的 `RESULT`，不广播；名单、分数、排行由网关按昵称自己攒。

**整屏重建**：前端每收到一份视图就重建整个屏幕，靠 `#app[data-same]`
（换屏/换轮为 0，同屏刷新为 1）来决定入场动画只播一次——这是不闪屏的关键。

**五条铁律**（改代码前请读 `网页/交接书.md`）：不删 `data-same` 那条 CSS、文本一律走 `textContent`、
不改钩子名、不加任何依赖、入场动画用 `fill-mode: backwards`。

---

## 文档

| 文件 | 内容 |
|---|---|
| `网页/交接书.md` | 代码结构、DOM 钩子、铁律、改动记录（**接手先读这个**） |
| `网页/使用说明.md` | 老师怎么开一局、学生怎么答题、常见问题 |
| `网页/部署方法说明.md` | 上线、反代（SSE 必须关缓冲）、更新、排错 |
| `网页/第三轮美化方案.md` | 视觉规范：设计令牌、对比度对照表、逐条改法 |

---

## v2 相对 v1 补全的功能

| 功能 | 位置 |
|---|---|
| 局域网自动发现：服务器每秒 UDP 广播 `VOCAB_SERVER <端口>`，`client auto` 监听 3 秒并列出可选服务器，无则手动输 IP | net.cpp `udp_*`、server `broadcastLoop`、client `discoverServer` |
| 新题型 `zh2en_mcq`（中译英选择，干扰项为形近词）；`mcq` 更名为"英译中选择" | protocol.h、game.cpp |
| 词库第 5 字段「近义词释义」，用作 mcq 干扰项 | word_bank.*、game.cpp |
| 选择题支持 1/2/3/4；英译中填空支持释义片段（≥2 字）判对 | game.cpp `checkAnswer` |
| 房主/客人身份（`ROLE`）；客人输入任意内容 → `NUDGE` 催促房主 | server/client |
| 开局参数第 4 项：每轮结束后停顿秒数（0~10） | server `pauseAfterRound` |
| 再来一局：赛后 `RESTART`，分数重置、玩家保留；房主输入 `exit` 关服（`EXIT`） | server `run`、game `resetForRematch` |
| 比赛中拒绝新玩家，赛后大厅可新玩家加入；房主重连保持房主 | server `handleClient` |
| 抢答即时判分（`BUZZ_OK` / `BUZZ_NO`）、每轮题型全场统一、比赛中断线 5 秒判退出 | server.cpp、gateway/ |
| 房间公屏、错题本、静音、战绩抽屉、胜负反馈音效 | `网页/public/js/` |

---

课堂自用项目。词库与音效为自制/合成素材。
