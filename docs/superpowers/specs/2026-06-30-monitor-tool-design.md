# Monitor tool — design

**Date:** 2026-06-30
**Package:** `pi-patty-bg-tasks` (pi official package registry)
**Status:** Approved design, pending implementation plan

## Problem

The extension already brings Claude Code's background-task model to pi: auto-background
after 120s, `bash_bg` (`run_in_background`), `agent_bg`, stall detection, and a job
manager. Two failure modes remain:

1. **Agents background the wrong things.** `bash_bg`/`run_in_background` is a one-shot,
   fire-and-forget primitive with a single completion notification and no mid-flight
   visibility. Agents reach for it to "watch" logs, poll APIs, or wait on streaming
   output — cases it serves badly.
2. **"Done" is not reliably observable.** When a one-shot background job finishes (or
   crashes), the agent frequently never learns the terminal state, because nothing emits
   on failure paths and there is no per-event signal.

Claude Code solved this by splitting the problem across two primitives along **how many
notifications you need**, and deliberately narrowing Monitor to streaming-only
(the #22764 narrowing):

| Need | Tool | Notifications |
| --- | --- | --- |
| "tell me **once** when done" | `Bash` `run_in_background` + `until` loop | exactly one, on exit |
| "tell me **per event** as it streams" | **Monitor** | one per matching stdout line / ws frame |

This design adds that missing streaming primitive — `monitor` — to this extension,
distinct from the existing one-shot background tools.

## Goals

- A `monitor` tool, registered as part of this extension alongside the existing tools,
  that streams events: **each stdout line (or WebSocket text frame) becomes one
  notification** delivered into the agent's turn.
- **Streaming-only.** Monitor does not replace "wait until done." One-shot waits stay on
  `bash_bg`/`run_in_background`. The boundary is enforced in prompt guidance and a
  steering nudge on the bash tools.
- **Reliable terminal-state observability.** Monitor emits on exit with the exit code, and
  its guidance forces filters that match failure signatures, not just the happy path
  ("silence is not success").
- **Maximum runtime compatibility, zero new dependencies** — this is a registry package.

## Non-goals

- Replacing or reworking the existing `bash`/`bash_bg`/`agent_bg` semantics.
- A separate monitor registry or a parallel job-manager UI (we reuse the existing one).
- A vendored full RFC 6455 WebSocket client (see Compatibility below).

## Distinctness boundary

Three tools, three notification cardinalities:

| Tool | When to use | Notifications |
| --- | --- | --- |
| `bash` / `bash_bg` | "tell me once when done" (build, install, one-shot wait) | one, on exit |
| **`monitor`** | "tell me per event as it streams" (`tail -f \| grep ERROR`, poll loop, file watch, ws feed) | one per matching line/frame |
| `agent_bg` | delegate a sub-task to a background `pi -p` | one, on completion |

Monitor must **not** be used for the single-notification case: an unbounded command
(`tail -f`, `while true`, `inotifywait -m`) never exits on its own, so the monitor stays
armed until timeout even after the awaited event fired. For one-shot "wake me when X",
the guidance routes the agent to `bash_bg` with a command that exits when the condition
is true.

## Architecture — reuse Job infra, add a `monitor` kind

Monitors are `Job`s with a new `kind`, living in the existing `BackgroundRegistry`. They
share persistence, the `jobs` manager, the kill path, and `session_shutdown` cleanup, and
get a **distinct sidebar pill** so they read differently from shell jobs.

### Components

- **`src/tools/monitor.ts`** — registers the `monitor` tool. Validates params
  (`command` XOR `ws`), spawns the source, wires the line-follower (or ws reader) to the
  event emitter, registers the job with `kind: "monitor"`, and returns the start message.
  Registered in `src/index.ts` next to the other five tools.

- **`src/monitor-follow.ts`** — the one genuinely new mechanic and the **single emitter
  path for both sources**: a **line-accurate tail follower**. Starts at byte offset 0 of
  the `<jobId>.log` (so all output from a freshly spawned command is captured), tracks the
  offset forward, reads only *complete* newly appended lines (holds a partial trailing line
  until its newline arrives), batches lines that arrive within **200 ms** into one event,
  and invokes an `onEvent(lines: string[])` callback. Returns a `stop()` handle. This is
  separate from `pollFileTail` in `output.ts`, which reads a bounded 4 KB tail and dedups
  by content — lossy under bursts and not line-accurate, so it cannot back Monitor.
  `pollFileTail` stays as-is for bg progress streaming.

- **`src/monitor-ws.ts`** — WebSocket source. Feature-detects `globalThis.WebSocket`
  (stable in Node 22+). Opens the socket and **appends each event as a line to the same
  `<jobId>.log`** the follower reads — so ws and command monitors share one emitter path
  and the existing jobs-list / attach / Read surface works unchanged. Each text frame →
  one line; binary frame → a placeholder line `[binary frame, N bytes]`; socket close
  appends a terminal line with the close code and stops the follower; errors are surfaced
  before close. If `globalThis.WebSocket` is absent on the runtime, the `ws` source fails
  fast with an actionable error pointing to a `command`-based alternative
  (`websocat`/`wscat`). See Compatibility.

### WebSocket monitors and the Job model

A ws monitor has **no child process**, so it does not fit the pid/process-tree shape the
existing `Job` lifecycle assumes. Reconciliation:

- **`pid: 0`** sentinel ("no process"). `killProcessTree(0)` already no-ops (guards
  `pid <= 0`), so the standard kill path is safe and simply does nothing for the socket.
- **`logPath`** is still allocated; the ws reader appends received frames to it, so
  persistence, the sidebar preview, `jobs attach`, and Read all behave like a command
  monitor.
- **`command`** (the label shown in sidebar/jobs) is set to a synthetic `ws <url>`.
- **Stop/kill** goes through a new transient **`Job.stop?: () => void`** callback (see
  types change), set for every monitor. For ws it closes the socket and stops the
  follower; for command monitors it also cancels the follower (the process is still killed
  by the existing process-tree path). The kill path (`terminateJob` /
  `terminateJobSilently`) invokes `job.stop` when present, in addition to the pid kill.
- ws monitors are **not revived** across sessions (a socket cannot survive restart); on
  `session_start` a persisted `kind: "monitor"` ws job is marked terminal and folded into
  the counter (see Lifecycle).

- **`src/spawn.ts`** — gains a **split-output mode**, used only by command monitors (ws
  monitors do not spawn). Current `spawnWithFileOutput` writes stdout+stderr to one fd
  (`["ignore", logFd, logFd]`). Monitor needs stdout as the event stream and stderr to a
  separate, non-emitting file. Add an optional `errPath`: when present, stdio becomes
  `["ignore", outFd, errFd]`. Existing callers are unchanged (single-fd behavior preserved
  when `errPath` is omitted).

### Event delivery

Each event is delivered with the **same mechanism `monitoring.ts` already uses** for
stall warnings:

```
pi.sendMessage(
  { customType: EVENT.monitorEvent, content, display: true, details: { jobId, description } },
  { deliverAs: "followUp", triggerTurn: true }
)
```

- `description` (required param) is shown on every event.
- Lines within 200 ms are batched into a single message.
- On source exit, a terminal event is emitted with the exit code (`stream ended` /
  `script failed (exit N)` / `stopped`), mirroring Claude Code's stream-ended summaries.
- **Monitor owns its terminal event**, so `startBackgroundJob` is called with
  `shouldNotify: false`. Otherwise its `notifyFinished` (`EVENT.jobFinished`) would
  double-fire alongside the monitor's own terminal event. `startBackgroundJob` is reused
  only for its exit/abort wiring and registry bookkeeping, not its completion notice.

### Data flow

```
monitor tool
  ├─ command source: spawnWithFileOutput({ command, logPath, errPath })
  │     stdout → <jobId>.log   (stderr → <jobId>.err, readable, never emits)
  │
  └─ ws source: WebSocket(url) ─ appends each frame as a line → <jobId>.log
                                       │
                          <jobId>.log ─▶ monitor-follow (offset 0, complete lines, 200ms batch)
                                       │ onEvent(lines)
                                       ▼
                       rate-limit window check  ──(over cap)──▶ job.stop() + "tighten filter" msg
                                       ▼
              pi.sendMessage(followUp, triggerTurn) per batch
                                       │
                          source exit / socket close
                                       ▼
            terminal event (exit code / close code); startBackgroundJob shouldNotify:false
```

## Guardrails (ported from Claude Code, adapted)

- **Rate limiting.** Count events in a sliding window. When a monitor exceeds the cap,
  auto-stop it (via `job.stop` + mark terminal) and emit one "stopped — tighten your
  filter" message. New constants in `types.ts` (e.g. `MONITOR_EVENT_WINDOW_MS`,
  `MONITOR_MAX_EVENTS_PER_WINDOW`).
