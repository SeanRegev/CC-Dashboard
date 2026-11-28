// @ts-check
'use strict';
/**
 * Subagents and the activity log of the sessions CC-Dashboard started (contract v3). Owner: the
 * Subagents track (docs/M3.md). Everything here comes from hook events: no model call, no tokens.
 *
 *   SessionLog   pure bookkeeping for one agent: hook event -> ActivityEntry lines + Subagent changes
 *                (titles, states, current tool, needs-you). Only I/O: reading a subagent's meta.json.
 *   Activity     the core's side: one SessionLog per agent, files, events, status sync.
 *
 * Files, in <CC_HOME>/activity/:
 *   <agentId>.jsonl            one ActivityEntry per line, appended (batched <= 250 ms; lines that change
 *                              state are written at once, because on Windows the core can be hard-killed).
 *                              Past 2 MB it is rewritten (atomically) with its last 5000 entries.
 *   <agentId>.subagents.json   { version, subagents: Subagent[], titles } written on every state change.
 */
const fs = require('fs');
const path = require('path');
const { ERRORS, SUBAGENT_TYPES } = require('../../shared/protocol');
const { RpcError } = require('./errors');
const { summarizeTool, isIdleReminder, isTaskNotification } = require('./status');
const { writeFileAtomic, readJson } = require('./store');

const DETAIL_MAX = 300;
const TEXT_MAX = 500;
const TITLE_MAX = 200;
const MEM_TAIL = 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_ON_ROTATE = 5000;
const FLUSH_MS = 250;
const EVENT_MS = 100;
const SUB_EVENT_MS = 50;
const LIST_DEFAULT = 200;
const LIST_MAX = 1000;
/** How often a subagent with a stand-in title looks for its meta.json again (once per event). */
const META_TRIES = 30;
const MAX_QUEUE = 50;
const MAX_TOOL_STARTS = 500;
/** Subagents kept per session (memory and subagents.json); past it the oldest finished ones are dropped. */
const MAX_SUBAGENTS = 500;
const FILES_VERSION = 1;
/** Kinds written to disk at once; the others (tool calls, many per second) wait for the batch. */
const BATCHED_KINDS = new Set(['tool', 'tool_done', 'tool_error']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
/** Ids Claude gives subagents and sessions; anything else never becomes part of a file path. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * @typedef {import('./types').Subagent} Subagent
 * @typedef {import('./types').ActivityEntry} ActivityEntry
 * @typedef {{toolUseId: string, title: string, type: string, background: boolean, at: number, model?: string}} AgentCall
 *          one Agent / Task tool call, from its PreToolUse
 * @typedef {{src: 'call'|'meta'|'tasks'|'fallback', callId?: string, tries?: number}} TitleInfo
 * @typedef {{entries: ActivityEntry[], changed: Set<string>, urgent: boolean, internal?: boolean}} ApplyResult  internal: a hidden Claude helper (ignored)
 */

// ---- pure helpers ---------------------------------------------------------------------------

/** @param {any} v @param {number} max */
function clip(v, max) {
  if (typeof v !== 'string' || !v) return '';
  return v.length > max ? v.slice(0, max) : v;
}

/** @param {any} v */
function str(v) { return typeof v === 'string' ? v : ''; }

/** The label a type shows when a subagent has no title of its own. @param {string} type */
function typeLabel(type) {
  const t = SUBAGENT_TYPES.find((x) => x.id === type);
  return t ? t.label : (type || 'Subagent');
}

/** Did this tool call fail? Never looks at more than the error flags. @param {any} resp */
function toolFailed(resp) {
  if (!resp || typeof resp !== 'object') return false;
  if (resp.is_error === true || resp.isError === true || resp.interrupted === true) return true;
  return typeof resp.status === 'string' && /^(failed|error|errored)$/i.test(resp.status);
}

/** Subagent state from a task notification's <status>. @param {string} status @returns {Subagent['state']} */
function stateFromTaskStatus(status) {
  const s = status.toLowerCase();
  if (/^(failed|error|errored)$/.test(s)) return 'failed';
  if (/^(killed|stopped|cancelled|canceled|aborted)$/.test(s)) return 'stopped';
  return 'done';
}

/**
 * The parts of a `<task-notification>` prompt we use. Claude writes it when a background
 * subagent ends and then starts a turn by itself.
 * @param {any} prompt
 * @returns {{taskId: string, toolUseId: string, status: string, summary: string, result: string, title: string}|null}
 */
function parseTaskNotification(prompt) {
  if (!isTaskNotification(prompt)) return null;
  const tag = (/** @type {string} */ name) => {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(prompt);
    return m ? m[1].trim() : '';
  };
  const summary = tag('summary');
  // e.g. 'Agent "Count files here" finished'
  const q = /"([^"]{1,200})"/.exec(summary);
  return { taskId: tag('task-id'), toolUseId: tag('tool-use-id'), status: tag('status'), summary, result: tag('result'), title: q ? q[1] : '' };
}

/**
 * Where Claude keeps a subagent's meta.json: next to the session transcript,
 * <dir>/<sessionId>/subagents/agent-<agentId>.meta.json. '' when the ids don't look like Claude's.
 * @param {string} transcriptPath @param {string} sessionId @param {string} agentId
 */
function metaPath(transcriptPath, sessionId, agentId) {
  if (!transcriptPath || !SAFE_ID.test(sessionId) || !SAFE_ID.test(agentId)) return '';
  return path.join(path.dirname(transcriptPath), sessionId, 'subagents', `agent-${agentId}.meta.json`);
}

/** Device names Windows reserves, with or without an extension. */
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** File name (without extension) for an agent's files; safe on Windows. @param {string} agentId */
function fileBase(agentId) {
  const safe = String(agentId).replace(/[^A-Za-z0-9_-]/g, (c) => `%${c.charCodeAt(0).toString(16)}`) || '_';
  return WIN_RESERVED.test(safe) ? `${safe}_` : safe;
}

