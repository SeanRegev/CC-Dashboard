# Dashboards in your plugin

CC-Dashboard shows a dashboard for every Claude Code plugin that has one. Users find them on the
**Dashboards** view and open them with one click. This page is for plugin authors: how the app finds
your dashboard, what each kind does, and what the user sees.

## How the app finds it

For every enabled plugin the app reads its manifest, `.claude-plugin/plugin.json` (or `plugin.json` at the
plugin root). The first rule that matches wins:

1. **A `dashboard` field, as a string.**
   - A local address: `http://localhost:PORT` or `http://127.0.0.1:PORT`. It is a *web* dashboard. Your
     server must already be running on that port.
   - A relative path to an HTML file inside the plugin, such as `"dashboard/index.html"`. It is a *page*.
     The path must stay inside the plugin folder and the file must exist.
2. **A `dashboard` field, as an object:** `{ "name", "description", "kind", "command", "file", "url" }`.
   Every field is optional except the ones the kind needs (see the table below).
3. **A `dashboard/index.html` file** in the plugin folder. It is a *page* named after the plugin.
4. **A `homepage` field** with an `http(s)` address. It is a *url*, named after the plugin.

If the `dashboard` field is there but not valid (say, a file that does not exist), the app goes on to the
next rule. A plugin with none of these shows no dashboard.

## The kinds

| `kind` | Needs | What happens when the user opens it |
|---|---|---|
| `terminal` | `command` | Runs the command in a terminal inside CC-Dashboard. Good for a live text view, like a status screen. |
| `web` | `command` that prints a local address, or a local `url` | Runs the command (if any), waits for it to print `http://localhost:…`, then opens that address in a locked-down window. |
| `page` | `file`: an HTML file inside the plugin | Opens the file in a locked-down window. No server needed. |
| `url` | `url`: any `http(s)` address | Opens the address in the user's default browser. |
| `app` | `command` | Starts a separate program (outside CC-Dashboard) and forgets it. |

If `kind` is left out, the app picks one: `command` means `terminal`, `file` means `page`, and `url` means
`web` for a local address or `url` for anything else.

For a `web` dashboard that prints its address, the first `http://localhost` or `http://127.0.0.1` address in its
output is used. If the command stops before it prints one, the app shows its last lines of output as the error.

## Commands need the user's approval

A `command` runs on the user's computer, so the app does not run a plugin's command until the user approves it.
The first time, CC-Dashboard shows the exact command and asks **Trust and run**. The approval is remembered for that
exact command text. If the plugin changes its command, the user is asked again.

Pages, local addresses and `url` dashboards need no approval.

## The locked-down window

Page and web dashboards open in their own window, which:

- is sandboxed, with no preload script and no access to Node or to CC-Dashboard;
- keeps its own session, separate from the rest of the app;
- stays on your file's folder (for a page) or on your server's origin (for a web dashboard). Links to anything
  else open in the user's browser.

Write your dashboard as a normal web page: plain HTML, CSS and JavaScript that talk to your own server or
read files next to them. Do not expect `require`, `process` or the app's own APIs to be there.

## Example

A plugin called `weather-cli`, with a static page as its dashboard:

```
weather-cli/
├── .claude-plugin/
│   └── plugin.json
└── dashboard/
    └── index.html
```

`.claude-plugin/plugin.json`:

```json
{
  "name": "weather-cli",
  "version": "0.3.0",
  "description": "Weather for your terminal, with a page of recent readings.",
  "dashboard": "dashboard/index.html"
}
```

`dashboard/index.html` is any HTML page. It opens in a locked-down window when the user clicks **Open** on the
Dashboards view.

The object form does the same and gives the dashboard its own name. For a dashboard that runs a local server:

```json
{
  "name": "weather-cli",
  "version": "0.3.0",
  "dashboard": {
    "name": "Weather history",
    "kind": "web",
    "command": "node dashboard/server.js",
    "description": "Readings from the last 30 days"
  }
}
```

Here `dashboard/server.js` must print a line with `http://localhost:<port>` when it is ready. The user is asked
to trust `node dashboard/server.js` the first time.
