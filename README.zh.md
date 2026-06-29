# pi-patty-bg-tasks

<p align="center">
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <strong>中文</strong>
</p>

**将 Claude Code 的后台任务体验带到 Pi。** 长时间运行的命令不会阻塞代理 — 120秒后自动后台运行，Ctrl+Shift+B 手动后台，输出捕获，卡顿检测，完整的作业管理器。

## 安装

```
pi install npm:pi-patty-bg-tasks
```

或从 GitHub 安装：

```
pi install git:github.com/patty-io/pi-patty-bg-tasks
```

需要 Pi v0.37+。无外部依赖 — 后台作业以使用文件描述符输出捕获的 Node.js 子进程直接运行。

## v1.0 重大变更

- **移除 tmux 依赖。** 后台作业现在以使用文件描述符输出捕获的 Node.js `child_process.spawn` 进程直接运行（与 Claude Code 一致）。不再使用或需要 tmux — 无需安装任何东西。
- **默认自动后台超时现为 120秒**（原为15秒），与 Claude Code 一致。如需覆盖，请传入显式的 `timeout`。

## 为什么选择 pi-patty-bg-tasks

**不再阻塞会话。** 开发服务器、测试套件、构建 — 任何运行超过120秒的命令都会自动后台运行。代理收到通知后立即继续工作。你也可以随时手动将命令放到后台。

**Pi 上的 Claude Code 行为。** Ctrl+B 后台运行、输出捕获、完成通知、卡顿检测 — 直接以 Claude Code 的实现为蓝本。相同的消息格式、终端原生图标、"代理继续工作"流程。

**内置作业管理器。** `/bg-list` 打开交互式作业管理器。列出、查看输出、终止或等待任何后台作业完成。

## 快速开始

```
# 代理运行长命令 — 120秒后自动后台
bash({ command: "npm run build" })

# 使用 run_in_background 从一开始就在后台启动
bash({ command: "npm run dev", run_in_background: true })

# 立即在后台启动
bash_bg({ command: "npm run dev", name: "devserver" })

# 查看后台作业
jobs({ action: "list" })

# 搜索所有作业输出
jobs({ action: "search", pattern: "error|warning" })

# 生成后台代理
agent_bg({ prompt: "重构 auth 模块" })
```

随时按 **Ctrl+Shift+B** 将运行中的命令后台化。代理收到通知后立即继续工作。

## 工具

### bash（覆盖）

扩展内置 bash 工具。命令正常运行，但如果超过120秒，会自动后台运行并通过 `job_decide` 提示代理决定（保持、终止或检查输出）。

| 参数 | 说明 |
|------|------|
| `command` | 要运行的 shell 命令 |
| `timeout` | 自定义超时（秒，默认：120） |
| `run_in_background` | 跳过前台运行和自动后台计时器，立即在后台启动命令 |

### bash_bg

立即在后台启动命令 — 无前台竞争或超时。

| 参数 | 说明 |
|------|------|
| `command` | 要运行的 shell 命令 |
| `name` | 可选的可读作业标签 |
| `timeout` | 可选超时（秒）；触发相同的自动后台决策流程 |
| `notify` | 发送完成通知（默认：true） |

### jobs

管理后台作业：列表、读取输出、终止、等待、搜索、清理或获取统计。

| 操作 | 说明 |
|------|------|
| `list` | 显示所有运行中和最近完成的作业 |
| `output` | 读取特定作业的日志尾部 |
| `kill` | 终止运行中的作业 |
| `attach` | 等待作业完成后返回输出 |
| `search` | 在所有作业日志中进行正则搜索 |
| `cleanup` | 清除已完成/失败的作业并回收磁盘空间 |
| `stats` | 聚合指标：总启动数、运行中、已完成、失败、平均持续时间 |

### job_decide

响应自动后台化的命令。120秒计时器触发时代理会收到此提示。

| 参数 | 说明 |
|------|------|
| `jobId` | 后台作业的 ID |
| `decision` | `keep`（继续运行）、`kill`（终止）或 `check`（先检查输出） |

### agent_bg

使用从当前会话派生的连续性提示生成一个分离的 `pi -p` 进程。

| 参数 | 说明 |
|------|------|
| `prompt` | 后台代理的任务描述 |
| `cwd` | 工作目录（默认：当前） |

## 键盘快捷键

| 快捷键 | 操作 |
|-------|------|
| **Ctrl+Shift+B** | 后台运行当前进程 — 代理立即继续工作（与 Claude Code Ctrl+B 相同） |
| **Ctrl+Shift+J** | 打开后台作业管理器 |
| **Shift+Down** | 打开后台作业管理器 |
| **Ctrl+Shift+X** | 终止最近启动的运行中作业 |

## 命令

| 命令 | 说明 |
|------|------|
| `/bg` | 后台运行当前进程（与 Ctrl+Shift+B 相同） |
| `/bg-list` | 打开交互式后台作业管理器 |

## 工作原理

```
命令启动（Node.js child_process.spawn 直接运行）
  → 2秒内完成？           立即返回结果
  → 120秒仍在运行？       自动后台 → 代理收到 job_decide 提示
  → 用户按 Ctrl+Shift+B？  立即后台 → 代理继续

后台作业运行中
  → 通过文件描述符将输出捕获到 /tmp/pi-bg-<id>.log
  → 卡顿检测：如果输出看起来像交互式提示，警告代理
  → 超大输出检测：超过限制时终止作业
  → 完成时：代理收到状态 + 输出路径通知
```

后台作业以分离的 Node.js 子进程运行，其 stdout/stderr 直接连接到日志文件描述符 —
与 Claude Code 使用的模式相同。整个流程中没有 tmux 或外部进程管理器。

## 状态栏

实时小部件显示运行中作业的持续时间和命令预览。完成和失败计数显示在状态行中。使用 Shift+Down 或 `/bg-list` 打开完整的作业管理器。

## 开发

```
git clone https://github.com/patty-io/pi-patty-bg-tasks.git
cd pi-patty-bg-tasks
pnpm install
pnpm check    # 类型检查
pnpm test     # 运行测试
```

需要 Node.js ≥ 22、pnpm ≥ 10。无需 tmux 或其他外部依赖。

## 贡献

1. Fork 仓库
2. 创建功能分支 (`git checkout -b feat/my-feature`)
3. 确保 `pnpm check` 和 `pnpm test` 通过
4. 使用 [Conventional Commits](https://www.conventionalcommits.org/) 提交
5. 向 `main` 提交 PR

## 许可证

[MIT](LICENSE) © Patty

## 作者

**Patty** · [GitHub](https://github.com/patty-io)