/** @param {string} file @returns {any} null when missing or not JSON */
function defaultReadMeta(file) {
  return readJson(file);
}

// ---- one agent's log and subagents (pure apart from meta.json reads) ------------------------

class SessionLog {
  /**
   * @param {string} agentId
   * @param {{memTail?: number, readMeta?: (file: string) => any}} [opts]
   */
  constructor(agentId, opts = {}) {
    this.agentId = agentId;
    this.memTail = opts.memTail || MEM_TAIL;
    this.readMeta = opts.readMeta || defaultReadMeta;
    /** last seq given out */
    this.seq = 0;
    /** @type {ActivityEntry[]} newest last, at most memTail */
    this.entries = [];
    /** smallest seq still kept anywhere (file or memory); 0 = none yet */
    this.firstSeq = 0;
    /** @type {Map<string, Subagent>} oldest first */
    this.subagents = new Map();
    /** @type {Map<string, TitleInfo>} where each subagent's title came from */
    this.titles = new Map();
    /** @type {AgentCall[]} Agent calls not yet paired with a subagent, oldest first */
    this.queue = [];
    /** @type {Map<string, AgentCall>} every Agent call seen (by tool_use_id), for corrections */
    this.calls = new Map();
    /** @type {Map<string, AgentCall>} calls paired by PostToolUse(agentId) before their SubagentStart */
    this.paired = new Map();
    /** @type {Map<string, number>} tool_use_id -> when its PreToolUse came */
    this.toolStarts = new Map();
  }

  /** @returns {{running: number, total: number}} */
  counts() {
    let running = 0;
    for (const s of this.subagents.values()) if (s.state === 'running') running++;
    return { running, total: this.subagents.size };
  }

  /** @returns {Subagent[]} copies, oldest first */
  list() {
    return [...this.subagents.values()].map((s) => ({ ...s, counts: { ...s.counts } }));
  }

  /** @param {string} id @returns {Subagent|null} a copy */
  get(id) {
    const s = this.subagents.get(id);
    return s ? { ...s, counts: { ...s.counts } } : null;
  }

  /**
   * Add a line. @param {ApplyResult} out @param {number} now @param {string} subagentId @param {any} fields
   * @returns {ActivityEntry}
   */
  add(out, now, subagentId, fields) {
    /** @type {ActivityEntry} */
    const e = { seq: ++this.seq, at: now, subagentId, ...fields };
    if (e.detail !== undefined) { e.detail = clip(e.detail, DETAIL_MAX); if (!e.detail) delete e.detail; }
    if (e.text !== undefined) { e.text = clip(e.text, TEXT_MAX); if (!e.text) delete e.text; }
    if (!this.firstSeq) this.firstSeq = e.seq;
    this.entries.push(e);
    if (this.entries.length > this.memTail) this.entries.splice(0, this.entries.length - this.memTail);
    out.entries.push(e);
    if (!BATCHED_KINDS.has(e.kind)) out.urgent = true;
    return e;
  }

