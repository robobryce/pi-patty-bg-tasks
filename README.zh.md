# pi-patty-bg-tasks

<p align="center">
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <strong>中文</strong>
</p>

<p align="center">
  <strong>长命令不该卡住你的代理 —— 自动甩进后台,代理不停手,代码一路往前发。</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-patty-bg-tasks"><img alt="npm" src="https://img.shields.io/npm/v/pi-patty-bg-tasks?color=cb3837&label=npm&logo=npm"></a>&nbsp;
  <img alt="Pi v0.37+" src="https://img.shields.io/badge/Pi-v0.37%2B-5b50f0">&nbsp;
  <img alt="dependencies: zero" src="https://img.shields.io/badge/dependencies-zero-3fb950">&nbsp;
  <img alt="tmux: not required" src="https://img.shields.io/badge/tmux-not_required-3fb950">&nbsp;
  <img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-blue">
</p>

**构建还在跑,代理不该干等着。** 这就是 Claude Code 的后台任务体验,如今搬到了 Pi 上:扔出一条长命令,它不会卡住整个会话,而是悄悄溜到后台,代理则继续埋头干活。120 秒自动转后台、Ctrl+B 一键秒转、输出全程捕获、卡顿自动检测,外加一个功能齐全的作业管理器 —— 全都打包进一个扩展里。

## 安装

```
pi install npm:pi-patty-bg-tasks
```

或者直接从 GitHub 装:

```
pi install git:github.com/patty-io/pi-patty-bg-tasks
```

只需 Pi v0.37+,要求仅此一条 —— **零外部依赖**,也**不用 tmux**。后台作业就是普通的 Node.js 子进程,输出直接写进一个文件描述符。没什么要装的,也没什么要盯着的。

## 为什么你会想要它

**会话卡死,到此为止。** 开发服务器、测试套件、构建 —— 任何跑过 120 秒还没完事的命令,都会被悄悄挪到后台。代理收到提醒,转头就去干下一件事,而不是盯着转圈圈的进度条发呆。想让它早点滚到后台?随时手动一推就行。

**用起来像 Claude Code,因为它就是照着 Claude Code 做的。** 前后台来回切换的这一整套动作 —— Ctrl+B 转后台、输出捕获、完成提醒、卡顿检测 —— 全都直接建在 Claude Code 的实现之上。一样的消息格式,一样的终端原生图标,一样「代理永不停手」的节奏。要是你早已练出肌肉记忆,那这里照样能用。

**一个像样的作业管理器,而不是临时凑数。** `/bg-list` 打开一个交互式作业管理器:列出作业、瞄一眼输出、干掉跑飞的、或者挂上去等结果,样样都行。

## 快速开始

```
# 代理跑一条长命令 —— 120 秒后自动转后台
bash({ command: "npm run build" })

# 不想等?一上来就丢进后台
bash({ command: "npm run dev", run_in_background: true })

# 或者扔了就不管,直接进后台
bash_bg({ command: "npm run dev", name: "devserver" })

# 看看现在有啥在跑
jobs({ action: "list" })

# 一次性在所有作业的输出里 grep
jobs({ action: "search", pattern: "error|warning" })

# 把整个任务甩给一个后台代理
agent_bg({ prompt: "重构 auth 模块" })
```

命令在跑的时候,随手按下 **Ctrl+B**,它就地转入后台 —— 命令跑过几秒后,输入框下方会浮现一行淡淡的 `(ctrl+b to run in background)` 提示。代理收到通知,你手还没从键盘上松开,它已经回去接着干了。

## 工具

### bash(覆盖)

内置的 bash 工具,但多了点求生本能。命令照常运行 —— 可一旦某条冲破 120 秒,它就自动转入后台,并通过 `job_decide` 问代理下一步怎么办:留着、杀掉,还是先看看输出。

| 参数 | 说明 |
|------|------|
| `command` | 要运行的 shell 命令 |
| `timeout` | 自定义超时(秒,默认:120) |
| `run_in_background` | 跳过前台运行和自动后台计时器,立即在后台启动命令 |

### bash_bg

当你心里有数,知道这是个慢活儿。命令直接在后台启动 —— 没有前台竞速,也不用干等超时。

