# pi-patty-bg-tasks

<p align="center">
  <strong>English</strong> · <a href="README.ko.md">한국어</a> · <a href="README.zh.md">中文</a>
</p>

<p align="center">
  <strong>Long commands shouldn't freeze your agent. Background them automatically — and keep shipping.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-patty-bg-tasks"><img alt="npm" src="https://img.shields.io/npm/v/pi-patty-bg-tasks?color=cb3837&label=npm&logo=npm"></a>&nbsp;
  <img alt="Pi v0.37+" src="https://img.shields.io/badge/Pi-v0.37%2B-5b50f0">&nbsp;
  <img alt="dependencies: zero" src="https://img.shields.io/badge/dependencies-zero-3fb950">&nbsp;
  <img alt="tmux: not required" src="https://img.shields.io/badge/tmux-not_required-3fb950">&nbsp;
  <img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-blue">
</p>

**Your agent shouldn't twiddle its thumbs while the build runs.** This is Claude Code's background-task experience, brought to Pi: kick off a long command, and instead of blocking the whole session, it slips into the background while the agent keeps working. Auto-background after 120 seconds, instant background with Ctrl+B, output capture, stall detection, and a full job manager — all in one extension.

## Install

```
pi install npm:pi-patty-bg-tasks
```

Or straight from GitHub:

```
pi install git:github.com/patty-io/pi-patty-bg-tasks
```

Needs Pi v0.37+. That's the only requirement — there are **no external dependencies** and **no tmux**. Background jobs run as plain Node.js child processes with their output piped straight to a file descriptor. Nothing to install, nothing to babysit.

## Why You'll Want This

**Blocked sessions are over.** Dev servers, test suites, builds — anything still chugging after 120 seconds gets quietly moved to the background. The agent gets a heads-up and carries on with the next thing instead of staring at a spinner. Want it gone sooner? Background any command by hand, any time.

**It feels like Claude Code, because it's modeled on Claude Code.** The whole background/foreground dance — Ctrl+B to background, output capture, completion pings, stall detection — is built directly on Claude Code's implementation. Same message format, same terminal-native icons, same "agent never stops moving" flow. If you've got the muscle memory, it's already here.

**A real job manager, not an afterthought.** `/bg-list` opens an interactive task manager where you can list jobs, peek at their output, kill the runaways, or attach and wait for a result.

## Quick Start

```
# Agent runs a long command — auto-backgrounds after 120s
bash({ command: "npm run build" })

# Skip the wait — start it in the background up front
bash({ command: "npm run dev", run_in_background: true })

# Or fire-and-forget straight to the background
bash_bg({ command: "npm run dev", name: "devserver" })

# Check on what's running
jobs({ action: "list" })

# Grep across every job's output at once
jobs({ action: "search", pattern: "error|warning" })

# Hand off a whole task to a background agent
agent_bg({ prompt: "Refactor the auth module" })
```

Hit **Ctrl+B** whenever a command is running to background it on the spot — a dim `(ctrl+b to run in background)` hint appears under your input once the command has been going a couple of seconds. The agent gets notified and is back to work before you've let go of the keys.

## Tools

### bash (override)

The built-in bash tool, with a survival instinct. Commands run normally — but if one blows past 120 seconds, it's automatically backgrounded and the agent is asked what to do next (keep it, kill it, or check the output) via `job_decide`.

| Parameter | Description |
|-----------|-------------|
| `command` | Shell command to run |
| `timeout` | Custom timeout in seconds (default: 120) |
| `run_in_background` | Start the command in the background immediately, skipping the foreground run and the auto-background timer |

### bash_bg

When you already know it's a long one. Starts a command in the background immediately — no foreground race, no timeout to wait out.

| Parameter | Description |
|-----------|-------------|
| `command` | Shell command to run |
| `name` | Optional human-readable label for the job |
| `timeout` | Optional timeout in seconds; triggers the same auto-background decision flow |
| `notify` | Send a completion notification (default: true) |

### jobs

Mission control for everything running in the background: list, read output, kill, attach, search, cleanup, or pull stats.

| Action | Description |
|--------|-------------|
| `list` | Show all running and recently completed jobs |
| `output` | Read the log tail of a specific job |
| `kill` | Terminate a running job |
| `attach` | Wait for a job to finish, then return its output |
| `search` | Regex search across all job logs |
| `cleanup` | Purge completed/failed jobs and reclaim disk |
| `stats` | Aggregate metrics: total started, running, completed, failed, average duration |

