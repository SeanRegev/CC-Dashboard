// @ts-check
'use strict';
/**
 * The contract between cc-core and the desktop app. Changes here need the lead.
 *
 * Transport: WebSocket at ws://127.0.0.1:<port>/rpc?token=<token>
 * Messages are JSON:
 *   request   { "id": 7, "method": "agents.create", "params": { ... } }
 *   response  { "id": 7, "result": ... }            or { "id": 7, "error": { "code", "message" } }
 *   event     { "event": "agent.status", "data": { ... } }   (pushed by the core, no id)
 *
 * HTTP (same port, token required as ?token= or header x-cc-token):
 *   POST /hook?agent=<agentId>   body = Claude Code hook payload JSON, header x-cc-event: <EventName>
 *   GET  /health                 -> { ok: true, version }
 */

const PROTOCOL_VERSION = 3;

/** Agent states, in the order the sidebar sorts them. */
const STATES = Object.freeze(['needs_you', 'working', 'starting', 'idle', 'stopped', 'exited']);

/**
 * Session roles: the label + emoji every agent wears (👑 Main, 🔧 Worker, ...). One Main per space:
 * the core gives the first agent of a space Main, and moving Main to another agent makes the old
 * one a Worker. Custom roles use id 'custom' with the user's own label and emoji.
 * The renderer keeps an identical copy in packages/app/src/renderer/roles.js (a test checks it).
 */
const ROLES = Object.freeze([
  Object.freeze({ id: 'main', label: 'Main', emoji: '👑' }),
  Object.freeze({ id: 'worker', label: 'Worker', emoji: '🔧' }),
  Object.freeze({ id: 'reviewer', label: 'Reviewer', emoji: '🔍' }),
  Object.freeze({ id: 'research', label: 'Research', emoji: '🔭' }),
  Object.freeze({ id: 'tests', label: 'Tests', emoji: '🧪' }),
  Object.freeze({ id: 'docs', label: 'Docs', emoji: '📝' }),
  Object.freeze({ id: 'debug', label: 'Debug', emoji: '🐛' }),
  Object.freeze({ id: 'design', label: 'Design', emoji: '🎨' }),
]);

/** Claude Code hook events the core registers. */
const HOOK_EVENTS = Object.freeze([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest',
  'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact', 'SessionEnd',
]);

/**
 * Subagent types Claude Code ships, with the emoji the app shows next to a subagent's title (v3).
 * Any other type (a plugin's or the user's own agent) shows SUBAGENT_DEFAULT_EMOJI.
 */
const SUBAGENT_TYPES = Object.freeze([
  Object.freeze({ id: 'general-purpose', label: 'General', emoji: '🔧' }),
  Object.freeze({ id: 'Explore', label: 'Explore', emoji: '🔭' }),
  Object.freeze({ id: 'Plan', label: 'Plan', emoji: '📐' }),
  Object.freeze({ id: 'statusline-setup', label: 'Status line', emoji: '⚙️' }),
  Object.freeze({ id: 'claude-code-guide', label: 'Guide', emoji: '📖' }),
]);
const SUBAGENT_DEFAULT_EMOJI = '🤖';

/**
 * @typedef {Object} Space          A project folder (usually a git repo). Sidebar group.
 * @property {string} id            slug, unique
 * @property {string} name
 * @property {string} path          absolute folder path
 * @property {number} createdAt     ms epoch
 */

/**
 * @typedef {Object} Agent          One Claude Code session.
 * @property {string} id            slug, unique across spaces
 * @property {string} spaceId
 * @property {string} name
 * @property {string} cwd           where claude runs (the space path, or a worktree)
 * @property {string} sessionId     uuid passed as --session-id / --resume
 * @property {string} [model]       haiku | sonnet | opus | full model id | '' (default)
 * @property {string} [effort]      low | medium | high | xhigh | max | ''
 * @property {string} [mode]        '' | acceptEdits | plan   (Claude --permission-mode)
 * @property {string} [prompt]      first message, if any
 * @property {string} [worktree]    absolute worktree path, if it has its own
 * @property {string} [branch]
 * @property {string} [taskId]      milestone 3
 * @property {Role} role            always set by the core (v2)
 * @property {number} createdAt
 */

