// @ts-check
'use strict';
/**
 * Status engine: Claude Code hook events -> AgentStatus. Pure functions, no I/O.
 *
 * Ported from the earlier Python deck (hooks.py `apply_event`), whose rules were proven
 * against real Claude Code. Each agent has two objects:
 *   status  the public AgentStatus from packages/shared/protocol.js
 *   rt      internal bookkeeping the app never sees (permAt, answeredAt, turnStartedAt, ...)
 * Both are persisted. All mutation happens in the core process, one call at a time.
 */

const MAX_HISTORY = 400;
const MAX_FILES = 100;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * @typedef {import('./types').AgentStatus} AgentStatus
 * @typedef {import('./types').Runtime} Runtime
 */

/** @param {string} agentId @param {number} [now] @returns {AgentStatus} */
function newStatus(agentId, now = Date.now()) {
  return {
    agentId,
    state: 'starting',
    tool: '',
    detail: '',
    message: '',
    lastPrompt: '',
    counts: { tools: 0, turns: 0, errors: 0, subagents: 0 },
    subagents: { running: 0, total: 0 },
    files: [],
    usage: { total: 0, context: 0, contextPct: 0, model: '' },
    history: [[now, 'starting']],
    updatedAt: now,
  };
}

/** @returns {Runtime} */
function newRuntime() {
  return { permAt: 0, answeredAt: 0, turnStartedAt: 0, doneFrom: 0, transcriptPath: '', launchAt: 0, hookSinceLaunch: false };
}

/**
 * Change state, keep the timeline, and drop needs_you-only fields when leaving needs_you.
 * @param {AgentStatus} s @param {AgentStatus['state']} state @param {number} now
 */
function setState(s, state, now) {
  if (s.state !== state) {
    s.history = [...(s.history || []), /** @type {[number, string]} */ ([now, state])].slice(-MAX_HISTORY);
  }
  if (state !== 'needs_you') {
    delete s.permission;
    delete s.prompt;
    delete s.needsSince;
    delete s.askedBy;
    s.message = '';
  }
  s.state = state;
}

/** One-line summary of a tool call, e.g. the command or file path. */
function summarizeTool(_tool, input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'description', 'query', 'path']) {
    const v = input[key];
    if (typeof v === 'string' && v) return v.split(/\s+/).filter(Boolean).join(' ').slice(0, 200);
  }
  return '';
}

/** "2 subagents running": the session's detail while only its background subagents work. @param {number} n */
function subagentsDetail(n) {
  return `${n} subagent${n === 1 ? '' : 's'} running`;
}

/** Claude starts a turn by itself when a background subagent ends; that prompt is not the user's. */
function isTaskNotification(prompt) {
  return typeof prompt === 'string' && prompt.trimStart().startsWith('<task-notification>');
}

/**
 * The session's own turn is over (or was cut short): idle, or working while background subagents
 * still run. @param {AgentStatus} s @param {number} running @param {number} now
 */
function settle(s, running, now) {
  if (running > 0) {
    setState(s, 'working', now);
    s.tool = 'Agent';
    s.detail = subagentsDetail(running);
  } else {
    setState(s, 'idle', now);
    s.tool = '';
    s.detail = '';
  }
}

/**
 * A tool event means the session is working, unless it is a subagent's and the session's own turn is over:
 * hooks are separate processes, so a subagent's last PostToolUse can reach the core after the Stop (or its
 * SubagentStop). Then nothing follows to settle the session again, so settle it here: working only while
 * background subagents still run. @param {AgentStatus} s @param {string} sid @param {boolean} turnOver
 * @param {number} running @param {number} now
 */
function busy(s, sid, turnOver, running, now) {
  if (sid && turnOver) settle(s, running, now);
  else setState(s, 'working', now);
}

/**
 * A status once a permission prompt is gone without a tool running (denied, closed in the
 * terminal): idle, or working while background subagents still run.
 * @param {AgentStatus} status @param {{running: number, total: number}} [subagents] @param {number} [now]
 */
function restingStatus(status, subagents, now = Date.now()) {
  const s = { ...status, history: [...(status.history || [])], updatedAt: now };
  if (subagents) s.subagents = { running: subagents.running, total: subagents.total };
  settle(s, subagents ? subagents.running : 0, now);
  return s;
}

/** "Claude is waiting for your input" fires after ~60 s idle. It is not a request. */
function isIdleReminder(payload) {
  const kind = String(payload.notification_type || '');
  const msg = String(payload.message || '').toLowerCase();
  return kind === 'idle_prompt' || msg.includes('waiting for your input');
}

/** "needs your permission" Notification that lands after the prompt was already answered. */
function isStalePermissionNotice(rt, payload) {
  if (!String(payload.message || '').toLowerCase().includes('permission')) return false;
  return Boolean(rt.permAt) && (rt.answeredAt || 0) >= rt.permAt;
}

/**
 * Fold one hook event into a copy of the status. Pure.
 *
 * Subagents (v3): an event with `agent_id` comes from one of the session's subagents. Its tools
 * don't change the session's tool / detail or counts.tools, and a permission prompt from it sets
 * askedBy. A prompt on screen is only cleared by events from whoever asked. ctx.subagents (from
 * activity.js, after it saw this event) is copied to status.subagents; after Stop, while some
 * still run, the state stays working ("N subagents running") until the last one ends.
 * rt.doneFrom: start of a turn whose "done" notification waits for its background subagents.
 * @param {AgentStatus} status @param {Runtime} rt @param {string} event @param {any} payload @param {number} [now]
 * @param {{subagents?: {running: number, total: number}}} [ctx]
 * @returns {{status: AgentStatus, rt: Runtime}}
 */