  /**
   * Fold one hook event in. Returns the new lines and the ids of the subagents that changed.
   * @param {string} event @param {any} payload @param {number} [now] @returns {ApplyResult}
   */
  apply(event, payload, now = Date.now()) {
    const p = payload && typeof payload === 'object' ? payload : {};
    /** @type {ApplyResult} */
    const out = { entries: [], changed: new Set(), urgent: false };
    const sid = str(p.agent_id);
    const tool = str(p.tool_name);
    const detail = summarizeTool(tool, p.tool_input);
    // Claude's own hidden helpers (e.g. after a turn) end with a SubagentStop that has no agent_type and an
    // id never seen before: no SubagentStart, no tools, no meta.json. They are not the user's subagents.
    if (event === 'SubagentStop' && sid && !str(p.agent_type) && !this.subagents.has(sid)) {
      out.internal = true;
      return out;
    }
    /** @type {Subagent|null} */
    let sub = null;
    if (sid && event !== 'SubagentStart') {
      // A new action from a subagent marked ended means it works again (resumed, or ended too early).
      sub = this.ensure(sid, p, now, out, event === 'PreToolUse' || event === 'PermissionRequest');
      this.retryTitle(sub, p, out);
    }

    switch (event) {
      case 'SessionStart':
        this.add(out, now, '', { kind: 'session_start', text: str(p.source) || 'startup' });
        // A new process: nothing of the old one runs any more.
        if (p.source !== 'compact') this.stopRunning(now, out);
        break;
      case 'UserPromptSubmit': {
        const tn = parseTaskNotification(p.prompt);
        if (tn) {
          this.onTaskNotification(tn, now, out);
        } else {
          this.add(out, now, sid, { kind: 'prompt', text: str(p.prompt) });
          // A new prompt from the user: a foreground subagent still "running" was cut short (Esc).
          this.stopRunning(now, out, (s) => !s.background);
          this.queue = [];
        }
        break;
      }
      case 'PreToolUse': {
        const id = str(p.tool_use_id);
        if (id) {
          this.toolStarts.set(id, now);
          if (this.toolStarts.size > MAX_TOOL_STARTS) this.toolStarts.delete(/** @type {string} */ (this.toolStarts.keys().next().value));
        }
        if (AGENT_TOOLS.has(tool)) this.queueCall(p, now);
        this.add(out, now, sid, { kind: 'tool', tool, detail });
        if (sub) this.touch(sub, out, now, { tool, detail });
        break;
      }
      case 'PostToolUse': {
        const id = str(p.tool_use_id);
        const started = id ? this.toolStarts.get(id) : undefined;
        if (id) this.toolStarts.delete(id);
        const dur = Number(p.duration_ms);
        const ms = Number.isFinite(dur) && dur >= 0 ? Math.round(dur) : started !== undefined ? Math.max(0, now - started) : undefined;
        const failed = toolFailed(p.tool_response);
        /** @type {any} */
        const fields = { kind: failed ? 'tool_error' : 'tool_done', tool, detail };
        if (ms !== undefined) fields.ms = ms;
        this.add(out, now, sid, fields);
        if (sub) {
          sub.counts.tools += 1;
          if (failed) sub.counts.errors += 1;
          const patch = { needsYou: false };
          if (sub.tool === tool) Object.assign(patch, { tool: '', detail: '' });
          this.touch(sub, out, now, patch);
        }
        if (AGENT_TOOLS.has(tool)) this.onAgentResult(p, now, out);
        break;
      }
      case 'PermissionRequest':
        this.add(out, now, sid, { kind: 'permission', tool, detail });
        for (const s of this.subagents.values()) {
          if (s !== sub && s.needsYou) this.touch(s, out, now, { needsYou: false });
        }
        if (sub) this.touch(sub, out, now, { needsYou: true, tool, detail });
        break;
      case 'Notification':
        if (isIdleReminder(p)) break;
        this.add(out, now, sid, { kind: 'notice', text: str(p.message) || 'Claude needs you' });
        break;
      case 'Stop': {
        this.add(out, now, sid, { kind: 'turn_end', text: str(p.last_assistant_message) });
        const listed = this.backgroundTasks(p.background_tasks, now, out);
        // The turn is over: only background subagents can still run.
        if (listed) this.stopRunning(now, out, (s) => !listed.has(s.id));
        else this.stopRunning(now, out, (s) => !s.background);
        this.queue = [];
        break;
      }
      case 'SubagentStart': {
        if (!sid) break;
        const known = this.subagents.get(sid);
        if (known) {
          // Started again (a stopped subagent can be resumed).
          this.retryTitle(known, p, out);
          if (str(p.agent_type) && known.type !== p.agent_type) known.type = p.agent_type;
          if (known.state !== 'running') {
            this.touch(known, out, now, { state: 'running', tool: '', detail: '', needsYou: false });
            delete known.endedAt;
          }
          this.add(out, now, sid, { kind: 'subagent_start', text: known.title, type: known.type });
        } else {
          this.ensure(sid, p, now, out);
        }
        break;
      }
      case 'SubagentStop': {
        if (!sub) break;
        const summary = clip(str(p.last_assistant_message), TEXT_MAX);
        this.end(sub, 'done', now, out, summary);
        this.backgroundTasks(p.background_tasks, now, out);
        this.add(out, now, sid, { kind: 'subagent_end', text: summary || sub.title });
        break;
      }
      case 'PreCompact':
        this.add(out, now, sid, { kind: 'notice', text: `Compacting context${str(p.trigger) ? ` (${p.trigger})` : ''}` });
        break;
      case 'SessionEnd':
        this.add(out, now, '', { kind: 'session_end', text: str(p.reason) });
        this.stopRunning(now, out);
        break;
      default:
        break;
    }
    return out;
  }

  /**
   * The subagent with this id, created (running) the first time it shows up.
   * @param {string} id @param {any} p @param {number} now @param {ApplyResult} out @param {boolean} [revive]
   * @returns {Subagent}
   */
  ensure(id, p, now, out, revive = false) {
    const known = this.subagents.get(id);
    if (known) {
      if (revive && known.state !== 'running') {
        this.touch(known, out, now, { state: 'running', needsYou: false });
        delete known.endedAt;
      }
      return known;
    }
    const type = str(p.agent_type) || 'general-purpose';
    const { title, background, info } = this.pairTitle(id, type, p);
    /** @type {Subagent} */
    const sub = {
      id, agentId: this.agentId, title, type, state: 'running', background,
      tool: '', detail: '', needsYou: false, counts: { tools: 0, errors: 0 }, startedAt: now, updatedAt: now,
    };
    const model = this.modelFor(id, p, info);
    if (model) sub.model = model;
    this.subagents.set(id, sub);
    this.titles.set(id, info);
    out.changed.add(id);
    this.add(out, now, id, { kind: 'subagent_start', text: title, type });
    this.trimSubagents(id);
    return sub;
  }

  /** A session that starts subagents all day must not grow without bound: drop the oldest finished ones. @param {string} keep */
  trimSubagents(keep) {
    if (this.subagents.size <= MAX_SUBAGENTS) return;
    for (const [id, s] of this.subagents) {
      if (this.subagents.size <= MAX_SUBAGENTS) break;
      if (id === keep || s.state === 'running') continue;
      this.subagents.delete(id);
      this.titles.delete(id);
    }
  }

  /**
   * A title for a subagent that just started: its Agent call (paired by agentId, else the oldest
   * queued call of its type, else the oldest), else its meta.json, else its type's label.
   * @param {string} id @param {string} type @param {any} p
   * @returns {{title: string, background: boolean, info: TitleInfo}}
   */
  pairTitle(id, type, p) {
    let call = this.paired.get(id);
    if (call) this.paired.delete(id);
    if (!call && this.queue.length) {
      let i = this.queue.findIndex((c) => c.type === type);
      if (i < 0) i = 0;
      call = this.queue.splice(i, 1)[0];
    }
    if (call) return { title: call.title || typeLabel(type), background: call.background, info: { src: 'call', callId: call.toolUseId } };
    const meta = this.meta(id, p);
    if (meta) return { title: meta.title, background: meta.background, info: { src: 'meta' } };
    return { title: typeLabel(type), background: false, info: { src: 'fallback', tries: 0 } };
  }

