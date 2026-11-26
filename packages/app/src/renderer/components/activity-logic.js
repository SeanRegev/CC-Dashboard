// @ts-check
/**
 * Pure helpers of the activity drawer, the subagent strip and the badges (no DOM, so Node tests import it).
 * Owner: the Activity UI track (M3). Types: Subagent and ActivityEntry in packages/shared/protocol.js.
 */

/**
 * An exact copy of protocol.js SUBAGENT_TYPES / SUBAGENT_DEFAULT_EMOJI (the renderer can't import the
 * contract; tests/unit/activity-logic.test.js keeps them equal).
 */
export const SUBAGENT_TYPES = Object.freeze([
  Object.freeze({ id: 'general-purpose', label: 'General', emoji: '🔧' }),
  Object.freeze({ id: 'Explore', label: 'Explore', emoji: '🔭' }),
  Object.freeze({ id: 'Plan', label: 'Plan', emoji: '📐' }),
  Object.freeze({ id: 'statusline-setup', label: 'Status line', emoji: '⚙️' }),
  Object.freeze({ id: 'claude-code-guide', label: 'Guide', emoji: '📖' }),
]);
export const SUBAGENT_DEFAULT_EMOJI = '🤖';

/** How many lines the feed renders at most (each "Load older" adds one page on top). */
export const MAX_LINES = 500;
/** Entries asked from the core per request. */
export const PAGE = 200;

/** Emoji and label of a subagent type; unknown types (a plugin's agent) get the default emoji and the id. @param {string} [type] */
export function typeInfo(type) {
  const t = SUBAGENT_TYPES.find((x) => x.id === type);
  return t ? { emoji: t.emoji, label: t.label } : { emoji: SUBAGENT_DEFAULT_EMOJI, label: type || 'Agent' };
}

/** The title to show: its title, else the type's label. @param {{title?: string, type?: string}} s */
export function subagentTitle(s) {
  return (s && s.title && String(s.title).trim()) || typeInfo(s && s.type).label;
}

/** @param {string} s @param {number} n */
export function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t;
}

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');

/** Wall-clock time of a log line, "14:03:09" (local). @param {number} at */
export function formatTime(at) {
  if (!Number.isFinite(at)) return '';
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * A duration: "12 ms", "1.2 s", "14 s", "4m 05s", "1h 02m". Empty for a missing or negative value.
 * @param {number|undefined|null} ms
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 10) return `${(Math.round(s * 10) / 10).toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad(Math.floor(s % 60))}s`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

/** How long a subagent has run (until endedAt, else now). @param {{startedAt?: number, endedAt?: number, state?: string}} s @param {number} [now] */
export function subagentDuration(s, now = Date.now()) {
  if (!s || !s.startedAt) return '';
  const end = s.state === 'running' ? now : (s.endedAt || s.updatedAt || now);
  return formatDuration(Math.max(0, end - s.startedAt));
}

/** @type {Record<string, {glyph: string, label: string}>} */
const STATE_INFO = {
  running: { glyph: '', label: 'running' }, // a spinner in the UI
  done: { glyph: '✓', label: 'done' },
  failed: { glyph: '✗', label: 'failed' },
  stopped: { glyph: '■', label: 'stopped' },
};
/** @param {string} state */
export function stateInfo(state) { return STATE_INFO[state] || { glyph: '?', label: String(state || 'unknown') }; }

/**
 * Merge log lines into a list by seq: no duplicates (the incoming copy wins), ascending, and at most `max`
 * newest kept. Returns a new array; neither input is changed.
 * @template {{seq: number}} T
 * @param {T[]} existing @param {T[]} incoming @param {number} [max]
 * @returns {T[]}
 */
export function mergeEntries(existing, incoming, max = Infinity) {
  if (!incoming || !incoming.length) return max < existing.length ? existing.slice(-max) : existing;
  const bySeq = new Map();
  for (const e of existing) bySeq.set(e.seq, e);
  for (const e of incoming) if (e && typeof e.seq === 'number') bySeq.set(e.seq, e);
  const all = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return all.length > max ? all.slice(-max) : all;
}

