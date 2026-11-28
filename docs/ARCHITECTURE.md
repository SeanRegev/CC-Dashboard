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
| Activity and outside sessions | `packages/core/src/activity.js`, `external.js`, `transcript.js` | Core (milestone 3, 0.3) |
| Status line and usage | `packages/core/src/statusline.js`, `statusline-relay.js`, `usage.js` | Core (milestone 4, 0.4) |
| Tests, CI, installers | `tests/`, `.github/workflows`, `electron-builder.yml` | QA & Release |

## Decisions

- **Plain JavaScript (CommonJS in main/core, ES modules in the renderer), no bundler.** Type hints with JSDoc and `// @ts-check`. Fewer moving parts on Windows.
- **The core runs on Electron's own Node** in the installed app (`ELECTRON_RUN_AS_NODE=1`), so users install nothing else. In development and tests it runs on system Node. `node-pty` (1.1+) is a Node-API addon with prebuilt Windows binaries, so the same binary works under both and nothing is compiled or rebuilt.
- **Discovery:** the core writes `~/.cc-dashboard/core.json` = `{ "port", "token", "pid", "version" }` (file mode 600). The app reads it; if missing or the pid is dead, it starts the core detached.
- **Security:** the core listens on 127.0.0.1 only; every WebSocket and HTTP request must carry the token.
- **Status comes from Claude Code hooks**, passed with `claude --settings <file>`; the user's own settings are never edited.
- **Session identity:** each agent gets `--session-id <uuid>` at start, so it can be resumed with `--resume <uuid>`.
- **Claude executable:** `CC_CLAUDE` env var if set (tests point it at `tests/fake-claude.js`), else `claude` found on PATH (`claude.exe` / `claude.cmd` on Windows).
- **Worktrees** (milestone 3) live in `<repo>/.cc-dashboard/worktrees/<agent>` so Claude treats them as trusted, hidden via `.git/info/exclude`.
- **The activity log costs no tokens.** It is built from hook events and, for outside sessions, from Claude's transcript files. No model is called to write or read it.

## Activity, subagents and outside sessions (0.3)

**`activity.js` (hooks → log).** `core.js` calls `activity.onHook()` before each hook is applied to the status. Each
event becomes one `ActivityEntry` (kinds in `protocol.js`), with `subagentId` taken from the payload's `agent_id`
(or `''` for the session itself). Detail and text are capped (300 and 500 characters); tool responses and file
contents are never stored.

- **Titles:** Agent and Task `PreToolUse` calls are queued with their description and type. On `SubagentStart` the
  oldest queued call of the same type is paired with the subagent. If none is queued, the title comes from the
  subagent's `meta.json`, then from `background_tasks` in a later `Stop`, then from the type's label.
- **Persistence:** `<CC_HOME>/activity/<agentId>.jsonl`, appended in batches (≤ 250 ms) and flushed on shutdown.
  Sequence numbers continue across restarts. Past 2 MB the file is rewritten atomically with its newest lines.
  `agents.remove` deletes the files.
- **Events:** `activity` (batched, ≤ 100 ms) and `subagent.updated` (coalesced).

**`external.js` + `transcript.js` (outside sessions).** `external.js` watches `<claude config dir>/sessions/` for
running-session files (polled every 2 s; `CC_EXTERNAL_POLL_MS` for tests). A session is kept only if its pid is
alive and it is not one of our agents. `transcript.js` is pure parsing plus a small tailer: it reads
`<config>/projects/*/<sessionId>.jsonl` from a byte offset, tolerates a half-written last line, and reads subagents
from `subagents/agent-*.meta.json` and their own transcripts. Transcript entries stay in memory (the file is the
record), the last 2000 per session. Live sessions are read every second while working and every 3 s otherwise.

**`external.takeOver`.** The core re-reads the registry file and checks that the pid and session id still match. It
confirms the process is Claude (`tasklist` on Windows, `/proc/<pid>/cmdline` on Linux, `ps` on macOS). It refuses
`still_working` when the session is busy unless `force` is set, and `not_allowed` when the process cannot be
confirmed or does not exit within 10 s. It ends the process (`taskkill /T /F` on Windows, SIGTERM then SIGKILL after
3 s on other systems), then creates an agent with the same session id and starts it with `--resume` in the same
folder. The activity log carries over.

**Contract v3 (`packages/shared/protocol.js`).** Methods: `subagents.list`, `activity.list` (paged with `before`),
`external.list`, `external.takeOver`. Events: `subagent.updated`, `activity`, `external.changed`. New fields:
`AgentStatus.subagents` and `askedBy`. Error code `still_working`. Hook `SubagentStart`. Types: `Subagent`,
`ActivityEntry`, `ExternalSession`.