  /**
   * (M4) The model a new subagent runs on: its meta.json "model", else its Agent call's tool_input.model, else ''.
   * @param {string} id @param {any} p @param {TitleInfo} info
   */
  modelFor(id, p, info) {
    const file = metaPath(str(p.transcript_path), str(p.session_id), id);
    let m = null;
    try { m = file ? this.readMeta(file) : null; } catch { m = null; }
    const fromMeta = m && typeof m === 'object' ? clip(str(m.model).trim(), 80) : '';
    if (fromMeta) return fromMeta;
    const call = info.callId ? this.calls.get(info.callId) : undefined;
    return (call && call.model) || '';
  }

  /**
   * Read a subagent's meta.json. @param {string} id @param {any} p
   * @returns {{title: string, background: boolean}|null}
   */
  meta(id, p) {
    const file = metaPath(str(p.transcript_path), str(p.session_id), id);
    if (!file) return null;
    let m = null;
    try { m = this.readMeta(file); } catch { m = null; }
    if (!m || typeof m !== 'object') return null;
    const title = clip(str(m.description).trim(), TITLE_MAX);
    if (!title) return null;
    // That call is taken: it must not be paired with another subagent.
    const callId = str(m.toolUseId);
    if (callId) this.queue = this.queue.filter((c) => c.toolUseId !== callId);
    return { title, background: m.requestShape === 'background' };
  }

  /** A subagent still wearing its type's label looks for a real title again. @param {Subagent} sub @param {any} p @param {ApplyResult} out */
  retryTitle(sub, p, out) {
    const info = this.titles.get(sub.id);
    if (!info || info.src !== 'fallback' || (info.tries || 0) >= META_TRIES) return;
    info.tries = (info.tries || 0) + 1;
    const m = this.meta(sub.id, p);
    if (!m) return;
    sub.title = m.title;
    if (m.background) sub.background = true;
    const model = this.modelFor(sub.id, p, { src: 'meta' });
    if (model) sub.model = model;
    this.titles.set(sub.id, { src: 'meta' });
    out.changed.add(sub.id);
  }

  /** @param {any} p @param {number} now */
  queueCall(p, now) {
    const ti = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
    /** @type {AgentCall} */
    const call = {
      toolUseId: str(p.tool_use_id),
      title: clip(str(ti.description).trim(), TITLE_MAX),
      type: str(ti.subagent_type) || 'general-purpose',
      background: ti.run_in_background === true,
      at: now,
      ...(str(ti.model).trim() ? { model: clip(str(ti.model).trim(), 80) } : {}),
    };
    this.queue.push(call);
    if (this.queue.length > MAX_QUEUE) this.queue.shift();
    if (call.toolUseId) {
      this.calls.set(call.toolUseId, call);
      if (this.calls.size > MAX_QUEUE * 4) this.calls.delete(/** @type {string} */ (this.calls.keys().next().value));
    }
  }

  /**
   * PostToolUse of an Agent call: tool_response.agentId says which subagent it was (a background
   * one gets it at once, a foreground one when it is done), so the pairing is corrected here.
   * @param {any} p @param {number} now @param {ApplyResult} out
   */
  onAgentResult(p, now, out) {
    const callId = str(p.tool_use_id);
    const resp = p.tool_response && typeof p.tool_response === 'object' ? p.tool_response : {};
    const agentId = str(resp.agentId) || str(resp.agent_id);
    const async = resp.isAsync === true || resp.status === 'async_launched';
    const failed = toolFailed(resp);
    const call = callId ? this.calls.get(callId) : undefined;
    if (call) {
      if (async) call.background = true;
      this.queue = this.queue.filter((c) => c !== call);
    }
    let sub = agentId ? this.subagents.get(agentId) : undefined;
    if (!sub && callId) {
      // No agentId (e.g. it failed): the subagent that took this call.
      for (const s of this.subagents.values()) if (this.titles.get(s.id)?.callId === callId) sub = s;
    }
    if (agentId && !sub) {
      if (call) this.paired.set(agentId, call);
      return;
    }
    if (!sub) return;
    if (call) this.assignCall(sub, call, out);
    if (async && !sub.background) this.touch(sub, out, now, { background: true });
    if (failed) this.end(sub, 'failed', now, out);
    else if (!async && sub.state === 'running') this.end(sub, 'done', now, out); // its SubagentStop went missing
  }

  /**
   * This call belongs to this subagent. Swap with whoever had it, or put the subagent's old call back.
   * @param {Subagent} sub @param {AgentCall} call @param {ApplyResult} out
   */
  assignCall(sub, call, out) {
    const info = this.titles.get(sub.id);
    if (info && info.src === 'call' && info.callId === call.toolUseId) return;
    let other = null;
    for (const s of this.subagents.values()) if (s !== sub && this.titles.get(s.id)?.callId === call.toolUseId) other = s;
    const old = info && info.src === 'call' && info.callId ? this.calls.get(info.callId) : undefined;
    sub.title = call.title || sub.title;
    if (call.model && !sub.model) sub.model = call.model;
    if (call.background) sub.background = true;
    this.titles.set(sub.id, { src: 'call', callId: call.toolUseId });
    out.changed.add(sub.id);
    if (other) {
      if (old) {
        other.title = old.title || typeLabel(other.type);
        this.titles.set(other.id, { src: 'call', callId: old.toolUseId });
      } else {
        other.title = typeLabel(other.type);
        this.titles.set(other.id, { src: 'fallback', tries: 0 });
      }
      out.changed.add(other.id);
    } else if (old && !this.queue.includes(old)) {
      this.queue.push(old);
      this.queue.sort((a, b) => a.at - b.at);
    }
  }