/**
 * @typedef {Object} Role
 * @property {string} id            one of ROLES ids, or 'custom'
 * @property {string} label         e.g. "Main"; up to 24 characters
 * @property {string} emoji         one emoji (or a short symbol); may be ''
 */

/**
 * @typedef {Object} PermissionPrompt   What a permission prompt on screen asks, read by the core.
 * @property {string} id            fingerprint of the prompt as it is on screen now; changes whenever the prompt does
 * @property {string} tool          e.g. "Bash", "Edit", "WebFetch", "mcp__github__create_issue"
 * @property {string} detail        e.g. the command, the file, the URL
 * @property {string} question      e.g. "Do you want to proceed?"
 * @property {Array<{key: string, label: string, kind: 'allow'|'allow_always'|'allow_other'|'deny'}>} options
 *                                  in screen order; key is what selects it (e.g. "1"); kind is how the core
 *                                  classified the wording ("Yes" → allow, "Yes, and don't ask again …" → allow_always,
 *                                  "No" → deny, anything else → allow_other)
 */

/**
 * @typedef {Object} AgentStatus
 * @property {string} agentId
 * @property {'needs_you'|'working'|'starting'|'idle'|'stopped'|'exited'} state
 * @property {string} [tool]        tool running now, e.g. "Edit"
 * @property {string} [detail]      e.g. "src/app.py" or "npm test"
 * @property {string} [message]     what it needs, when state = needs_you
 * @property {boolean} [permission] a permission prompt is on screen (allow = key "1", deny = Escape)
 * @property {PermissionPrompt} [prompt]  set with permission when the core could read the prompt (v2); absent
 *                                  means "a prompt the core can't read": the app sends the user to the terminal
 * @property {string} [lastPrompt]
 * @property {{tools:number, turns:number, errors:number, subagents:number}} counts
 * @property {string[]} files       files it edited
 * @property {{total:number, context:number, contextPct:number, model:string}} usage
 * @property {Array<[number,string]>} history   [ms, state] changes, newest last, max 400
 * @property {number} updatedAt
 * @property {number} [needsSince]
 * @property {{running: number, total: number}} [subagents]   (v3) this session's subagents; while any runs in the
 *                                  background after the session's own turn ended, state stays 'working'
 * @property {string} [askedBy]     (v3) with permission: the Subagent id whose tool the prompt is for ('' or absent = the session)
 */

/**
 * @typedef {Object} Subagent       (v3) A helper a session started with its Agent (or Task) tool.
 *                                  Built only from hook events (and, for outside sessions, Claude's transcript
 *                                  files): no model call, no tokens.
 * @property {string} id            Claude's agent_id (e.g. "ae0d14e7ad2db2bf5")
 * @property {string} agentId       the session it belongs to: an Agent id, or an outside session's id ("ext:<sessionId>")
 * @property {string} title         the short description the parent gave it ("Count files here"); the type's label when none
 * @property {string} type          agent_type, e.g. "general-purpose", "Explore", "Plan", or a plugin's agent
 * @property {'running'|'done'|'failed'|'stopped'} state
 *                                  stopped: the session ended (or was stopped) while it was running
 * @property {boolean} background   it runs while the parent goes on (Claude's "run in background")
 * @property {string} [tool]        tool it is running now
 * @property {string} [detail]      e.g. the command or file
 * @property {boolean} [needsYou]   a permission prompt on screen came from this subagent
 * @property {{tools: number, errors: number}} counts
 * @property {string} [summary]     the start of its final message (max 500 characters), once done
 * @property {number} startedAt
 * @property {number} [endedAt]
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} ActivityEntry  (v3) One line of a session's activity log.
 * @property {number} seq           increases by 1 per entry within one log (agentId); never reused
 * @property {number} at            ms epoch
 * @property {string} subagentId    '' = the session itself; else a Subagent id
 * @property {'prompt'|'tool'|'tool_done'|'tool_error'|'permission'|'subagent_start'|'subagent_end'|'turn_end'|'session_start'|'session_end'|'notice'} kind
 * @property {string} [tool]        tool / tool_done / tool_error / permission
 * @property {string} [detail]      command, file, URL, pattern... (max 300 characters)
 * @property {number} [ms]          tool_done / tool_error: how long the tool took
 * @property {string} [text]        prompt: what the user asked; subagent_start: title; subagent_end: summary;
 *                                  turn_end: start of the last message; notice: what happened (max 500 characters)
 * @property {string} [type]        subagent_start: the subagent type
 */