## Status line and usage (0.4)

Claude Code's status line gives the exact numbers: the context window, the context used, the cost, and the account's
rate limits. CC-Dashboard reads them from there instead of estimating them from the transcript.

**The relay.** Each agent starts with `--settings <hooks file>`, which sets `statusLine` to a launcher in
`<CC_HOME>` (`cc-statusline.cmd` on Windows, `cc-statusline.sh` elsewhere; same quoting as `cc-hook`). Claude runs that
launcher on each update with the session's JSON on stdin. The launcher runs `statusline-relay.js` with
`ELECTRON_RUN_AS_NODE=1`, and the relay does two things:

1. It POSTs the JSON to `${CC_CORE_URL}/statusline?agent=${CC_AGENT_ID}` with the `x-cc-token` header. It waits at most
   2 s, and errors are ignored.
2. It prints the status line. If the user has their own, the relay runs it and prints its output unchanged. If not, it
   prints a short default such as `Haiku 5.5 · ctx 10% · 5h 62%`.

When the core starts an agent, `statusline.js` `prepare()` finds the user's own `statusLine` the way Claude would
without our settings. It looks in `<cwd>/.claude/settings.local.json`, then `<cwd>/.claude/settings.json`, then
`<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json`, and uses the first file that has one. Only `type: "command"` can run.
The core passes the result to the relay in `CC_STATUSLINE` (JSON: the command and the shell, plus a timeout), so the
relay does no searching. Claude runs status-line commands through **Git Bash** on Windows when it finds one (via
`CLAUDE_CODE_GIT_BASH_PATH`, the usual install folders, or Git's own `bin`), and through PowerShell otherwise. The
relay does the same. The relay prints nothing else and always exits 0, unless the user's command failed. A dead or
slow core never delays the line.

**The core side.** `core.handleStatusLine(id, payload)` hands the snapshot to `StatusLine.handle()`. For each agent it
keeps the latest snapshot and applies at most one per second (`THROTTLE_MS`). The last one always lands, because the
throttle is trailing. An unknown agent gets a 404.

- `AgentStatus.usage` (`source: 'statusline'`): `contextWindow` = `context_window_size`; `contextPct` =
  `used_percentage` when it is a number; `context` = the input-side tokens of `current_usage`; `costUsd` =
  `cost.total_cost_usd`; `model` = `model.id`. Before the first reply `used_percentage` is `null`, so the transcript
  estimate is kept and only the window comes from the status line. `total` keeps its old meaning: input, output and
  cache writes.
- **Account limits** (`Usage.limits`): taken from the freshest update that has `rate_limits`. The reset time is
  `resets_at` × 1000, because Claude sends seconds. `fromAgentId` names the agent that reported them.
- **Totals** (`byAgent`, `bySpace`, `byDay`): from **deltas** of `total_cost_usd`, `total_input_tokens` and
  `total_output_tokens` between updates of the same session. A value that goes down (a new process, `--resume`) starts
  a new baseline, so nothing is counted twice. `byDay` uses the local date.
- **Saving:** `<CC_HOME>/usage.json` (written atomically, debounced at 1 s, and flushed on shutdown). It holds
  `byAgent` (with names and space ids, so removed agents still read well), `bySpace`, `byDay` (about 90 days), the last
  limits, and the window last seen for each model id. `usage.changed` is broadcast at most once a second.

**The transcript fallback.** `usage.js` is used before the first update and for agents without a status line
(`source: 'transcript'`). It never assumes 200k when the window is known. The window is the first of these that exists:
the last status-line window for this agent; the window last seen for this model id (from `usage.json`); 1M if the
model id contains `[1m]`; 1M if the context is already over 200k; otherwise 200k.

**Contract v4 (`packages/shared/protocol.js`).** `AgentStatus.usage` (`AgentUsage`), `Subagent.model`, the `Usage` and
`UsageTotals` types. Method `usage.get`. Event `usage.changed`. HTTP `POST /statusline?agent=<id>` with the same token
rules as `/hook`: 200 `{ok: true}`, or 404 for an unknown agent.

## Milestones

1. **It runs:** core + window + sidebar + one real Claude you type into; Windows installer from CI.
2. **The look:** spaces, tabs, split panes, needs-you, allow/deny, notifications, themes, Board layout.
3. **The brains:** tasks and ◆1–◆5 routing, worktrees, verification gate (fresh reviewer + tests), loadout, usage.
4. **Real numbers:** exact context % from the status line, the account usage meter and Usage view, subagent cards,
   0.3 follow-ups, and an indexer trial (`docs/INDEXER.md`, adopt as opt-in, do not build yet).
