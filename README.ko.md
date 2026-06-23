# pi-patty-bg-tasks

[English README](README.md)

Background-task support for the
[pi](https://github.com/earendil-works/pi-mono) coding agent. Run long
commands without blocking the agent, batch spawn helpers, and inspect
output across all running jobs — all without leaving the conversation.

## What's in the box

- **`bash` (override)** — every bash command can run, but commands
  longer than 15 s are automatically moved to the background and the
  agent is asked whether to keep or kill them. Press **Ctrl+Shift+B** to
  manually background a running command.
- **`bash_bg`** — start a command in the background from the get-go.
  - New: `--name <label>` for easy tracking in `jobs list`.
  - New: `timeout` (seconds) for an optional per-job auto-background
    timeout that reuses the bash tool's `bg-timeout` flow.
- **`jobs`** — list, read output from, kill, or attach to background
  jobs.
  - New: `search <regex>` — search across every job's log with line
    references.
  - New: `cleanup` — purge terminal jobs from in-memory state and
    reclaim their log files.
  - New: `stats` — total started, by-status breakdown, average
    duration, total CPU time.
- **`job_decide`** — keep, kill, or check a job that the 15-second
  timer backgrounded.
- **`agent_bg`** — spawn a separate `pi -p` process in the background
  with a continuity prompt derived from your current session.
- **Pill bar** in the status line shows every running job with
  command preview + elapsed time.
- **Disk-based output** — every job writes stdout+stderr to
  `/tmp/pi-bg-<jobId>.log`. No in-memory buffering, no memory pressure
  on long-running jobs.
- **Tmux backend** — when tmux is on `PATH` and you're in a git repo,
  commands run inside tmux windows. This eliminates the
  foreground/background output race window the plain `bash` tool has.
- **Stall watchdog** — detects interactive prompts (`(y/n)`,
  `Press any key`, `Continue?`) after 45 s of stagnant output. Kills
  the job if its log file exceeds 100 MiB.
- **Session persistence** — running jobs are written to the session on
  shutdown and reattached on next launch.

## Install

```bash
pi install npm:pi-patty-bg-tasks
```

Or add to `~/.pi/agent/settings.json`:

```json
{
    "packages": ["npm:pi-patty-bg-tasks"]
}
```

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+B` | Background a running bash/agent, or resume a paused agent |
| `Ctrl+Shift+J` / `Shift+Down` | Open the background-task list |
| `Ctrl+Shift+X` | Kill the most recently started running job |

## Commands

| Command | Action |
|---------|--------|
| `/bg` | Same as `Ctrl+Shift+B` |
| `/fg [job-id] [--snapshot]` | Attach to a job's output (default: most recent running) |
| `/jobs` | Open the background-task list |

## How the 15-second auto-background works

The bash tool races the child command against three outcomes:

1. **Quick completion** (within 2 s) — return the output directly, no
   backgrounding ceremony.
2. **Auto-background** (at 15 s) — mark the job as backgrounded, send
   a `bg-timeout` follow-up to the agent, and require a `job_decide`
   call to keep or kill it.
3. **Manual background** (any time via Ctrl+Shift+B) — same as above but
   without the 15-s wait.

In non-interactive mode (`-p`, `--print`, non-TTY stdin), the timer
does nothing — there's no agent loop to answer `job_decide`, so the
command runs to completion.

## New `bash_bg` features (v0.2)

```ts
// Label a job for tracking
bash_bg({ command: "npm run build", name: "build" })

// Per-job timeout (seconds) — at expiry, the same bg-timeout flow fires
bash_bg({ command: "sleep 300 && ./do-stuff.sh", timeout: 60 })
```

## New `jobs` actions (v0.2)

```ts
// Regex search across every running + recent terminal job's log
jobs({ action: "search", pattern: "ERROR.*timeout" })

// Purge terminal jobs (frees log files)
jobs({ action: "cleanup" })

// Aggregate stats
jobs({ action: "stats" })
// Total started:   12
// Currently running: 2
// Completed:        8
// Failed:           2
// Killed:           0
// Average duration: 4m12s
// Total CPU time:   50m24s
```

## Architecture

```
src/
  index.ts              진입점. 툴/단축키/커맨드 등록 + 세션 라이프사이클
  state.ts              BackgroundRegistry — 공유 가변 상태
  types.ts              Job, ForegroundSlot, TmuxContext, UiContext, 상수
  format.ts             formatDuration, statusLabel, formatJobLine, truncateTail
  proc.ts               spawnDetached, killProcessTree, processExists, tmux spawn/session
  registry.ts           잡 CRUD: add/forget/find, renderSidebar, getStats, cleanupTerminal
  lifecycle.ts          watchProgress, watchStalls, notifyFinished, scheduleTimeout,
                        markTerminal, buildTimeoutNotice, createCompletionPromise,
                        reviveAndValidate, cleanupStaleLogs, cleanupStaleTmuxArtifacts
  ui.ts                 showTaskDetail, showTaskList — Ctrl+Shift+J TUI
  shortcuts.ts          Ctrl+Shift+B, Ctrl+Shift+J/Shift+Down, Ctrl+Shift+X 등록
  commands.ts           /bg, /fg, /jobs 등록
  tools/
    bash.ts             bash 툴 오버라이드 + runDirect/runViaTmux
    bash-bg.ts          bash_bg 툴 + spawnViaTmux + per-job timeout
    jobs.ts             jobs 툴 + search/cleanup/stats 액션
    job-decide.ts       job_decide 툴 (keep/kill/check)
    agent-bg.ts         agent_bg 툴 + 컨텍스트 추출
```

## License

MIT
