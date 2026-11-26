# Changelog

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