### job_decide

The agent's answer to an auto-backgrounded command. This prompt lands the moment the 120-second timer fires.

| Parameter | Description |
|-----------|-------------|
| `jobId` | The backgrounded job's ID |
| `decision` | `keep` (let it run), `kill` (terminate), or `check` (inspect output first) |

### agent_bg

Clone yourself a coworker. Spawns a detached `pi -p` process with a continuity prompt derived from the current session, then streams its progress back to you live.

| Parameter | Description |
|-----------|-------------|
| `prompt` | Task description for the background agent |
| `cwd` | Working directory (default: current) |

### monitor

Stream events instead of waiting once. Where `bash_bg`/`run_in_background` give a **single** completion ping, `monitor` turns a process into a **live event stream** — each stdout line (or WebSocket frame) becomes one notification delivered straight into the agent's turn while it keeps working. This is the streaming half of Claude Code's split: one-shot "wait until done" stays on `run_in_background`; per-event "tell me each time X happens" is `monitor`.

```js
// Notify on every error line, indefinitely
monitor({ command: "tail -f deploy.log | grep --line-buffered -E 'ERROR|Traceback'", description: "errors in deploy.log" })

// Emit each CI check as it lands, stop when the run finishes
monitor({ command: "…poll loop that exits…", description: "CI checks for PR 123" })

// Subscribe to a WebSocket feed — each text frame is an event
monitor({ ws: { url: "wss://events.example.com/stream" }, description: "deploy events", persistent: true })
```

| Parameter | Description |
|-----------|-------------|
| `command` | Shell script; each stdout line is an event. Mutually exclusive with `ws`. |
| `ws` | WebSocket source `{ url, protocols? }`; each text frame is an event. Mutually exclusive with `command`. |
| `description` | Shown on every notification (make it specific). **Required.** |
| `persistent` | Run for the whole session (no timeout); stop with `jobs action='kill'`. Default `false`. |
| `timeout_ms` | Deadline before the watch is killed (default `300000`, max `3600000`). Ignored when `persistent`. |

Monitors share the same job registry, sidebar (shown with a `◉` pill), and `jobs` manager as the background tools — only stdout is the event stream (stderr is captured to a separate `.err` file), output is line-buffered so use `grep --line-buffered`/`awk fflush()` (never `head`), and a monitor that floods events is auto-stopped so you can restart with a tighter filter. The `ws` source needs a runtime with a global `WebSocket` (Node 22+); otherwise use a `command` like `websocat`.

> **Persistent monitors and disk:** a non-`persistent` monitor's output log is capped (oversized output kills it), but a `persistent` monitor is expected to run for the whole session, so its log is **not** size-capped — point a long-lived `tail -f` at a filtered stream rather than a firehose, and stop it with `jobs action='kill'` when done.

## Keyboard Shortcuts

Keep your hands on the keyboard.

| Shortcut | Action |
|----------|--------|
| **Ctrl+B** | Background the running foreground command — agent keeps working (matches Claude Code). Inside tmux, press it twice (tmux owns Ctrl+B). |
| **Ctrl+Shift+B** | Same as Ctrl+B (alias) |
| **Ctrl+Shift+J** | Open the background task manager |
| **Shift+Down** | Open the background task manager |
| **Ctrl+Shift+X** | Kill the most recent running job |

## Commands

Prefer slashes? Same powers, different door.

| Command | Description |
|---------|-------------|
| `/bg` | Background the current process (same as Ctrl+B) |
| `/bg-list` | Open the interactive background task manager |
| `/bg-version` | Show the loaded extension version/path for reload diagnostics |

## How It Works

No magic, just a tidy state machine:

```
Command starts (direct Node.js child_process.spawn)
  → Done in <2s?           Return the result immediately
  → Still running at 120s? Auto-background → agent gets a job_decide prompt
  → You press Ctrl+B?       Background immediately → agent continues

Background job running
  → Output captured to /tmp/pi-bg/<id>.log via file descriptor
  → Stall detection: if the output looks like an interactive prompt, the agent is warned
  → Oversize detection: if the output blows past the limit, the job is killed
  → On completion: agent gets a notification with status + output path
```