| 参数 | 说明 |
|------|------|
| `command` | 要运行的 shell 命令 |
| `name` | 可选的可读作业标签 |
| `timeout` | 可选超时(秒);触发同一套自动后台决策流程 |
| `notify` | 发送完成通知(默认:true) |

### jobs

后台一切的指挥中心:列表、读输出、终止、挂上去等、搜索、清理,或者拉一份统计。

| 操作 | 说明 |
|------|------|
| `list` | 显示所有运行中和最近完成的作业 |
| `output` | 读取某个作业的日志尾部 |
| `kill` | 终止运行中的作业 |
| `attach` | 等作业完成后返回它的输出 |
| `search` | 在所有作业日志里做正则搜索 |
| `cleanup` | 清除已完成/失败的作业,回收磁盘空间 |
| `stats` | 聚合指标:总启动数、运行中、已完成、失败、平均时长 |

### job_decide

代理对自动转后台命令的回应。120 秒计时器一响,这条提示就送到代理面前。

| 参数 | 说明 |
|------|------|
| `jobId` | 后台作业的 ID |
| `decision` | `keep`(继续跑)、`kill`(终止)或 `check`(先看输出) |

### agent_bg

给自己克隆一个搭档。它会拉起一个分离的 `pi -p` 进程,带上从当前会话派生的连续性提示,然后把进度实时回传给你。

| 参数 | 说明 |
|------|------|
| `prompt` | 后台代理的任务描述 |
| `cwd` | 工作目录(默认:当前) |

### monitor

流式推送事件,而不是只等一次。`bash_bg`/`run_in_background` 在完成时通知**一次**,而 `monitor` 把进程变成**实时事件流**——每一行 stdout(或每个 WebSocket 帧)都会变成一条通知,直接送进代理的回合,代理则继续干活。这是 Claude Code 一分为二中的“流式”那一半:一次性的“完成时告诉我”交给 `run_in_background`,逐事件的“每次发生 X 都告诉我”交给 `monitor`。

```js
// 持续通知每一行错误
monitor({ command: "tail -f deploy.log | grep --line-buffered -E 'ERROR|Traceback'", description: "deploy.log 中的错误" })

// 每个 CI 检查到达时推送一条,运行结束时退出
monitor({ command: "…会退出的轮询循环…", description: "PR 123 的 CI 检查" })

// 订阅 WebSocket 数据流——每个文本帧即一个事件
monitor({ ws: { url: "wss://events.example.com/stream" }, description: "部署事件", persistent: true })
```

| 参数 | 说明 |
|------|------|
| `command` | Shell 脚本;每行 stdout 即一个事件。与 `ws` 互斥。 |
| `ws` | WebSocket 源 `{ url, protocols? }`;每个文本帧即一个事件。与 `command` 互斥。 |
| `description` | 显示在每条通知上(请写得具体)。**必填。** |
| `persistent` | 运行整个会话(无超时);用 `jobs action='kill'` 停止。默认 `false`。 |
| `timeout_ms` | 终止该监视的截止时间(默认 `300000`,最大 `3600000`)。`persistent` 时忽略。 |

监视器与后台工具共享同一套作业注册表、侧边栏(以 `◉` 标记)和 `jobs` 管理器——只有 stdout 是事件流(stderr 会捕获到单独的 `.err` 文件),输出按行缓冲,所以请用 `grep --line-buffered`/`awk fflush()`,**绝不要**用 `head`。一个疯狂刷事件的监视器会被自动停止,你可以用更严格的过滤器重新启动。`ws` 源需要带有全局 `WebSocket` 的运行时(Node 22+),否则请改用 `websocat` 之类的 `command`。

> **持久监视器与磁盘:** 非 `persistent` 监视器的输出日志有上限(输出过大时会被终止)。但 `persistent` 监视器本就预期跑满整个会话,因此其日志**不**做大小限制——让长期运行的 `tail -f` 对准经过过滤的流而不是 firehose,用完后用 `jobs action='kill'` 停止。

## 键盘快捷键

手别离开键盘。

| 快捷键 | 操作 |
|-------|------|
| **Ctrl+B** | 把正在运行的前台命令转后台 —— 代理继续干活(对应 Claude Code)。在 tmux 里要按两下(tmux 占用了 Ctrl+B)。 |
| **Ctrl+Shift+B** | 等同 Ctrl+B(别名) |
| **Ctrl+Shift+J** | 打开后台作业管理器 |
| **Shift+Down** | 打开后台作业管理器 |
| **Ctrl+Shift+X** | 终止最近一个运行中的作业 |