  /**
   * Stop / SubagentStop list the subagents still running in the background, with their titles.
   * @param {any} tasks @param {number} now @param {ApplyResult} out @returns {Set<string>|null} their ids; null when not given
   */
  backgroundTasks(tasks, now, out) {
    if (!Array.isArray(tasks)) return null;
    const ids = new Set();
    for (const t of tasks) {
      if (!t || typeof t !== 'object' || (t.type && t.type !== 'subagent')) continue;
      const id = str(t.id);
      if (!id) continue;
      ids.add(id);
      const sub = this.subagents.get(id);
      if (!sub) continue;
      if (!sub.background) { sub.background = true; out.changed.add(id); }
      const info = this.titles.get(id);
      const title = clip(str(t.description).trim(), TITLE_MAX);
      if (title && info && info.src === 'fallback') {
        sub.title = title;
        this.titles.set(id, { src: 'tasks' });
        out.changed.add(id);
      }
    }
    return ids;
  }

  /** @param {NonNullable<ReturnType<typeof parseTaskNotification>>} tn @param {number} now @param {ApplyResult} out */
  onTaskNotification(tn, now, out) {
    let sub = tn.taskId ? this.subagents.get(tn.taskId) : undefined;
    if (!sub && tn.toolUseId) {
      for (const s of this.subagents.values()) if (this.titles.get(s.id)?.callId === tn.toolUseId) sub = s;
    }
    const state = stateFromTaskStatus(tn.status || 'completed');
    if (sub) {
      const info = this.titles.get(sub.id);
      if (tn.title && info && info.src === 'fallback') {
        sub.title = clip(tn.title, TITLE_MAX);
        this.titles.set(sub.id, { src: 'tasks' });
        out.changed.add(sub.id);
      }
      if (!sub.background) this.touch(sub, out, now, { background: true });
      if (sub.state === 'running') this.end(sub, state, now, out, clip(tn.result, TEXT_MAX));
      else if (state === 'failed' && sub.state !== 'failed') this.touch(sub, out, now, { state: 'failed' });
    }
    const title = sub ? sub.title : tn.title || 'a subagent';
    const verb = state === 'failed' ? 'failed' : state === 'stopped' ? 'stopped' : 'finished';
    this.add(out, now, '', { kind: 'notice', text: `Subagent ${verb}: ${title}` });
  }

  /**
   * @param {Subagent} sub @param {Subagent['state']} state @param {number} now @param {ApplyResult} out @param {string} [summary]
   */
  end(sub, state, now, out, summary = '') {
    const already = sub.state === state && sub.endedAt;
    /** @type {Partial<Subagent>} */
    const patch = { state, tool: '', detail: '', needsYou: false };
    if (summary) patch.summary = summary;
    this.touch(sub, out, now, patch);
    if (!already) sub.endedAt = now;
  }

  /**
   * Mark running subagents stopped. @param {number} now @param {ApplyResult} out
   * @param {(s: Subagent) => boolean} [which]
   */
  stopRunning(now, out, which = () => true) {
    for (const s of this.subagents.values()) if (s.state === 'running' && which(s)) this.end(s, 'stopped', now, out);
  }

  /**
   * Change fields of a subagent; records it as changed only when something did.
   * @param {Subagent} sub @param {ApplyResult|{changed: Set<string>}} out @param {number} now @param {Partial<Subagent>} patch
   */
  touch(sub, out, now, patch) {
    let diff = false;
    for (const [k, v] of Object.entries(patch)) {
      if (/** @type {any} */ (sub)[k] !== v) { /** @type {any} */ (sub)[k] = v; diff = true; }
    }
    if (diff) { sub.updatedAt = now; out.changed.add(sub.id); }
    return diff;
  }

  /**
   * The permission prompt on screen now is from `askedBy` ('' = the session, null = none):
   * every other subagent's needsYou goes. @param {string|null} askedBy @param {number} [now] @returns {Set<string>}
   */
  syncAsked(askedBy, now = Date.now()) {
    const out = { changed: new Set() };
    for (const s of this.subagents.values()) if (s.needsYou && s.id !== askedBy) this.touch(s, out, now, { needsYou: false });
    return /** @type {Set<string>} */ (out.changed);
  }

  /** The session process is gone, or the core restarted. @param {number} [now] @returns {Set<string>} */
  stopAll(now = Date.now()) {
    /** @type {ApplyResult} */
    const out = { entries: [], changed: new Set(), urgent: false };
    this.stopRunning(now, out);
    for (const s of this.subagents.values()) if (s.needsYou) this.touch(s, out, now, { needsYou: false });
    this.queue = [];
    this.paired.clear();
    return out.changed;
  }

  /**
   * A prompt was denied or closed in the terminal: that ends the session's turn, and with it its
   * foreground subagents. Background ones go on. @param {number} [now] @returns {Set<string>}
   */
  stopForeground(now = Date.now()) {
    /** @type {ApplyResult} */
    const out = { entries: [], changed: new Set(), urgent: false };
    this.stopRunning(now, out, (s) => !s.background);
    for (const s of this.subagents.values()) if (s.needsYou) this.touch(s, out, now, { needsYou: false });
    return out.changed;
  }

  /** What subagents.json keeps. */
  toJSON() {
    /** @type {Record<string, TitleInfo>} */
    const titles = {};
    for (const [id, t] of this.titles) titles[id] = t;
    return { version: FILES_VERSION, subagents: this.list(), titles };
  }