Background jobs run as detached Node.js child processes with their stdout/stderr wired
straight to a log file descriptor — the exact pattern Claude Code uses. No tmux, no
external process manager, nothing standing between your command and its log. Up to
**16 background jobs** run at once; ask for a 17th and it's politely rejected until a
slot frees up. Stale logs older than 24h get swept on session start, so `/tmp` never
turns into a junk drawer.

## Cooperative Steering (Claude Code parity)

Type a message while a backgroundable foreground command is running, and the extension steps in **before** Pi queues your text as steering:

1. The active foreground command slides into the background (output keeps capturing — nothing is lost).
2. The current agent turn is aborted.
3. Your message is re-injected as a fresh user turn the instant the agent is idle.

That's exactly how Claude Code behaves: submitting input during an interruptible tool aborts the tool and starts a new turn, instead of leaving your message stuck in line behind a long-running call. No polling, no waiting your turn.

**Scope:** this applies to the `bash` tool this extension owns. Long-running tools the extension doesn't wrap fall back to Pi's native steering (queued, delivered at the next turn boundary).

## Status Bar

A live pill widget keeps your running jobs in view — each with its duration and a preview of the command. Completed and failed counts ride along in the status line. When you want the full picture, Shift+Down or `/bg-list` opens the task manager.

## Releases

### 1.0.2 — Ctrl+B parity & friendlier jobs

- **Ctrl+B** is now the primary background shortcut (Ctrl+Shift+B stays as an alias), with a live `(ctrl+b to run in background)` hint under the editor while a command runs — matching Claude Code. Inside tmux it shows the "(twice)" note.
- **`jobs attach` streams the job's live output** while it waits (it was silent before) and is reworded "Following … live output"; detaching leaves the job running.
- **Sidebar pills tick live** — durations update every second instead of freezing at the value they were last drawn with.
- Job-finished and timeout notices are **compact** (a one-line agent follow-up + a UI toast) — the agent stays informed without boxed spam.

### 1.0.1 — Claude Code parity (first published 1.x)

The big one. The background engine was rewritten from the ground up to match Claude Code's architecture, with zero external dependencies. This is the first 1.x on npm, and it ships the parity rewrite alongside a solid round of correctness and performance hardening.

**Breaking changes**
- **tmux is gone.** Background jobs now run as direct Node.js `child_process.spawn` processes with file-descriptor output capture. tmux is no longer used or required — nothing left to install.
- **Default auto-background timeout is now 120s** (was 15s), matching Claude Code. Pass an explicit `timeout` to override.
- Background logs moved from `/tmp/pi-bg-<id>.log` to a dedicated `/tmp/pi-bg/<id>.log` directory.

**Highlights**
- New `run_in_background: true` parameter on the `bash` tool.
- `agent_bg` now streams progress live and resolves the `pi` binary path (so it works even outside standard `$PATH` installs).
- Cooperative steering delivers your message as a follow-up turn — no polling loop.
- Concurrency cap of 16 simultaneous background jobs.
- Code and UI are English-only.

**Fixes & internals (post-rewrite hardening)**
- Cooperative steering no longer kills the very command it just backgrounded.
- Spawn failures (`ENOENT`/`EMFILE`/`EAGAIN`) are handled gracefully instead of crashing the agent.
- Session restore only revives jobs from the current process — it never signals a possibly-recycled PID.
- The four spawn paths were consolidated onto a single `startBackgroundJob` service function; foreground teardown moved into `finally` so no exit path can strand a job.
- Log search runs concurrently across jobs, and the stale-log sweep is bounded and async.

### 0.3.1 and earlier

tmux-backed background jobs, 15s auto-background, cooperative steering, and the interactive job manager.

## Development

```
git clone https://github.com/patty-io/pi-patty-bg-tasks.git
cd pi-patty-bg-tasks
pnpm install
pnpm check    # type-check
pnpm test     # run tests
```

Requires Node.js ≥ 22, pnpm ≥ 10. No tmux or other external dependencies — what you clone is what you run.

## Contributing

PRs welcome. The drill:

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make sure `pnpm check` and `pnpm test` pass
4. Commit with [conventional commits](https://www.conventionalcommits.org/)
5. Open a PR against `main`

## License

[MIT](LICENSE) © Patty

## Author

**Patty** · [GitHub](https://github.com/patty-io)