/**
 * Which lines a feed filter shows. filter: null = everything, '' = the session's own lines,
 * else a subagent id.
 * @template {{subagentId?: string}} T
 * @param {T[]} entries @param {string|null|undefined} filter
 * @returns {T[]}
 */
export function filterEntries(entries, filter) {
  if (filter === null || filter === undefined) return entries;
  return entries.filter((e) => (e.subagentId || '') === filter);
}

/** The `subagentId` param of activity.list for a filter (null = none = all lines). @param {string|null|undefined} filter */
export function listParams(filter) {
  return filter === null || filter === undefined ? {} : { subagentId: filter };
}

/**
 * The filter a drawer starts with for S.activityFor ({agentId, subagentId?}): that subagent, else all.
 * @param {{agentId?: string, subagentId?: string}|null|undefined} f
 */
export function initialFilter(f) { return f && f.subagentId ? f.subagentId : null; }

/**
 * Next S.activityFor for the Ctrl+Shift+Y toggle: open for `target`, switch when it shows another agent,
 * close when it shows `target` already (or when there is no target and it is open).
 * @param {{agentId: string, subagentId?: string}|null} current @param {string|null} target
 * @returns {{agentId: string}|null}
 */
export function toggleTarget(current, target) {
  if (current && (!target || current.agentId === target)) return null;
  return target ? { agentId: target } : null;
}

/** One-line summary of an entry for the feed. */
const KIND = /** @type {Record<string, {icon: string, label: string}>} */ ({
  prompt: { icon: '❯', label: 'Prompt' },
  tool: { icon: '▸', label: 'Tool' },
  tool_done: { icon: '✓', label: 'Done' },
  tool_error: { icon: '✗', label: 'Error' },
  permission: { icon: '◆', label: 'Permission' },
  subagent_start: { icon: '▶', label: 'Subagent started' },
  subagent_end: { icon: '■', label: 'Subagent finished' },
  turn_end: { icon: '↵', label: 'Turn ended' },
  session_start: { icon: '●', label: 'Session started' },
  session_end: { icon: '○', label: 'Session ended' },
  notice: { icon: 'ℹ', label: 'Notice' },
});

/**
 * What the feed shows for one entry.
 * @param {any} e ActivityEntry
 * @param {(subagentId: string) => any} [lookup] finds a Subagent by id (for the "who" column)
 * @returns {{kind: string, time: string, icon: string, who: string, whoTitle: string, label: string, detail: string, dur: string, error: boolean, needs: boolean}}
 */
export function describeEntry(e, lookup) {
  const k = KIND[e.kind] || { icon: '·', label: String(e.kind || '') };
  let who = 'Session';
  let whoTitle = 'The session itself';
  if (e.subagentId) {
    const s = lookup ? lookup(e.subagentId) : null;
    const info = typeInfo(s ? s.type : e.type);
    const title = s ? subagentTitle(s) : '';
    who = `${info.emoji} ${clip(title || 'subagent', 24)}`;
    whoTitle = title ? `${info.emoji} ${title} (${info.label})` : `Subagent ${e.subagentId}`;
  }
  let label = '';
  let detail = '';
  switch (e.kind) {
    case 'prompt': label = ''; detail = e.text || ''; break;
    case 'tool': case 'tool_done': case 'tool_error': case 'permission':
      label = e.tool || k.label;
      detail = e.detail || '';
      if (e.kind === 'tool_error' && e.text) detail = detail ? `${detail}: ${e.text}` : e.text;
      if (e.kind === 'permission') detail = detail || 'asked for permission';
      break;
    case 'subagent_start': label = 'Started'; detail = e.text ? `"${e.text}"${e.type ? ` (${typeInfo(e.type).label})` : ''}` : (e.type ? typeInfo(e.type).label : ''); break;
    case 'subagent_end': label = 'Finished'; detail = e.text || ''; break;
    case 'turn_end': label = 'Turn ended'; detail = e.text || ''; break;
    case 'session_start': label = 'Session started'; detail = e.text || ''; break;
    case 'session_end': label = 'Session ended'; detail = e.text || ''; break;
    default: label = ''; detail = e.text || e.detail || '';
  }
  return {
    kind: e.kind, time: formatTime(e.at), icon: k.icon, who, whoTitle, label, detail,
    dur: e.kind === 'tool_done' || e.kind === 'tool_error' ? formatDuration(e.ms) : '',
    error: e.kind === 'tool_error', needs: e.kind === 'permission',
  };
}