/**
 * @typedef {Object} ExternalSession  (v3) A Claude Code session running on this computer that CC-Dashboard did not start.
 *                                  Read from Claude's running-session files (<claude config>/sessions/*.json) and its transcript.
 *                                  View only: the app has no terminal for it. external.takeOver moves it into the app.
 * @property {string} id            "ext:<sessionId>"
 * @property {string} sessionId
 * @property {number} pid
 * @property {string} cwd
 * @property {string} [spaceId]     the space whose folder is cwd or contains it
 * @property {string} name          the session's name, else the folder name
 * @property {'working'|'idle'|'needs_you'|'unknown'} state
 * @property {string} [tool]        last tool it ran (from the transcript)
 * @property {string} [detail]
 * @property {string} [lastPrompt]
 * @property {string} [entrypoint]  where it runs, as Claude reports it: "cli", "vscode", "jetbrains", ...
 * @property {string} [version]     its Claude Code version
 * @property {number} startedAt
 * @property {number} updatedAt
 * @property {{running: number, total: number}} subagents
 */

/**
 * @typedef {Object} LibraryPlugin
 * @property {string} id            e.g. "engineering@claude-plugins-official" (as `claude plugin list --json` prints it)
 * @property {string} name
 * @property {string} version       'unknown' for built-in plugins
 * @property {string} scope         user | project | local | synced | managed | builtin ...
 * @property {boolean} enabled
 * @property {string} [installPath] absent for built-in plugins
 * @property {string} [description]
 * @property {string} [author]
 * @property {string} [homepage]
 * @property {string} [repository]
 * @property {string} [logo]        absolute path of a logo file inside installPath
 * @property {string} [marketplace]
 * @property {boolean} managed      true when the user can't change it here (synced by an organization, built in)
 * @property {{skills: string[], agents: string[], commands: string[], hooks: number, mcpServers: string[]}} components
 * @property {{alwaysOn?: number}} [tokens]   from `claude plugin details`, when it could be read
 * @property {boolean} [hasConfig]  it has options (`claude plugin configure`)
 * @property {boolean} [updateAvailable]
 * @property {string[]} [dashboards] ids of Dashboard entries this plugin provides
 */

/**
 * @typedef {Object} LibrarySkill
 * @property {string} id            stable: "<source>:<name>" e.g. "user:pdf", "project:weather-cli:deploy", "plugin:engineering@x:debug"
 * @property {string} name
 * @property {string} description
 * @property {'user'|'project'|'plugin'} source
 * @property {string} [spaceId]     source = project
 * @property {string} [pluginId]    source = plugin
 * @property {string} path          absolute path of SKILL.md
 * @property {boolean} deletable    user and project skills; never plugin skills (they come back on update)
 */

/**
 * @typedef {Object} Library
 * @property {LibraryPlugin[]} plugins
 * @property {LibrarySkill[]} skills
 * @property {Array<{name: string, source: string, lastUpdated?: string}>} marketplaces
 * @property {number} scannedAt
 * @property {string[]} errors      non-fatal problems while scanning (e.g. "claude not found")
 */

/**
 * @typedef {Object} Dashboard      Something with a dashboard the app can open.
 * @property {string} id
 * @property {string} name
 * @property {'terminal'|'web'|'page'|'url'|'app'} kind
 *                                  terminal: a command run in a CC-Dashboard terminal tab (e.g. `npx codeburn`)
 *                                  web: a command that serves a local page; the app opens the URL it prints
 *                                  page: an HTML file (inside a plugin); url: a web address; app: a program to launch
 * @property {'builtin'|'plugin'|'user'} source
 * @property {string} [pluginId]
 * @property {string} [command]     terminal / web / app
 * @property {string} [url]         url
 * @property {string} [file]        page: absolute path
 * @property {string} [cwd]
 * @property {boolean} available    builtin entries: the tool is installed
 * @property {boolean} trusted      commands from plugins need the user to confirm once (dashboards.trust)
 * @property {string} [description]
 */

