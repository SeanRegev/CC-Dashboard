# CC-Dashboard architecture

A desktop app that shows all your Claude Code sessions in one window. Windows first, then macOS and Linux.
Every agent is a real `claude` process in a real terminal; CC-Dashboard never re-implements Claude Code.

```
┌──────────────────────────── Electron app (packages/app) ────────────────────────────┐
│  main process: window, native notifications, starts/finds the core, menus           │
│  renderer:  sidebar (spaces · agents · inbox)  │  tabs + split panes of xterm.js      │
└───────────────▲──────────────────────────────────────────────────────────────────────┘
                │  WebSocket JSON-RPC on 127.0.0.1:<port>, token auth (packages/shared/protocol.js)
┌───────────────┴────────────── cc-core (packages/core) ──────────────────────────────┐
│  a long-lived local service: keeps agents alive when the window closes or updates    │
│  • PTY manager: node-pty (ConPTY on Windows) runs each `claude`                     │
│  • status engine: Claude Code hooks → POST /hook → working / needs_you / idle …      │
│  • store: ~/.cc-dashboard/state.json (spaces, agents), status in memory + snapshot   │
│  • scrollback ring buffer per agent, replayed when a window attaches                 │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## Layers and owners

| Layer | Folder | Owner (subagent) |
|---|---|---|
| Contracts | `packages/shared` | lead (changes need the lead) |
| Core service | `packages/core` | Core |
| Desktop shell | `packages/app/src/main`, `packages/app/src/renderer` (panes, tabs, keys, themes) | Shell |
| Views | `packages/app/src/renderer/views` (sidebar, inbox, board, allow/deny) | Views (milestone 2) |
| Orchestration | `packages/core/src/orchestrate` (tasks, routing, worktrees, verification) | Orchestration (milestone 3) |
| Insight | `packages/core/src/insight` (usage, loadout, timeline) | Insight (milestone 3) |
| Tests, CI, installers | `tests/`, `.github/workflows`, `electron-builder.yml` | QA & Release |

## Decisions

- **Plain JavaScript (CommonJS in main/core, ES modules in the renderer), no bundler.** Type hints with JSDoc and `// @ts-check`. Fewer moving parts on Windows.
- **The core runs on Electron's own Node** in the installed app (`ELECTRON_RUN_AS_NODE=1`), so users install nothing else. In development and tests it runs on system Node. `node-pty` is rebuilt for Electron by electron-builder on the Windows CI machine.
- **Discovery:** the core writes `~/.cc-dashboard/core.json` = `{ "port", "token", "pid", "version" }` (file mode 600). The app reads it; if missing or the pid is dead, it starts the core detached.
- **Security:** the core listens on 127.0.0.1 only; every WebSocket and HTTP request must carry the token.
- **Status comes from Claude Code hooks**, passed with `claude --settings <file>`; the user's own settings are never edited.
- **Session identity:** each agent gets `--session-id <uuid>` at start, so it can be resumed with `--resume <uuid>`.
- **Claude executable:** `CC_CLAUDE` env var if set (tests point it at `tests/fake-claude.js`), else `claude` found on PATH (`claude.exe` / `claude.cmd` on Windows).
- **Worktrees** (milestone 3) live in `<repo>/.cc-dashboard/worktrees/<agent>` so Claude treats them as trusted, hidden via `.git/info/exclude`.

## Milestones

1. **It runs:** core + window + sidebar + one real Claude you type into; Windows installer from CI.
2. **The look:** spaces, tabs, split panes, needs-you, allow/deny, notifications, themes, Board layout.
3. **The brains:** tasks and ◆1–◆5 routing, worktrees, verification gate (fresh reviewer + tests), loadout, usage.