- **Params** mirror the real Monitor schema:
  - `command` (string) XOR `ws` ({ url, protocols? }) — exactly one required.
  - `description` (string, required) — shown on every notification.
  - `persistent` (boolean, default false) — no timeout; stop via the `jobs` tool / kill.
  - `timeout_ms` (number, default 300000, max 3600000) — killed on deadline; ignored when
    `persistent` is true.
- **`promptGuidelines`** on the tool encode the hard-won guidance:
  - line-buffering: `grep --line-buffered`, `awk` needs `fflush()`, never pipe to `head`;
  - "silence is not success" — the filter must match terminal/failure signatures
    (`Traceback|Error|FAILED|Killed|OOM|exit`), not just the success marker;
  - merge stderr with `2>&1` when filtering a directly-run command;
  - poll-interval advice (30s+ for remote APIs, 0.5–1s local; `curl ... || true`).
- **Steering nudge.** Extend `bash` and `bash_bg` `promptGuidelines` (and the sleep-guard
  message in `bash.ts`/`bash-bg.ts` if present) to route streaming/watch use cases to
  `monitor` and one-shot waits to `run_in_background`.

## Error handling & lifecycle

- Reuses `startBackgroundJob` (exit/abort wiring, with `shouldNotify: false`),
  `killProcessTree`, session persistence, and `session_shutdown` cleanup.