  /** @param {any} data from subagents.json */
  restore(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.subagents)) return;
    const titles = data.titles && typeof data.titles === 'object' ? data.titles : {};
    const subs = data.subagents.filter((s) => s && typeof s === 'object' && typeof s.id === 'string' && s.id)
      .sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0));
    for (const s of subs) {
      const startedAt = Number(s.startedAt) || 0;
      /** @type {Subagent} */
      const sub = {
        id: s.id, agentId: this.agentId, title: str(s.title) || typeLabel(str(s.type)), type: str(s.type) || 'general-purpose',
        state: ['running', 'done', 'failed', 'stopped'].includes(s.state) ? s.state : 'stopped',
        background: s.background === true, tool: str(s.tool), detail: str(s.detail), needsYou: s.needsYou === true,
        counts: { tools: Number(s.counts && s.counts.tools) || 0, errors: Number(s.counts && s.counts.errors) || 0 },
        startedAt, updatedAt: Number(s.updatedAt) || startedAt,
      };
      if (typeof s.summary === 'string' && s.summary) sub.summary = clip(s.summary, TEXT_MAX);
      if (Number(s.endedAt)) sub.endedAt = Number(s.endedAt);
      this.subagents.set(sub.id, sub);
      const t = titles[sub.id];
      this.titles.set(sub.id, t && typeof t === 'object' && ['call', 'meta', 'tasks', 'fallback'].includes(t.src) ? t : { src: 'meta' });
    }
  }
}

// ---- the core's side: files, events, status ---------------------------------------------------

/** @param {NodeJS.ProcessEnv} env @param {string} name @param {number} fallback */
function envInt(env, name, fallback) {
  const v = Number(env && env[name]);
  return env && env[name] !== undefined && env[name] !== '' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/**
 * Parse a .jsonl activity file. Skips lines that aren't entries.
 * @param {string} text @returns {ActivityEntry[]}
 */
function parseLines(text) {
  /** @type {ActivityEntry[]} */
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object' && Number.isInteger(e.seq) && typeof e.kind === 'string') out.push(e);
    } catch { /* a torn line */ }
  }
  return out;
}

class Activity {
  /**
   * @param {import('./core').Core} core
   * @param {{maxBytes?: number, keep?: number, memTail?: number, flushMs?: number, eventMs?: number, subEventMs?: number}} [opts]
   *   limits; also from env (tests): CC_ACTIVITY_MAX_BYTES, CC_ACTIVITY_KEEP, CC_ACTIVITY_MEM
   */
  constructor(core, opts = {}) {
    this.core = core;
    const env = core.env || process.env;
    this.dir = path.join(core.home, 'activity');
    this.maxBytes = opts.maxBytes || envInt(env, 'CC_ACTIVITY_MAX_BYTES', MAX_BYTES);
    this.keep = opts.keep || envInt(env, 'CC_ACTIVITY_KEEP', KEEP_ON_ROTATE);
    this.memTail = opts.memTail || envInt(env, 'CC_ACTIVITY_MEM', MEM_TAIL);
    this.flushMs = opts.flushMs || FLUSH_MS;
    this.eventMs = opts.eventMs || EVENT_MS;
    this.subEventMs = opts.subEventMs || SUB_EVENT_MS;
    /** @type {Map<string, SessionLog>} */
    this.logs = new Map();
    /** @type {Map<string, number>} agentId -> bytes in its .jsonl */
    this.sizes = new Map();
    /** @type {Map<string, string[]>} lines not yet on disk */
    this.pending = new Map();
    /** @type {Map<string, ActivityEntry[]>} lines not yet sent */
    this.unsent = new Map();
    /** @type {Map<string, Set<string>>} subagents changed, not yet sent */
    this.subDirty = new Map();
    /** @type {Set<string>} agents whose subagents.json is behind */
    this.subUnsaved = new Set();
    /** @type {NodeJS.Timeout|null} */ this.flushTimer = null;
    /** @type {NodeJS.Timeout|null} */ this.eventTimer = null;
    /** @type {NodeJS.Timeout|null} */ this.subTimer = null;
    this.started = false;
    /** @param {string} event @param {any} data */
    this.onBroadcast = (event, data) => {
      try {
        if (event === 'agent.status' && data) this.syncStatus(data);
        else if (event === 'agent.exit' && data) this.onExit(data.id);
      } catch { /* never breaks the core */ }
    };
  }