## 命令

更喜欢斜杠命令?同样的本事,换个入口而已。

| 命令 | 说明 |
|------|------|
| `/bg` | 把当前进程转后台(等同 Ctrl+B) |
| `/bg-list` | 打开交互式后台作业管理器 |
| `/bg-version` | 显示已加载扩展的版本/路径,方便排查重载问题 |

## 工作原理

没什么魔法,就是一台干净利落的状态机:

```
命令启动(直接 Node.js child_process.spawn)
  → 2 秒内完成?          立即返回结果
  → 120 秒还在跑?        自动转后台 → 代理收到 job_decide 提示
  → 你按了 Ctrl+B?        立即转后台 → 代理继续

后台作业运行中
  → 输出经由文件描述符捕获到 /tmp/pi-bg/<id>.log
  → 卡顿检测:输出看起来像交互式提示时,警告代理
  → 超量检测:输出冲破上限时,直接终止作业
  → 完成时:代理收到通知,附带状态 + 输出路径
```

后台作业以分离的 Node.js 子进程运行,stdout/stderr 直接接到一个日志文件描述符上 ——
跟 Claude Code 的做法分毫不差。没有 tmux,没有外部进程管理器,你的命令和它的日志
之间什么都不隔。最多 **16 个**后台作业同时跑;想塞第 17 个?会被客气地挡回去,直到
腾出空位。超过 24 小时的旧日志会在会话启动时清扫干净,免得 `/tmp` 沦为杂物堆。

## 协作式转向(对齐 Claude Code)

前台正跑着一条可转后台的命令时,你打了一条消息 —— 扩展会在 Pi 把它排进转向队列**之前**就先一步介入:

1. 正在跑的前台命令滑入后台(输出继续捕获 —— 一点不丢)。
2. 当前的代理轮次被中断。
3. 代理一空闲,你的消息就作为一个全新的用户轮次重新注入。

这正是 Claude Code 的行为:在可中断的工具运行期间提交输入,会中断该工具并开启新一轮,而不是把你的消息晾在长任务后面排队。不轮询,也不必干等下一轮。

**适用范围:** 这只对本扩展接管的 `bash` 工具生效。扩展没有包裹的其他长任务工具,会回退到 Pi 原生的转向机制(排队,在下一个轮次边界投递)。

## 状态栏

一个实时的胶囊小组件让运行中的作业始终在你眼前 —— 每个都带着已运行时长和命令预览。完成数和失败数也一并显示在状态行里。想看全貌时,Shift+Down 或 `/bg-list` 打开作业管理器。

## 版本发布

### 1.1.1 —— 对齐修复、防数据丢失、实时进度

- **侧边栏实时进度。** 运行中作业的标签现在显示其**最新输出行**(每秒刷新),而不只是命令——长轮询/构建的进度一目了然(`◉ qdrant: {"indexed":8540629,"status":"grey"} (2m10s)`)。ANSI/控制序列会被剥离,保持组件整洁且无法被转义注入。
- **不再有滞留的 `sleep` 作业。** 朴素的 `sleep N` 等待(即使是嵌入式的——`cd x; sleep 600; check`、换行分隔、或后台运行)现在在 `bash` 与 `bash_bg` 两侧都会被拦截,并引导到会随工作一起结束的工具:`jobs attach`、`monitor` 工具,或会在就绪时退出的 `until` 循环。真正轮询循环内部的 sleep 绝不会被误拦。
- **取消行为对齐 Claude Code(已对照 CC 源码验证)。** 按 **Esc** 会杀掉正在运行的前台命令(一次有意的取消),而输入新消息、**Ctrl+B** 或自动后台超时则改为把它移到后台——正是 CC 的 `user-cancel` 与 `interrupt` 之分。长任务靠超时自动后台 + `run_in_background` 来保护,而不是忽略取消。

### 1.1.0 —— monitor 工具 & 合并完成通知