function applyEvent(status, rt, event, payload, now = Date.now(), ctx = {}) {
  /** @type {AgentStatus} */
  const s = { ...status, counts: { ...status.counts }, files: [...(status.files || [])], history: [...(status.history || [])] };
  const r = { ...rt, hookSinceLaunch: true };
  payload = payload && typeof payload === 'object' ? payload : {};
  s.updatedAt = now;
  if (typeof payload.transcript_path === 'string' && payload.transcript_path) r.transcriptPath = payload.transcript_path;
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const counts = s.counts;
  const sid = typeof payload.agent_id === 'string' ? payload.agent_id : '';
  if (ctx && ctx.subagents) s.subagents = { running: ctx.subagents.running, total: ctx.subagents.total };
  const running = (s.subagents && s.subagents.running) || 0;
  // A prompt (or a "needs you" notice) from someone else is on screen: this event doesn't answer it.
  const waitingOnOther = s.state === 'needs_you' && (s.askedBy || '') !== sid;
  const turnOver = !r.turnStartedAt;

  switch (event) {
    case 'SessionStart':
      // After an auto-compact mid-turn Claude fires SessionStart(compact) and keeps working.
      if (!(payload.source === 'compact' && s.state === 'working')) setState(s, 'idle', now);
      break;
    case 'UserPromptSubmit': {
      const notice = isTaskNotification(payload.prompt);
      if (notice && waitingOnOther && s.askedBy) break; // a subagent's prompt is still up
      setState(s, 'working', now);
      if (notice) {
        if (s.tool === 'Agent') { s.tool = ''; s.detail = ''; }
      } else {
        s.lastPrompt = String(payload.prompt ?? '').slice(0, 500);
        r.doneFrom = 0;
      }
      r.turnStartedAt = now;
      break;
    }
    case 'PreToolUse':
      if (!waitingOnOther) busy(s, sid, turnOver, running, now);
      if (!sid) {
        s.tool = tool;
        s.detail = summarizeTool(tool, payload.tool_input);
      }
      break;
    case 'PostToolUse': {
      if (!waitingOnOther) {
        busy(s, sid, turnOver, running, now);
        r.answeredAt = now;
      }
      if (!sid) counts.tools += 1;
      if (EDIT_TOOLS.has(tool)) {
        const ti = payload.tool_input || {};
        const p = ti.file_path || ti.notebook_path;
        if (typeof p === 'string' && p) s.files = [...s.files.filter((f) => f !== p), p].slice(-MAX_FILES);
      }
      const resp = payload.tool_response;
      if (!sid && resp && typeof resp === 'object' && (resp.is_error || resp.interrupted)) counts.errors += 1;
      break;
    }
    case 'PermissionRequest': {
      const detail = summarizeTool(tool, payload.tool_input);
      setState(s, 'needs_you', now);
      s.needsSince = now;
      if (!sid) {
        s.tool = tool;
        s.detail = detail;
      }
      s.message = `Wants to use ${tool || 'a tool'}` + (detail ? `: ${detail}` : '');
      s.permission = true;
      if (sid) s.askedBy = sid;
      else delete s.askedBy;
      delete s.prompt; // a new request: the core reads the new prompt off the screen
      r.permAt = now;
      break;
    }
    case 'Notification':
      if (isIdleReminder(payload)) break;
      if (isStalePermissionNotice(r, payload)) break;
      if (s.state !== 'needs_you') {
        setState(s, 'needs_you', now);
        s.needsSince = now;
        s.message = String(payload.message || 'Claude needs you').slice(0, 300);
      }
      break;
    case 'Stop':
      counts.turns += 1;
      if (running > 0) r.doneFrom = r.doneFrom || r.turnStartedAt;
      else r.doneFrom = 0; // core.alert() reads the runtime from before this event
      r.turnStartedAt = 0;
      if (waitingOnOther && s.askedBy) break; // a subagent's prompt is still up
      settle(s, running, now);
      break;
    case 'SubagentStart':
      if (turnOver && (s.state === 'working' || s.state === 'idle')) settle(s, running, now);
      break;
    case 'SubagentStop':
      counts.subagents += 1;
      if (s.state === 'needs_you' && sid && s.askedBy === sid) {
        // It asked, then ended: that prompt is gone.
        if (turnOver) settle(s, running, now);
        else setState(s, 'working', now);
      } else if (turnOver && s.state === 'working') {
        settle(s, running, now);
      }
      if (s.state === 'idle') r.doneFrom = 0;
      break;
    case 'PreCompact':
      s.detail = 'compacting context';
      break;
    case 'SessionEnd':
      setState(s, 'exited', now);
      s.tool = '';
      s.detail = String(payload.reason || '');
      r.doneFrom = 0;
      break;
    default:
      break;
  }
  return { status: s, rt: r };
}

/**
 * Change state from outside a hook (launch, stop, approve, deny, timers).
 * @param {AgentStatus} status @param {AgentStatus['state']} state @param {Partial<AgentStatus>} [fields] @param {number} [now]
 */
function withState(status, state, fields = {}, now = Date.now()) {
  const s = { ...status, history: [...(status.history || [])], ...fields, updatedAt: now };
  setState(s, state, now);
  Object.assign(s, fieldsAfterState(fields));
  return s;
}

// Fields like message/permission given explicitly survive the setState cleanup.
function fieldsAfterState(fields) {
  /** @type {any} */
  const out = {};
  for (const k of ['message', 'permission', 'prompt', 'needsSince']) if (k in fields) out[k] = fields[k];
  return out;
}

module.exports = {
  MAX_HISTORY, MAX_FILES, EDIT_TOOLS,
  newStatus, newRuntime, setState, applyEvent, withState, summarizeTool, isIdleReminder, isStalePermissionNotice,
  subagentsDetail, isTaskNotification, restingStatus,
};