  /** Called from Core.start() after the state is loaded: no agent runs now. */
  start() {
    if (this.started) return;
    this.started = true;
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* reported on first write */ }
    const now = Date.now();
    for (const id of this.core.agents.keys()) {
      const log = this.load(id);
      const changed = log.stopAll(now);
      if (changed.size) this.saveSubagents(id);
      // The saved status may still count subagents that ran when the core stopped.
      const st = this.core.status.get(id);
      if (st) {
        const c = log.counts();
        const fix = { ...st, subagents: c };
        if (/subagents? running$/.test(st.detail || '') && st.state !== 'working') { fix.detail = ''; fix.tool = ''; }
        this.core.status.set(id, fix);
      }
    }
    try { this.core.store.saveSoon(); } catch { /* best effort */ }
    this.core.on('broadcast', this.onBroadcast);
  }

  /** Called from Core.shutdown(): everything pending goes to disk. */
  shutdown() {
    this.core.off('broadcast', this.onBroadcast);
    this.started = false;
    for (const id of [...this.pending.keys()]) this.flush(id);
    for (const id of [...this.subUnsaved]) this.saveSubagents(id);
    this.sendEvents();
    this.sendSubagents();
    for (const t of [this.flushTimer, this.eventTimer, this.subTimer]) if (t) clearTimeout(t);
    this.flushTimer = this.eventTimer = this.subTimer = null;
  }

  /** @param {string} agentId */
  logFile(agentId) { return path.join(this.dir, `${fileBase(agentId)}.jsonl`); }

  /** @param {string} agentId */
  subFile(agentId) { return path.join(this.dir, `${fileBase(agentId)}.subagents.json`); }

  /**
   * An agent's log, read from disk the first time. Repairs a torn last line (hard kill mid-write).
   * @param {string} agentId @returns {SessionLog}
   */
  load(agentId) {
    let log = this.logs.get(agentId);
    if (log) return log;
    log = new SessionLog(agentId, { memTail: this.memTail });
    const file = this.logFile(agentId);
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* no log yet */ }
    if (text && !text.endsWith('\n')) {
      const cut = text.lastIndexOf('\n') + 1;
      text = text.slice(0, cut);
      try { fs.truncateSync(file, Buffer.byteLength(text)); } catch { /* next append starts a fresh line anyway */ }
    }
    const entries = parseLines(text);
    if (entries.length) {
      log.seq = entries[entries.length - 1].seq;
      log.firstSeq = entries[0].seq;
      log.entries = entries.slice(-this.memTail);
    }
    this.sizes.set(agentId, Buffer.byteLength(text));
    log.restore(readJson(this.subFile(agentId)));
    this.logs.set(agentId, log);
    return log;
  }

  /**
   * Every hook event of an agent, before Core applies it to the agent's status.
   * @param {string} agentId @param {string} event @param {any} payload
   * @returns {{subagents: {running: number, total: number}}} what applyEvent needs
   */
  onHook(agentId, event, payload) {
    const log = this.load(agentId);
    const before = JSON.stringify(log.counts());
    const out = log.apply(event, payload, Date.now());
    if (out.entries.length) this.record(agentId, out.entries, out.urgent);
    if (out.changed.size) this.subagentsChanged(agentId, out.changed, out.urgent || before !== JSON.stringify(log.counts()));
    return { subagents: log.counts(), ...(out.internal ? { internal: true } : {}) };
  }

  /**
   * A permission prompt was denied or closed in the terminal (core.js). Its foreground subagents
   * end with the turn. @param {string} agentId @returns {{running: number, total: number}}
   */
  onPromptGone(agentId) {
    try {
      const log = this.load(agentId);
      const changed = log.stopForeground();
      if (changed.size) this.subagentsChanged(agentId, changed, true);
      return log.counts();
    } catch {
      return { running: 0, total: 0 };
    }
  }

  /** The agent's process exited (or was stopped): its subagents stop with it. @param {string} agentId */
  onExit(agentId) {
    if (!this.core.agents.has(agentId)) return;
    const log = this.load(agentId);
    const changed = log.stopAll();
    if (!changed.size) return;
    this.subagentsChanged(agentId, changed, true);
    const counts = log.counts();
    this.core.update(agentId, (s) => {
      const st = { ...s, subagents: counts, updatedAt: Date.now() };
      if (/subagents? running$/.test(s.detail || '')) { st.detail = ''; st.tool = ''; }
      return { status: st };
    });
  }

  /** needsYou follows the prompt on screen: cleared when it is answered, denied or gone. @param {any} st */
  syncStatus(st) {
    const log = this.logs.get(st.agentId);
    if (!log) return;
    const asking = st.state === 'needs_you' && st.permission ? (st.askedBy || '') : null;
    const changed = log.syncAsked(asking);
    if (changed.size) this.subagentsChanged(st.agentId, changed, false);
  }

  /** The agent was removed: drop its log. @param {string} agentId */
  onRemove(agentId) {
    this.logs.delete(agentId);
    this.pending.delete(agentId);
    this.unsent.delete(agentId);
    this.subDirty.delete(agentId);
    this.subUnsaved.delete(agentId);
    this.sizes.delete(agentId);
    for (const f of [this.logFile(agentId), this.subFile(agentId)]) {
      try { fs.rmSync(f, { force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* held open on Windows: harmless */ }
    }
  }

  /**
   * A taken-over outside session brings the log the app showed for it (external.takeOver): it becomes
   * this agent's log, so the drawer keeps its history. Only for an agent with no log yet. Seq starts at 1;
   * subagents that were running in the ended process are stopped.
   * @param {string} agentId @param {{entries?: any[], subagents?: any[]}} from
   * @returns {number} how many lines were taken
   */
  adopt(agentId, from) {
    const log = this.load(agentId);
    if (log.seq || !from) return 0;
    const now = Date.now();
    /** @type {ActivityEntry[]} */
    const entries = [];
    for (const e of Array.isArray(from.entries) ? from.entries : []) {
      if (!e || typeof e !== 'object' || typeof e.kind !== 'string') continue;
      /** @type {any} */
      const x = { ...e, seq: entries.length + 1, at: Number(e.at) || now, subagentId: typeof e.subagentId === 'string' ? e.subagentId : '' };
      if (x.detail !== undefined) x.detail = clip(x.detail, DETAIL_MAX);
      if (x.text !== undefined) x.text = clip(x.text, TEXT_MAX);
      entries.push(x);
    }
    const subs = (Array.isArray(from.subagents) ? from.subagents : []).map((sub) => ({
      ...sub, agentId, counts: { tools: 0, errors: 0, ...(sub && sub.counts) },
      ...(sub && sub.state === 'running' ? { state: 'stopped', endedAt: now, needsYou: false, tool: '', detail: '' } : {}),
    }));
    log.restore({ subagents: subs, titles: {} });
    if (entries.length) {
      log.seq = entries.length;
      log.firstSeq = 1;
      log.entries = entries.slice(-this.memTail);
      this.record(agentId, entries, true);
    }
    if (subs.length) {
      this.saveSubagents(agentId);
      this.subagentsChanged(agentId, subs.map((x) => x.id), true);
    }
    return entries.length;
  }

  // ---- writing ----

  /** @param {string} agentId @param {ActivityEntry[]} entries @param {boolean} urgent */
  record(agentId, entries, urgent) {
    const lines = this.pending.get(agentId) || [];
    for (const e of entries) lines.push(JSON.stringify(e) + '\n');
    this.pending.set(agentId, lines);
    const unsent = this.unsent.get(agentId) || [];
    unsent.push(...entries);
    this.unsent.set(agentId, unsent);
    if (urgent) this.flush(agentId);
    else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flushAll(); }, this.flushMs);
      this.flushTimer.unref();
    }
    if (!this.eventTimer) {
      this.eventTimer = setTimeout(() => { this.eventTimer = null; this.sendEvents(); }, this.eventMs);
      this.eventTimer.unref();
    }
  }

  flushAll() {
    for (const id of [...this.pending.keys()]) this.flush(id);
    for (const id of [...this.subUnsaved]) this.saveSubagents(id);
  }

  /** Append an agent's pending lines. On failure (file held open) they stay pending. @param {string} agentId */
  flush(agentId) {
    const lines = this.pending.get(agentId);
    if (!lines || !lines.length) { this.pending.delete(agentId); return; }
    const text = lines.join('');
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.logFile(agentId), text);
    } catch {
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flushAll(); }, this.flushMs);
        this.flushTimer.unref();
      }
      return;
    }
    this.pending.delete(agentId);
    const size = (this.sizes.get(agentId) || 0) + Buffer.byteLength(text);
    this.sizes.set(agentId, size);
    if (size > this.maxBytes) this.rotate(agentId);
  }

  /** Rewrite a log past maxBytes with its last `keep` entries (atomic). @param {string} agentId */
  rotate(agentId) {
    const file = this.logFile(agentId);
    let entries;
    try { entries = parseLines(fs.readFileSync(file, 'utf8')); } catch { return; }
    const kept = entries.slice(-this.keep);
    const text = kept.map((e) => JSON.stringify(e) + '\n').join('');
    try { writeFileAtomic(file, text); } catch { return; }
    this.sizes.set(agentId, Buffer.byteLength(text));
    const log = this.logs.get(agentId);
    if (log && kept.length) log.firstSeq = kept[0].seq;
  }

  /**
   * @param {string} agentId @param {Set<string>} ids @param {boolean} urgent state changes go out (and to disk) at once
   */
  subagentsChanged(agentId, ids, urgent) {
    const dirty = this.subDirty.get(agentId) || new Set();
    for (const id of ids) dirty.add(id);
    this.subDirty.set(agentId, dirty);
    this.subUnsaved.add(agentId);
    if (urgent) {
      // A start, end or prompt: on disk and on screen before the session's status changes.
      this.saveSubagents(agentId);
      this.sendSubagents();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flushAll(); }, this.flushMs);
      this.flushTimer.unref();
    }
    if (!this.subTimer) {
      this.subTimer = setTimeout(() => { this.subTimer = null; this.sendSubagents(); }, this.subEventMs);
      this.subTimer.unref();
    }
  }

  /** @param {string} agentId */
  saveSubagents(agentId) {
    const log = this.logs.get(agentId);
    if (!log) { this.subUnsaved.delete(agentId); return; }
    try {
      writeFileAtomic(this.subFile(agentId), JSON.stringify(log.toJSON()) + '\n');
      this.subUnsaved.delete(agentId);
    } catch {
      this.subUnsaved.add(agentId); // retried with the next flush
    }
  }

  // ---- events ----

  sendEvents() {
    const all = [...this.unsent];
    this.unsent.clear();
    for (const [agentId, entries] of all) {
      if (entries.length && this.logs.has(agentId)) this.core.broadcast('activity', { agentId, entries });
    }
  }

  sendSubagents() {
    const all = [...this.subDirty];
    this.subDirty.clear();
    for (const [agentId, ids] of all) {
      const log = this.logs.get(agentId);
      if (!log) continue;
      for (const id of ids) {
        const subagent = log.get(id);
        if (subagent) this.core.broadcast('subagent.updated', { agentId, subagent });
      }
    }
  }

  // ---- RPC ----

  /** @param {{agentId: string}} p @returns {Subagent[]} */
  subagentsList(p) {
    return this.load(p.agentId).list();
  }

  /**
   * @param {{agentId: string, subagentId?: string, before?: number, limit?: number}} p
   * @returns {{entries: ActivityEntry[], more: boolean}}
   */
  list(p) {
    if (p.subagentId !== undefined && p.subagentId !== null && typeof p.subagentId !== 'string') throw new RpcError(ERRORS.BAD_REQUEST, 'subagentId must be a string');
    if (p.before !== undefined && p.before !== null && (typeof p.before !== 'number' || !Number.isFinite(p.before))) throw new RpcError(ERRORS.BAD_REQUEST, 'before must be a number');
    if (p.limit !== undefined && p.limit !== null && (!Number.isInteger(p.limit) || p.limit < 1)) throw new RpcError(ERRORS.BAD_REQUEST, 'limit must be a whole number above 0');
    const limit = Math.min(LIST_MAX, p.limit || LIST_DEFAULT);
    const before = typeof p.before === 'number' ? p.before : Infinity;
    const sub = typeof p.subagentId === 'string' ? p.subagentId : null;
    const match = (/** @type {ActivityEntry} */ e) => e.seq < before && (sub === null || e.subagentId === sub);
    const log = this.load(p.agentId);
    const mem = log.entries.filter(match);
    const memHasAll = !log.entries.length || log.entries[0].seq <= log.firstSeq;
    if (mem.length > limit || memHasAll) return { entries: mem.slice(-limit), more: mem.length > limit };
    // Older than what memory holds: read the file (with everything pending on it first).
    this.flush(p.agentId);
    let all;
    try { all = parseLines(fs.readFileSync(this.logFile(p.agentId), 'utf8')); } catch { all = []; }
    const lastOnDisk = all.length ? all[all.length - 1].seq : 0;
    for (const e of log.entries) if (e.seq > lastOnDisk) all.push(e); // still pending (file held open)
    const found = all.filter(match);
    return { entries: found.slice(-limit), more: found.length > limit };
  }
}

module.exports = {
  Activity, SessionLog, parseTaskNotification, metaPath, fileBase, typeLabel, toolFailed, parseLines,
  DETAIL_MAX, TEXT_MAX, MEM_TAIL, MAX_SUBAGENTS, MAX_BYTES, KEEP_ON_ROTATE, FLUSH_MS, EVENT_MS, ERRORS,
};