/**
 * The line the feed copies / searches: everything of an entry as plain text.
 * @param {any} e @param {(subagentId: string) => any} [lookup]
 */
export function entryText(e, lookup) {
  const d = describeEntry(e, lookup);
  return [d.time, d.who, d.label, d.detail, d.dur].filter(Boolean).join(' ');
}

/**
 * Is the feed at (or within `slack` px of) the bottom? Then new lines scroll into view.
 * @param {{scrollTop: number, clientHeight: number, scrollHeight: number}} el @param {number} [slack]
 */
export function atBottom(el, slack = 24) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

/** How many subagents run. @param {any[]} subs */
export function runningCount(subs) {
  return (subs || []).filter((s) => s && s.state === 'running').length;
}

/**
 * Running subagents for a badge: from the live list when there is one, else from status.subagents.
 * @param {any[]} subs @param {any} [status]
 * @returns {number}
 */
export function badgeCount(subs, status) {
  if (subs && subs.length) return runningCount(subs);
  return status && status.subagents && typeof status.subagents.running === 'number' ? status.subagents.running : 0;
}

/**
 * What a tile's strip shows: the running subagents (needs-you first, then oldest first), at most
 * `maxChips` of them, how many more run, and how many are done / failed.
 * @param {any[]} subs @param {number} [maxChips]
 */
export function stripModel(subs, maxChips = 3) {
  const list = subs || [];
  const running = list.filter((s) => s.state === 'running')
    .sort((a, b) => (b.needsYou ? 1 : 0) - (a.needsYou ? 1 : 0) || (a.startedAt || 0) - (b.startedAt || 0));
  return {
    chips: running.slice(0, maxChips),
    more: Math.max(0, running.length - maxChips),
    done: list.filter((s) => s.state === 'done').length,
    failed: list.filter((s) => s.state === 'failed').length,
    needs: running.filter((s) => s.needsYou).length,
  };
}

/** A key that changes when the strip would look different (so tiles re-render it only then). @param {any[]} subs */
export function stripKey(subs) {
  const m = stripModel(subs);
  return `${m.chips.map((s) => `${s.id}|${s.title}|${s.type}|${s.tool || ''}|${s.needsYou ? 1 : 0}`).join('~')}#${m.more}#${m.done}#${m.failed}`;
}

/**
 * The subagent a permission prompt came from (status.askedBy), for the approval card.
 * @param {any[]} subs @param {string|undefined} askedBy
 * @returns {{id: string, emoji: string, title: string}|null}  title '' when the subagent is not known (yet)
 */
export function askedByInfo(subs, askedBy) {
  if (!askedBy) return null;
  const s = (subs || []).find((x) => x.id === askedBy);
  return s ? { id: s.id, emoji: typeInfo(s.type).emoji, title: subagentTitle(s) } : { id: askedBy, emoji: SUBAGENT_DEFAULT_EMOJI, title: '' };
}

/**
 * Entries still to render: the newest `limit`.
 * @template T @param {T[]} entries @param {number} [limit]
 */
export function windowOf(entries, limit = MAX_LINES) {
  return entries.length > limit ? entries.slice(-limit) : entries;
}
