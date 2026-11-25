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

const PROTOCOL_VERSION = 1;

/** Agent states, in the order the sidebar sorts them. */
const STATES = Object.freeze(['needs_you', 'working', 'starting', 'idle', 'stopped', 'exited']);

/** Claude Code hook events the core registers. */
const HOOK_EVENTS = Object.freeze([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest',
  'Notification', 'Stop', 'SubagentStop', 'PreCompact', 'SessionEnd',
]);

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
 * @property {number} createdAt
 */

/**
 * @typedef {Object} AgentStatus
 * @property {string} agentId
 * @property {'needs_you'|'working'|'starting'|'idle'|'stopped'|'exited'} state
 * @property {string} [tool]        tool running now, e.g. "Edit"
 * @property {string} [detail]      e.g. "src/app.py" or "npm test"
 * @property {string} [message]     what it needs, when state = needs_you
 * @property {boolean} [permission] a permission prompt is on screen (allow = key "1", deny = Escape)
 * @property {string} [lastPrompt]
 * @property {{tools:number, turns:number, errors:number, subagents:number}} counts
 * @property {string[]} files       files it edited
 * @property {{total:number, context:number, contextPct:number, model:string}} usage
 * @property {Array<[number,string]>} history   [ms, state] changes, newest last, max 400
 * @property {number} updatedAt
 * @property {number} [needsSince]
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
 * agents.approve   { id }                                           → true      (presses "1" on the permission prompt)
 * agents.deny      { id }                                           → true      (presses Escape)
 *
 * Events (core → app):
 * agent.created    { agent, status }
 * agent.removed    { id }
 * agent.status     AgentStatus                    (every change)
 * agent.output     { id, data }                   (only for attached agents; raw terminal bytes as a string)
 * agent.exit       { id, code }
 * space.changed    { spaces: Space[] }
 * notify           { title, body, agentId? }      (the app shows a native notification)
 */
const METHODS = Object.freeze([
  'hello', 'spaces.list', 'spaces.add', 'spaces.remove',
  'agents.list', 'agents.create', 'agents.stop', 'agents.resume', 'agents.remove',
  'agents.input', 'agents.send', 'agents.resize', 'agents.attach', 'agents.detach',
  'agents.approve', 'agents.deny',
]);

const EVENTS = Object.freeze([
  'agent.created', 'agent.removed', 'agent.status', 'agent.output', 'agent.exit', 'space.changed', 'notify',
]);

const ERRORS = Object.freeze({
  BAD_REQUEST: 'bad_request',
  NOT_FOUND: 'not_found',
  NOT_RUNNING: 'not_running',
  NO_PERMISSION_PENDING: 'no_permission_pending',
  UNAUTHORIZED: 'unauthorized',
  INTERNAL: 'internal',
});

/** Where the core keeps its files. CC_HOME overrides (tests). */
function homeDir() {
  const os = require('os');
  const path = require('path');
  return process.env.CC_HOME || path.join(os.homedir(), '.cc-dashboard');
}

module.exports = { PROTOCOL_VERSION, STATES, HOOK_EVENTS, METHODS, EVENTS, ERRORS, homeDir };
