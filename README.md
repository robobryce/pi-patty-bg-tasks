# pi-patty-bg-tasks

<p align="center">
  <strong>English</strong> · <a href="README.ko.md">한국어</a> · <a href="README.zh.md">中文</a>
</p>

**Claude Code's background task experience, brought to Pi.** Run long commands without blocking the agent — auto-background after 15 seconds, manual background with Ctrl+Shift+B, output capture, stall detection, and a full job manager.

## Install

```
pi install npm:pi-patty-bg-tasks
```

Or from GitHub:

```
pi install git:github.com/patty-io/pi-patty-bg-tasks
```

Requires Pi v0.37+. tmux is optional but recommended (enables tmux-backed process isolation).

## Why pi-patty-bg-tasks

**No more blocked sessions.** Dev servers, test suites, builds — anything that runs longer than 15 seconds is automatically backgrounded. The agent gets notified and keeps working. You can also background any command manually at any time.

**Claude Code behavior, on Pi.** The background/foreground UX — Ctrl+B to background, output capture, completion notifications, stall detection — is modeled directly on Claude Code's implementation. Same message format, same terminal-native icons, same "agent keeps working" flow.

**Job manager built in.** `/bg-list` gives you an interactive task manager. List, inspect output, kill, or attach to any background job.

## Quick Start

```
# Agent runs a long command — auto-backgrounds after 15s
bash({ command: "npm run build" })

# Start something in the background immediately
bash_bg({ command: "npm run dev", name: "devserver" })

# Check on background jobs
jobs({ action: "list" })

# Search across all job output
jobs({ action: "search", pattern: "error|warning" })

# Spawn a background agent
agent_bg({ prompt: "Refactor the auth module" })
```

Press **Ctrl+Shift+B** at any time to background a running command. The agent is notified and continues working immediately.

## Tools

### bash (override)

Extends the built-in bash tool. Commands run normally, but if a command exceeds 15 seconds, it is automatically backgrounded and the agent is prompted to decide (keep, kill, or check output) via `job_decide`.

| Parameter | Description |
|-----------|-------------|
| `command` | Shell command to run |
| `timeout` | Custom timeout in seconds (default: 15) |

### bash_bg

Start a command in the background immediately — no foreground race or timeout.

| Parameter | Description |
|-----------|-------------|
| `command` | Shell command to run |
| `name` | Optional human-readable label for the job |
| `timeout` | Optional timeout in seconds; triggers the same auto-background decision flow |
| `notify` | Send completion notification (default: true) |

### jobs

Manage background jobs: list, read output, kill, attach, search, cleanup, or get stats.

| Action | Description |
|--------|-------------|
| `list` | Show all running and recently completed jobs |
| `output` | Read the log tail of a specific job |
| `kill` | Terminate a running job |
| `attach` | Wait for a job to complete, then return its output |
| `search` | Regex search across all job logs |
| `cleanup` | Purge completed/failed jobs and reclaim disk |
| `stats` | Aggregate metrics: total started, running, completed, failed, average duration |

### job_decide

Respond to an auto-backgrounded command. The agent receives this prompt when the 15-second timer fires.

| Parameter | Description |
|-----------|-------------|
| `jobId` | The backgrounded job's ID |
| `decision` | `keep` (let it run), `kill` (terminate), or `check` (inspect output first) |

### agent_bg

Spawn a detached `pi -p` process with a continuity prompt derived from the current session.

| Parameter | Description |
|-----------|-------------|
| `prompt` | Task description for the background agent |
| `cwd` | Working directory (default: current) |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| **Ctrl+Shift+B** | Background the current process — agent keeps working (matches Claude Code Ctrl+B) |
| **Ctrl+Shift+J** | Open background task manager |
| **Shift+Down** | Open background task manager |
| **Ctrl+Shift+X** | Kill the most recent running job |

## Commands

| Command | Description |
|---------|-------------|
| `/bg` | Background the current process (same as Ctrl+Shift+B) |
| `/bg-list` | Open the interactive background task manager |
| `/bg-version` | Show the loaded extension version/path for reload diagnostics |

## How It Works

```
Command starts
  → Completes in <2s?     Return result immediately
  → Still running at 15s? Auto-background → agent gets job_decide prompt
  → User presses Ctrl+Shift+B? Background immediately → agent continues

Background job running
  → Output captured to /tmp/pi-bg-<id>.log
  → Stall detection: if output looks like an interactive prompt, agent is warned
  → Oversize detection: if output exceeds limit, job is killed
  → On completion: agent gets notification with status + output path

tmux available?
  → Yes: command runs in tmux window with sentinel-file completion detection
  → No: command runs as detached child process with direct spawn
```

## Cooperative Steering (Claude Code parity)

When you type a message while a backgroundable foreground command is running, the extension intercepts it **before** Pi queues it as steering:

1. The active foreground command is moved to background (output keeps capturing).
2. The current agent turn is aborted.
3. Your message is re-injected as a fresh user turn as soon as the agent is idle.

This matches Claude Code's behavior where submitting input during an interruptible tool aborts the tool and starts a new turn, instead of queueing your message behind a long-running call.

**Scope:** applies to the `bash` tool this extension owns. Long-running tools that are not wrapped by the extension fall back to Pi's native steering (queued, delivered at the next turn boundary).

## Status Bar

A live pill widget shows running jobs with duration and command preview. Completed and failed counts appear in the status line. Use Shift+Down or `/bg-list` to open the full task manager.

## Development

```
git clone https://github.com/patty-io/pi-patty-bg-tasks.git
cd pi-patty-bg-tasks
pnpm install
pnpm check    # type-check
pnpm test     # run tests
```

Requires Node.js ≥ 22, pnpm ≥ 10. tmux optional.

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Ensure `pnpm check` and `pnpm test` pass
4. Commit with [conventional commits](https://www.conventionalcommits.org/)
5. Open a PR against `main`

## License

[MIT](LICENSE) © Patty

## Author

**Patty** · [GitHub](https://github.com/patty-io)