/**
 * RPC methods. Params → result.
 *
 * hello            { clientName }                                   → { version, protocol: PROTOCOL_VERSION }
 * spaces.list      {}                                               → Space[]
 * spaces.add       { path, name? }                                  → Space
 * spaces.remove    { id }                                           → true      (stops nothing; agents keep their records)
 * agents.list      {}                                               → Array<{ agent: Agent, status: AgentStatus, running: boolean }>
 * agents.create    { spaceId, name, prompt?, model?, effort?, mode?, worktree? } → Agent   (starts it)
 * agents.stop      { id }                                           → true      (kills the process; record and chat kept)
 * agents.resume    { id }                                           → true      (claude --resume <sessionId>)
 * agents.remove    { id }                                           → true
 * agents.input     { id, data }                                     → true      (raw keystrokes to the PTY)
 * agents.send      { id, text }                                     → true      (types text, then Enter)
 * agents.resize    { id, cols, rows }                               → true
 * agents.attach    { id }                                           → { replay: string }  then agent.output events flow
 * agents.detach    { id }                                           → true
 * agents.approve   { id, promptId?, choice? }                       → true      choice: 'allow' (default) | 'allow_always'.
 *                                                                               With promptId (v2) the core re-reads the screen and refuses
 *                                                                               with prompt_changed unless the same prompt is still there, then
 *                                                                               presses the option of that kind (never by position alone).
 *                                                                               Without promptId: presses "1" (v1 behaviour).
 * agents.deny      { id, promptId? }                                → true      (Escape; promptId checked the same way)
 * agents.update    { id, name?, role? }                             → Agent     role: { id, label?, emoji? }; role.id 'main' moves Main
 *                                                                               to this agent (the old Main becomes a Worker)
 * agents.restart   { id }                                           → true      stop + resume the same conversation (picks up new plugins)
 *
 * core.shutdown    {}                                               → true      stops every agent (records kept), saves, then the core exits
 *
 * library.list     { refresh? }                                     → Library   cached; refresh rescans (plugins via `claude plugin list --json`)
 * library.available  {}                                              → Array<{ id, name, description?, marketplace, installed: boolean }>
 * library.pluginAction  { id, action, keepData?, acceptCommand? }    → { ok: boolean, message: string, confirm?: { command: string, sha256: string } }
 *                                                                     action: install | uninstall | update | enable | disable.
 *                                                                     confirm: the install/update needs a command run; ask the user,
 *                                                                     then call again with acceptCommand = sha256.
 * library.configure  { id, values? }                                 → { options: Array<{ key, title?, description?, type, default?, options? }>, values: Object }
 *                                                                     without values: read; with values: save, then read back
 * library.marketplace  { action, source?, name? }                    → { ok, message }   action: add (source) | remove (name) | update (name?)
 * library.skillRead  { id }                                          → { content: string }
 * library.skillWrite  { id?, scope?, spaceId?, name?, content }      → LibrarySkill   id: save an existing user/project skill;
 *                                                                     else create scope ('user'|'project') + spaceId + name
 *                                                                     (Deleting a skill is done by the app: the main process moves the
 *                                                                     folder to the system trash, then calls library.list { refresh: true }.)
 *
 * dashboards.list  {}                                               → Dashboard[]
 * dashboards.add   { name, kind, command?, url?, cwd? }             → Dashboard  (source 'user', trusted)
 * dashboards.remove  { id }                                          → true      (user entries only)
 * dashboards.trust  { id }                                           → Dashboard  (the user confirmed a plugin's command)
 * dashboards.start  { id }                                           → { url? }   terminal: starts it (attach to see it); web: starts it and
 *                                                                               resolves with the local URL it printed. Refuses untrusted commands.
 * dashboards.stop  { id }                                           → true
 * dashboards.attach  { id }                                          → { replay: string }  then dashboard.output events flow (terminal kind)
 * dashboards.detach  { id }                                          → true
 * dashboards.input  { id, data }                                     → true
 * dashboards.resize  { id, cols, rows }                              → true
 *
 * subagents.list   { agentId }                                      → Subagent[]  oldest first (agentId: an Agent id or "ext:<sessionId>")
 * activity.list    { agentId, subagentId?, before?, limit? }        → { entries: ActivityEntry[], more: boolean }
 *                                                                     newest last; before = seq (older page); limit default 200, max 1000;
 *                                                                     subagentId filters ('' = only the session's own lines)
 * external.list    {}                                               → ExternalSession[]
 * external.takeOver  { id, spaceId?, name?, force? }                 → Agent  ends the outside process (only when it is idle, unless force),
 *                                                                     waits for it to exit, then resumes the same conversation here
 *                                                                     (claude --resume <sessionId> in its cwd). Refuses with still_working
 *                                                                     when it is busy and force is not set; not_allowed when the process
 *                                                                     can't be confirmed to be that Claude session. spaceId default: the
 *                                                                     matching space, else a new space for cwd.
 *
 * Events (core → app):
 * agent.created    { agent, status }
 * agent.removed    { id }
 * agent.status     AgentStatus                    (every change)
 * agent.output     { id, data }                   (only for attached agents; raw terminal bytes as a string)
 * agent.exit       { id, code }
 * space.changed    { spaces: Space[] }
 * notify           { title, body, agentId?, kind? }  (the app shows a native notification; kind (v2): 'needs_you' | 'done' | 'exited' | 'info')
 * agent.updated    { agent }                      (v2: name or role changed; also sent for the agent that lost Main)
 * library.changed  { library }                    (v2: after a rescan or any library action)
 * dashboard.output  { id, data }                   (v2: terminal dashboards, attached clients only)
 * dashboard.exit   { id, code }                   (v2)
 * dashboards.changed  { dashboards }               (v2)
 * subagent.updated  { agentId, subagent }          (v3: started, tool changed, ended)
 * activity         { agentId, entries }           (v3: new log lines, in seq order; agentId may be "ext:<sessionId>")
 * external.changed  { sessions }                   (v3: the list of outside sessions changed)
 */
