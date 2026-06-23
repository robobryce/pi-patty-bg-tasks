# pi-patty-bg-tasks

[한국어 README](README.ko.md)

Background-task extension for the [pi](https://github.com/earendil-works/pi-mono) coding agent. Run long commands without blocking the conversation, spawn detached agents, and manage everything through a unified jobs interface.

## Features

### Tools

| Tool | Description |
|------|-------------|
| **`bash`** (override) | Every bash command runs normally, but commands exceeding 15 s are auto-backgrounded. The agent is prompted to keep or kill them via `job_decide`. Press **Ctrl+Shift+B** to manually background at any time. |
| **`bash_bg`** | Start a command in the background immediately. Supports `--name <label>` for human-readable job tracking and an optional `timeout` (seconds) that triggers the same bg-timeout flow. |
| **`jobs`** | List, read output, kill, or attach to background jobs. Includes `search <regex>`, `cleanup`, and `stats` actions. |
| **`job_decide`** | Keep, kill, or check a job that was auto-backgrounded by the 15 s timer. |
| **`agent_bg`** | Spawn a separate `pi -p` process in the background with a continuity prompt derived from your current session. |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| **Ctrl+Shift+B** | Background the current foreground process, or resume a paused agent |
| **Ctrl+Shift+J** / **Shift+Down** | Open the task list UI |
| **Ctrl+Shift+X** | Kill the most recently started running job |

### Slash Commands

| Command | Description |
|---------|-------------|
| `/bg` | Same as Ctrl+Shift+B |
| `/fg [job-id] [--snapshot]` | Attach to a job's output (default: most recent running) |
| `/jobs` | Open the interactive task manager |

### Status Bar

A live pill-bar widget shows every running job with its duration, command preview, and background/foreground state. Completed and failed counts appear in the status line.

## Architecture

```
src/
├── index.ts          # Extension entry point — tool & event registration
├── types.ts          # Domain types (Job, ForegroundSlot, constants)
├── state.ts          # BackgroundRegistry — in-memory state store
├── format.ts         # Formatting helpers (duration, status labels, textBlock)
├── proc.ts           # Process primitives (spawn, kill, tmux, sentinel polling)
├── registry.ts       # Job CRUD, sidebar rendering, stats
├── lifecycle.ts      # State transitions, completion protocol, timeout, session revival
├── monitoring.ts     # Progress polling + stall/prompt detection
├── ui.ts             # TUI task list and job detail views
├── shortcuts.ts      # Keyboard shortcut handlers
├── commands.ts       # Slash command handlers
└── tools/
    ├── bash.ts       # bash override (foreground race → auto-background)
    ├── bash-bg.ts    # bash_bg (immediate background)
    ├── jobs.ts       # jobs (list/output/kill/attach/search/cleanup/stats)
    ├── job-decide.ts # job_decide (keep/kill/check)
    └── agent-bg.ts   # agent_bg (detached pi -p)
```

### Key Design Decisions

- **tmux-first with direct-spawn fallback** — When tmux is available, commands run in tmux windows with sentinel-file-based completion detection. Falls back to detached child processes when tmux is not on PATH.
- **Unified completion protocol** — `completeJob()` in lifecycle.ts handles the mark-terminal → notify → forget → sidebar-update sequence for all tools.
- **Polling abstraction** — `pollExitSentinel()` in proc.ts provides a shared, timeout-guarded sentinel file poller used by both bash and bash_bg tmux backends.
- **Session persistence** — Job state is serialized on session shutdown and revived on restart. Stale jobs (dead PIDs) are detected and cleaned up automatically.

## Installation

```bash
pi package install pi-patty-bg-tasks
```

Or add to your project's pi configuration:

```json
{
  "pi": {
    "extensions": ["pi-patty-bg-tasks"]
  }
}
```

## Development

```bash
git clone https://github.com/patrickrho-patty/pi-patty-bg-tasks.git
cd pi-patty-bg-tasks
pnpm install

# Type-check
pnpm check

# Run tests
pnpm test
```

### Requirements

- Node.js ≥ 22 (uses `--experimental-strip-types`)
- pnpm ≥ 10
- tmux (optional, recommended — enables tmux backend)

## Contributing

Contributions are welcome! Please follow these steps:

1. **Fork** the repository
2. **Create a branch** for your feature or fix (`git checkout -b feat/my-feature`)
3. **Make your changes** — ensure `pnpm check` and `pnpm test` pass
4. **Commit** with a [conventional commit](https://www.conventionalcommits.org/) message
5. **Open a Pull Request** against `main`

### Guidelines

- All code comments are written in Korean; identifiers and user-facing strings stay in English.
- Run the full check + test suite before submitting.
- New features should include tests in `src/__tests__/`.
- Keep PRs focused — one feature or fix per PR.

## License

[MIT](LICENSE) © Patty

## Author

Developed by **Patty** ([@patrickrho-patty](https://github.com/patrickrho-patty))
