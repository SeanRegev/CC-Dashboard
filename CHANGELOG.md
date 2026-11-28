# Changelog

## 0.4.0

- **Exact context %.** The context number now comes from Claude's own status line, not from a guess. A session with a
  1M window used to show about five times too high (10% showed as 49%), because the app assumed a 200k window.
- **Context text.** The gauge reads "98k / 1M (10%)": the context used, the window, and the percentage. A transcript
  estimate is marked with "~". The old "75k tokens" item is gone.
- **Usage meter** in the top bar: "5h 62% · resets 16:20 / week 31%". It is amber at 75% and red at 90%. The tooltip
  says when it was read and which agent reported it. If the reset time has passed, it says so instead of showing an
  old number.
- **Usage view** (Ctrl+Shift+U): cost and tokens per agent, per space and per day. It is labelled "API-equivalent
  estimate": on a subscription it is not a bill. Removed agents keep their saved name.
- **New agent warning.** The New agent dialog warns when the 5-hour limit is at 90% or more.
- **Subagent cards.** Each subagent shows its title, its type, its state, its current tool and its model. They appear
  as indented cards under the session in the sidebar (collapsible, finished ones fold into "✓ N done"), as a row
  under each grid tile (replacing the strip of chips), and as a bar in the Terminals view. A click opens the activity
  drawer for that subagent.
- **Your own status line keeps working.** The app registers its own status line for each agent. It runs the status
  line you already have (from your settings files), so you still see it inside agents. Without one, the app shows a
  short default line.
- **Allow and Deny when the prompt header has scrolled away.** In a short grid tile the app now reads the permission
  request from Claude's hook and still offers Allow and Deny. The check that the prompt has not changed still applies.
- **Stricter Take over check.** A `node` or `bun` process counts as Claude only when it runs Claude's own script. A
  program that only has "claude" in its command line does not.
- **Lighter tailing of outside sessions.** Finished subagents are not read again while their files stay the same.
- **Indexer trial.** Measured on a sample repo with Haiku: a code index (codegraph) made code questions about twice as
  fast, with the same answers, but cost the same. Adopt it later as an opt-in item; do not build our own now. See
  [docs/INDEXER.md](docs/INDEXER.md).

## 0.3.0

- **Subagents.** Each helper agent a session starts (Claude's Agent or Task tool) shows under its session with a
  title, its type, its state and what it is doing. Grid tiles show a strip of the running ones, and the approval
  card says which subagent asked. Needs Claude Code 2.0.43 or newer.
- **Activity log and drawer** (Ctrl+Shift+Y, or Activity in an agent's menu). Every prompt, tool call, permission
  prompt, error and subagent is logged from Claude Code's hook events. Nothing is sent to a model, so the log uses
  no tokens. Logs are kept across restarts and trimmed past 2 MB. Click a subagent to filter the feed.
- **Sessions started outside the app.** Claude Code sessions from a terminal or editor appear as view-only tiles
  under their project, and under Other folders when they are outside every project (Add as space). They have no
  typing and no Allow or Deny.
- **Take over.** Moves an outside session into the app: ends its process, then reopens the same conversation with
  `claude --resume` in the same folder. A busy session needs the confirmation "End it and take over". Take over
  refuses when it cannot confirm the process is that Claude session, or when the conversation is open in more than
  one place. The activity log carries over.

## 0.2.0

- **Session roles.** Every agent wears a role tab: 👑 Main, 🔧 Worker, 🔍 Reviewer, 🔭 Research, 🧪 Tests,
  📝 Docs, 🐛 Debug, 🎨 Design, or your own label and emoji. One Main per project: the first agent is Main,
  and Make Main moves the crown. Change a role or rename an agent with F2 or from the right-click menu.
- **Project grid.** Click a project to see all its agents as live terminals, two per row. Main comes first,
  then the agents that need you. Double-click a tile to expand it; "← Back to grid" returns. Only tiles on or
  next to the screen keep a live terminal.
- **Allow, Always and Deny from the sidebar, grid, board and Inbox.** Answer a permission prompt without opening
  the terminal. Always appears only when Claude offers "don't ask again". The app checks that the prompt on
  screen is still the one you saw before it answers; if it cannot read the prompt, it offers Open instead.
- **Inbox** (Ctrl+Shift+A): every prompt that needs you. J/K move, A allow, S always, D deny, Enter open.
- **Board** (Ctrl+Shift+B): agents in four columns, Needs you, Working, Done and Stopped.
- **Library** (Ctrl+Shift+L): your plugins and skills. Turn plugins and skills on or off, install from
  marketplaces, update (a badge shows when a newer version exists), configure and uninstall. Skills can be read,
  edited, created, deleted (to the Recycle Bin) and tried. Plugins that your organization manages or that are
  built in can be turned on and off but not updated or removed. After a change, Restart the agents that use the
  old plugins.
- **Dashboards** (Ctrl+Shift+D): CodeBurn built in (terminal or web), dashboards from your plugins found
  automatically, and your own (a command or a URL). A plugin's command runs only after you approve it. Web
  dashboards open in a locked-down window. See [docs/PLUGIN-DASHBOARDS.md](docs/PLUGIN-DASHBOARDS.md).
- **Settings** (Ctrl+,): Dark, Light or System theme; terminal font and size; notifications for all events,
  only when an agent needs you, or off; sound.
- **Quit and stop all agents** in Settings and in the ⋯ menu.
- **Keyboard:** Ctrl+Shift+T / G / B / A / L / D switch views. Plain Ctrl+B, Ctrl+L and Ctrl+I stay with the terminal.
- **Fix:** agents started from inside a Claude Code session keep their transcripts.
- **Fix:** a status change is saved before it is announced, so a restart does not lose it.

## 0.1.0

- First release: spaces, agents with live terminals, "needs you" status, split view, quick switcher,
  notifications, and the Windows installer.