- **Concurrency:** monitors count against the existing `MAX_CONCURRENT_JOBS` (16) cap via
  `assertJobSlot`, same as `bash_bg`/`agent_bg`.
- **Timeout:** at `timeout_ms` the monitor is **killed** (process-tree kill for command,
  `job.stop` socket-close for ws) and a terminal `stopped (timeout)` event is emitted.
  Monitor does **not** reuse `bash_bg`'s `requestJobDecision`/`requestPause` timeout path —
  there is no interactive background-or-keep decision for a streaming watch.
- **Stop/kill:** the `jobs` kill action and `terminateJob`/`terminateJobSilently` invoke
  the transient `job.stop` callback (cancels the follower; closes the ws socket) in
  addition to the existing pid process-tree kill. For command monitors the process tree is
  killed; for ws monitors `pid: 0` makes the pid kill a no-op and `job.stop` does the work.
- `persistent: true` → no timeout; stopped via the `jobs` manager / kill (the TaskStop
  equivalent in this extension).
- **Revival (`session_start`):** persisted monitors follow the existing
  `reviveAndValidate` → `forgetJob` path. A ws monitor can never be revived (no socket
  survives restart) and is always marked terminal and folded into the counter. A command
  monitor whose recorded pid is no longer alive is likewise marked terminal; a still-alive
  one keeps running but its follower is **not** re-attached (we do not re-stream historical
  output) — it is treated as a running job that can be killed/inspected via `jobs`.
- Spawn failures (command) and `WebSocket` construction/connection errors (ws) surface as a
  thrown tool error (consistent with `bash_bg`).

## Compatibility (registry package)

- **No new dependencies.** The `command` source uses the existing file-fd spawn backend
  and works on every runtime the package already supports.
- **`ws` source uses `globalThis.WebSocket`** (stable, unflagged since Node 22) via
  feature detection. When unavailable, only the `ws` source degrades — with a clear error
  pointing to a `command`-based alternative — while the entire `command` surface keeps
  working. This avoids both a third-party dependency and a fragile vendored RFC 6455
  client, and guarantees the package never crashes on an older runtime.
- No `engines` floor is tightened beyond what the package already requires; the `ws`
  feature is additive and self-gating.

## Testing

Existing `node --test` harness (`src/__tests__/*.test.ts`):

- **Line-follower:** partial trailing line held until newline; multi-line burst within
  200 ms batched into one event; offset tracking across successive appends; empty/no-output
  windows produce no event.
- **Rate limiter:** window counting; auto-stop fires once past the cap.
- **Param validation:** `command` XOR `ws` (neither / both rejected); `description`
  required; `timeout_ms` clamped to max; `persistent` disables timeout.
- **ws mapping:** text frame → event, binary → placeholder line, close → terminal event
  with code, using a local ws echo stub gated on `globalThis.WebSocket` availability.
- **spawn split-output:** stdout and stderr land in separate files; single-fd callers
  unchanged when `errPath` omitted.
- **Lifecycle:** a finished monitor emits exactly one terminal event (no `jobFinished`
  double-fire); `job.stop` is invoked on kill; a persisted ws monitor is marked terminal
  on revival rather than resurrected as running.

## Files

**New**

- `src/tools/monitor.ts`
- `src/monitor-follow.ts`
- `src/monitor-ws.ts`
- `src/__tests__/monitor-follow.test.ts`, `src/__tests__/monitor.test.ts`

**Changed**

- `src/types.ts` — `Job.kind?: "shell" | "monitor"`, transient `Job.stop?: () => void`
  (not persisted), monitor constants, `EVENT.monitorEvent`.
- `src/spawn.ts` — optional `errPath` split-output mode.
- `src/registry.ts` — distinct monitor pill in `renderSidebar`.
- `src/index.ts` — register the `monitor` tool; update the header comment (now six
  tools); strip the transient `stop` field in the `session_shutdown` persistence map
  alongside `proc`/`donePromise`/`resolveDone`.
- `src/tools/bash.ts`, `src/tools/bash-bg.ts` — steering guidance toward `monitor`.
- `src/tools/jobs.ts` — show/kill monitors (with their kind reflected in the listing).
- `README.md` (+ `README.ko.md`, `README.zh.md`) — document the `monitor` tool.
```