const METHODS = Object.freeze([
  'hello', 'spaces.list', 'spaces.add', 'spaces.remove',
  'agents.list', 'agents.create', 'agents.stop', 'agents.resume', 'agents.remove',
  'agents.input', 'agents.send', 'agents.resize', 'agents.attach', 'agents.detach',
  'agents.approve', 'agents.deny', 'agents.update', 'agents.restart',
  'core.shutdown',
  'library.list', 'library.available', 'library.pluginAction', 'library.configure', 'library.marketplace',
  'library.skillRead', 'library.skillWrite',
  'dashboards.list', 'dashboards.add', 'dashboards.remove', 'dashboards.trust', 'dashboards.start', 'dashboards.stop',
  'dashboards.attach', 'dashboards.detach', 'dashboards.input', 'dashboards.resize',
  'subagents.list', 'activity.list', 'external.list', 'external.takeOver',
]);

const EVENTS = Object.freeze([
  'agent.created', 'agent.removed', 'agent.status', 'agent.output', 'agent.exit', 'space.changed', 'notify',
  'agent.updated', 'library.changed', 'dashboard.output', 'dashboard.exit', 'dashboards.changed',
  'subagent.updated', 'activity', 'external.changed',
]);

const ERRORS = Object.freeze({
  BAD_REQUEST: 'bad_request',
  NOT_FOUND: 'not_found',
  NOT_RUNNING: 'not_running',
  NO_PERMISSION_PENDING: 'no_permission_pending',
  PROMPT_CHANGED: 'prompt_changed',      // v2: the prompt on screen is not the one the user answered
  NOT_ALLOWED: 'not_allowed',            // v2: e.g. a managed plugin, an untrusted dashboard command
  NOT_IMPLEMENTED: 'not_implemented',    // v2: groundwork stubs until a track lands
  STILL_WORKING: 'still_working',        // v3: external.takeOver on a busy session without force
  UNAUTHORIZED: 'unauthorized',
  INTERNAL: 'internal',
});

/** Where the core keeps its files. CC_HOME overrides (tests). */
function homeDir() {
  const os = require('os');
  const path = require('path');
  return process.env.CC_HOME || path.join(os.homedir(), '.cc-dashboard');
}

module.exports = { PROTOCOL_VERSION, STATES, ROLES, HOOK_EVENTS, SUBAGENT_TYPES, SUBAGENT_DEFAULT_EMOJI, METHODS, EVENTS, ERRORS, homeDir };