- **新增 `monitor` 工具** —— Claude Code 一分为二中的“流式”那一半:每一行 stdout(或每个 WebSocket 帧)在发生时即变成一条通知。用于逐事件的数据流(`tail -f | grep`、轮询循环、文件监视、ws 数据流),而一次性的“完成时告诉我”仍交给 `run_in_background`。支持 `command`/`ws` 源、`persistent` 监视、`timeout_ms` 截止时间、按行精确跟随,以及刷屏时自动停止。在侧边栏和 `jobs` 管理器中以 `◉` 标记显示。
- **不再有 `[job-finished]` 的刷屏** —— 一批后台作业同时完成时,现在会合并成一条汇总通知,而不是在你下一条消息后堆出一行行陈旧的提示。
- 内部:将 `MonitorSession` 抽取到 `MonitorSource` 接缝之后(command + ws 适配器),使流式/终止生命周期可被单元测试。零新增依赖(ws 使用运行时的全局 `WebSocket`,Node 22+)。

### 1.0.2 —— Ctrl+B 对齐 & 更友好的 jobs

- 现在 **Ctrl+B** 是主后台快捷键(Ctrl+Shift+B 保留为别名),命令运行时输入框下方会浮现一行 `(ctrl+b to run in background)` 提示,与 Claude Code 一致。在 tmux 里会附上"(twice)"说明。
- **`jobs attach` 在等待时会流式输出作业的实时日志**(以前是静默的),文案也改成了"Following … live output";中途分离后作业继续在后台运行。
- **侧边栏胶囊实时跳动** —— 时长每秒更新,不再停在绘制时的那一刻。
- 作业完成/超时通知更**紧凑**了(一行代理 follow-up + 一个 UI 提示),让代理持续知情,又不刷屏。

### 1.0.1 —— 对齐 Claude Code(首个发布的 1.x)

重头戏。后台引擎从头到尾重写了一遍,对齐 Claude Code 的架构,零外部依赖。这是 npm 上的第一个 1.x,把这次对齐重写连同一整轮扎实的正确性、性能强化一并奉上。

**重大变更**
- **移除了 tmux。** 后台作业现在以直接的 Node.js `child_process.spawn` 进程运行,用文件描述符捕获输出。tmux 不再使用、也不再需要 —— 没有什么要装的了。
- **默认自动转后台超时现在是 120 秒**(原为 15 秒),与 Claude Code 看齐。想覆盖就显式传一个 `timeout`。
- 后台日志从 `/tmp/pi-bg-<id>.log` 挪到了专用目录 `/tmp/pi-bg/<id>.log`。

**亮点**
- `bash` 工具新增 `run_in_background: true` 参数。
- `agent_bg` 现在实时流式回传进度,并会解析 `pi` 二进制路径(就算装在非标准 `$PATH` 下也照样能用)。
- 协作式转向把你的消息作为一个 follow-up 轮次投递 —— 没有轮询循环。
- 后台作业并发上限为 16。
- 代码与 UI 全部改为纯英文。

**修复与内部改进(重写后强化)**
- 协作式转向不再杀掉它刚刚转入后台的那条命令。
- 生成失败(`ENOENT`/`EMFILE`/`EAGAIN`)会被妥善处理,而不是把代理拖崩。
- 会话恢复只复活当前进程的作业 —— 绝不向可能已被回收的 PID 发信号。
- 四条生成路径统一收拢进单个 `startBackgroundJob` 服务函数;前台清理移进 `finally`,任何退出路径都不会遗留作业。
- 日志搜索在各作业间并发执行,旧日志清扫也改成了有界异步。

### 0.3.1 及更早

基于 tmux 的后台作业、15 秒自动转后台、协作式转向,以及交互式作业管理器。

## 开发

```
git clone https://github.com/patty-io/pi-patty-bg-tasks.git
cd pi-patty-bg-tasks
pnpm install
pnpm check    # 类型检查
pnpm test     # 运行测试
```

需要 Node.js ≥ 22、pnpm ≥ 10。无需 tmux,也没有别的外部依赖 —— 你 clone 下来的就是你跑起来的。

## 贡献

欢迎提 PR。流程如下:

1. Fork 仓库
2. 建一个功能分支(`git checkout -b feat/my-feature`)
3. 确保 `pnpm check` 和 `pnpm test` 都通过
4. 用 [Conventional Commits](https://www.conventionalcommits.org/) 提交
5. 向 `main` 提 PR

## 许可证

[MIT](LICENSE) © Patty

## 作者

**Patty** · [GitHub](https://github.com/patty-io)
