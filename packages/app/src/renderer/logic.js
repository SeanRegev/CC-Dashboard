// @ts-check
/**
 * Pure renderer logic: no DOM, no network. Everything here is unit-tested in Node (tests/unit/logic.test.js).
 * Shapes follow packages/shared/protocol.js (Space, Agent, AgentStatus).
 */

/** Same order as STATES in packages/shared/protocol.js (a unit test keeps them in sync). */
export const STATE_ORDER = Object.freeze(['needs_you', 'working', 'starting', 'idle', 'stopped', 'exited']);

/** Status colours. */
export const STATE_COLORS = Object.freeze({
  needs_you: '#F0B44C',
  working: '#86CF86',
  starting: '#7DA7F0',
  idle: '#B7ACF2',
  stopped: '#857D76',
  exited: '#857D76',
});

const STATE_LABELS = Object.freeze({
  needs_you: 'Needs you',
  working: 'Working',
  starting: 'Starting',
  idle: 'Done',
  stopped: 'Stopped',
  exited: 'Exited',
});

/** @param {string} state */
export function stateLabel(state) {
  return STATE_LABELS[/** @type {keyof typeof STATE_LABELS} */ (state)] || 'Unknown';
}

/** @param {string} state */
export function stateColor(state) {
  return STATE_COLORS[/** @type {keyof typeof STATE_COLORS} */ (state)] || STATE_COLORS.stopped;
}

/** @param {string} state */
export function stateRank(state) {
  const i = STATE_ORDER.indexOf(state);
  return i < 0 ? STATE_ORDER.length : i;
}

/**
 * Sidebar order: by state (needs_you first), then the longest-waiting needs_you first,
 * then the most recently updated, then by name.
 * @template {{agent:{name:string, createdAt?:number}, status?:{state:string, updatedAt?:number, needsSince?:number}}} T
 * @param {T[]} entries
 * @returns {T[]}
 */
export function sortAgents(entries) {
  return [...entries].sort((a, b) => {
    const sa = a.status ? a.status.state : 'stopped';
    const sb = b.status ? b.status.state : 'stopped';
    const r = stateRank(sa) - stateRank(sb);
    if (r) return r;
    if (sa === 'needs_you') {
      const na = (a.status && a.status.needsSince) || Infinity;
      const nb = (b.status && b.status.needsSince) || Infinity;
      if (na !== nb) return na - nb;
    }
    const ua = (a.status && a.status.updatedAt) || a.agent.createdAt || 0;
    const ub = (b.status && b.status.updatedAt) || b.agent.createdAt || 0;
    if (ua !== ub) return ub - ua;
    return a.agent.name.localeCompare(b.agent.name);
  });
}

/**
 * Agent counts per space.
 * @param {Array<{agent:{spaceId:string}, status?:{state:string}}>} entries
 * @returns {Record<string, {total:number, needs:number, working:number}>}
 */
export function spaceCounts(entries) {
  /** @type {Record<string, {total:number, needs:number, working:number}>} */
  const out = {};
  for (const e of entries) {
    const c = out[e.agent.spaceId] || (out[e.agent.spaceId] = { total: 0, needs: 0, working: 0 });
    c.total++;
    const s = e.status && e.status.state;
    if (s === 'needs_you') c.needs++;
    if (s === 'working') c.working++;
  }
  return out;
}

/**
 * Short relative time: "now", "45s", "12m", "3h", "2d".
 * @param {number|undefined} ms   epoch ms
 * @param {number} [now]
 */
export function formatRelativeTime(ms, now = Date.now()) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Token counts: 950, 1.2k, 48k, 1.3M.
 * @param {number|undefined} n
 */
export function formatTokens(n) {
  if (!n || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/**
 * Context-window fill, 0..100. The protocol's `contextPct` is read as a percentage.
 * @param {{contextPct?:number}|undefined} usage
 */
export function contextPercent(usage) {
  const p = usage && typeof usage.contextPct === 'number' ? usage.contextPct : 0;
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, Math.round(p)));
}

/** @param {number} pct */
export function gaugeLevel(pct) {
  if (pct >= 85) return 'high';
  if (pct >= 60) return 'mid';
  return 'low';
}

/**
 * Friendly model name: "claude-sonnet-4-5-20250929" → "Sonnet 4.5", "opus" → "Opus", "" → "Default".
 * @param {string|undefined} model
 */
export function modelLabel(model) {
  if (!model) return 'Default';
  const m = /(opus|sonnet|haiku)(?:-(\d+)(?:[-.](\d{1,2}))?)?(?!\d)/i.exec(model);
  if (!m) return model;
  const fam = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  if (!m[2]) return fam;
  return m[3] ? `${fam} ${m[2]}.${m[3]}` : `${fam} ${m[2]}`;
}

/**
 * One line for the sidebar: what the agent is doing right now.
 * @param {{state:string, tool?:string, detail?:string, message?:string, lastPrompt?:string}|undefined} status
 */
export function describeActivity(status) {
  if (!status) return 'No status yet';
  switch (status.state) {
    case 'needs_you': return status.message || 'Waiting for your input';
    case 'working':
      if (status.tool && status.detail) return `${status.tool} · ${status.detail}`;
      if (status.tool) return status.tool;
      return 'Thinking…';
    case 'starting': return 'Starting Claude…';
    case 'idle': return status.lastPrompt ? `Done · ${status.lastPrompt}` : 'Ready for a prompt';
    case 'stopped': return 'Stopped · resume to continue';
    case 'exited': return 'Exited';
    default: return status.state;
  }
}

/**
 * The time shown on a card: how long it has been waiting (needs_you), else since the last change.
 * @param {{state:string, updatedAt?:number, needsSince?:number}|undefined} status
 * @param {number} [now]
 */
export function cardTime(status, now = Date.now()) {
  if (!status) return '';
  if (status.state === 'needs_you' && status.needsSince) return formatRelativeTime(status.needsSince, now);
  return formatRelativeTime(status.updatedAt, now);
}

/**
 * Map a keydown to an app shortcut, or null when the key belongs to the terminal.
 * Ctrl+C, Ctrl+D, Ctrl+R … are never shortcuts: they must reach Claude untouched.
 * @param {{key:string, code?:string, ctrlKey:boolean, shiftKey:boolean, altKey:boolean, metaKey:boolean, type?:string}} ev
 * @param {string} [platform]  process.platform; on macOS Cmd plays the role of Ctrl
 * @returns {null | {action:'newAgent'|'closeTab'|'nextTab'|'prevTab'|'gotoTab'|'toggleSplit'|'quickSwitch'|'copy'|'paste', index?:number}}
 */
/** Ctrl+Shift+<key> → view. @type {Record<string, string>} */
export const VIEW_KEYS = Object.freeze({
  KeyT: 'terminals', KeyG: 'grid', KeyB: 'board', KeyA: 'inbox', KeyL: 'library', KeyD: 'dashboards', KeyU: 'usage',
});

export function shortcutFor(ev, platform = 'win32') {
  // F2: rename / change role of the focused agent (no modifier; Claude Code doesn't use F2).
  if ((ev.key === 'F2' || ev.code === 'F2') && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey) return { action: 'editAgent' };
  const mod = platform === 'darwin' ? ev.metaKey : ev.ctrlKey;
  if (!mod || ev.altKey) return null;
  if (platform !== 'darwin' && ev.metaKey) return null;
  const key = (ev.key || '').toLowerCase();
  const code = ev.code || '';
  if (key === 'tab' || code === 'Tab') return { action: ev.shiftKey ? 'prevTab' : 'nextTab' };
  if (ev.shiftKey) {
    // Terminal-style copy/paste: Ctrl+Shift+C / Ctrl+Shift+V (plain Ctrl+C stays an interrupt).
    if (platform !== 'darwin' && (code === 'KeyC' || key === 'c')) return { action: 'copy' };
    if (platform !== 'darwin' && (code === 'KeyV' || key === 'v')) return { action: 'paste' };
    // Views: Ctrl+Shift+<letter>. Plain Ctrl+B / Ctrl+L / Ctrl+I belong to the terminal and Claude Code.
    // Activity drawer of the focused agent (M3). Plain Ctrl+Y stays with the terminal.
    if (code === 'KeyY' || key === 'y') return { action: 'activity' };
    const view = VIEW_KEYS[code] || VIEW_KEYS[`Key${key.toUpperCase()}`];
    if (view) return { action: 'view', view };
    return null;
  }
  if (code === 'Comma' || key === ',') return { action: 'settings' };
  const digit = /^Digit([1-9])$/.exec(code) || /^([1-9])$/.exec(key);
  if (digit) return { action: 'gotoTab', index: Number(digit[1]) - 1 };
  if (code === 'Backslash' || key === '\\') return { action: 'toggleSplit' };
  if (key === 't' || (!key && code === 'KeyT')) return { action: 'newAgent' };
  if (key === 'w' || (!key && code === 'KeyW')) return { action: 'closeTab' };
  if (key === 'k' || (!key && code === 'KeyK')) return { action: 'quickSwitch' };
  return null;
}

/**
 * Index of the tab after `current` (wrapping). `delta` = +1 next, -1 previous.
 * @param {number} current
 * @param {number} count
 * @param {number} delta
 */
export function cycleIndex(current, count, delta) {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (((current + delta) % count) + count) % count;
}

/**
 * Quick-switcher filter: name prefix > name substring > name subsequence > space or activity substring.
 * Ties keep the usual sidebar order.
 * @template {{agent:{name:string, spaceId:string}, status?:any}} T
 * @param {string} query
 * @param {T[]} entries
 * @param {Record<string,{name:string}>} [spacesById]
 * @returns {T[]}
 */
export function filterAgents(query, entries, spacesById = {}) {
  const q = query.trim().toLowerCase();
  const sorted = sortAgents(entries);
  if (!q) return sorted;
  /** @type {Array<{e:T, score:number, i:number}>} */
  const hits = [];
  sorted.forEach((e, i) => {
    const name = e.agent.name.toLowerCase();
    const space = ((spacesById[e.agent.spaceId] || {}).name || e.agent.spaceId).toLowerCase();
    let score = -1;
    if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (subsequence(q, name)) score = 2;
    else if (space.includes(q) || describeActivity(e.status).toLowerCase().includes(q)) score = 3;
    if (score >= 0) hits.push({ e, score, i });
  });
  return hits.sort((a, b) => a.score - b.score || a.i - b.i).map((h) => h.e);
}

/** @param {string} needle @param {string} hay */
function subsequence(needle, hay) {
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) if (hay[i] === needle[j]) j++;
  return j === needle.length;
}

/**
 * Suggest a name for a new agent that does not clash with the space's agents: "agent-1", "agent-2"…
 * @param {Array<{agent:{name:string, spaceId:string}}>} entries
 * @param {string} spaceId
 */
export function suggestAgentName(entries, spaceId) {
  const taken = new Set(entries.filter((e) => e.agent.spaceId === spaceId).map((e) => e.agent.name));
  for (let i = 1; ; i++) if (!taken.has(`agent-${i}`)) return `agent-${i}`;
}

/**
 * Reconnect delay with exponential backoff and a cap. attempt = 0, 1, 2 …
 * @param {number} attempt
 * @param {{base?:number, max?:number, jitter?:number}} [opts]   jitter is 0..1 of the delay
 * @param {() => number} [rand]
 */
export function backoffDelay(attempt, opts = {}, rand = Math.random) {
  const base = opts.base ?? 250;
  const max = opts.max ?? 5000;
  const jitter = opts.jitter ?? 0.2;
  const d = Math.min(max, base * 2 ** Math.max(0, attempt));
  return Math.round(d * (1 - jitter + jitter * 2 * rand()));
}

/**
 * Split-pane bookkeeping. `panes` holds the agent id shown in each pane (null = empty pane).
 * Toggling with one pane opens a second pane on the most recent other tab; toggling with two
 * closes the second pane (its agent stays open as a tab).
 * @param {{panes: Array<string|null>, focused: number}} layout
 * @param {string[]} tabs  open agent ids, in tab order
 * @returns {{panes: Array<string|null>, focused: number}}
 */
export function toggleSplit(layout, tabs) {
  if (layout.panes.length >= 2) {
    const keep = layout.panes[layout.focused] ?? layout.panes[0] ?? null;
    return { panes: [keep], focused: 0 };
  }
  const first = layout.panes[0] ?? null;
  const other = tabs.find((t) => t !== first) ?? null;
  return { panes: [first, other], focused: 1 };
}

/**
 * Show agent `id` in the focused pane. If it is already in the other pane, focus that pane instead.
 * @param {{panes: Array<string|null>, focused: number}} layout
 * @param {string} id
 */
export function showInPane(layout, id) {
  const at = layout.panes.indexOf(id);
  if (at >= 0) return { panes: [...layout.panes], focused: at };
  const panes = layout.panes.length ? [...layout.panes] : [null];
  const f = Math.min(layout.focused, panes.length - 1);
  panes[f] = id;
  return { panes, focused: f };
}

/**
 * Remove a closed tab from the layout: panes showing it fall back to a tab that is not on screen.
 * @param {{panes: Array<string|null>, focused: number}} layout
 * @param {string} id          the closed agent id
 * @param {string[]} tabsAfter open tabs after closing
 */
export function closeInLayout(layout, id, tabsAfter) {
  const panes = layout.panes.map((p) => (p === id ? null : p));
  for (let i = 0; i < panes.length; i++) {
    if (panes[i] === null) {
      const free = tabsAfter.find((t) => !panes.includes(t));
      panes[i] = free ?? null;
    }
  }
  if (panes.length === 2 && panes[1] === null) return { panes: [panes[0]], focused: 0 };
  if (panes.length === 2 && panes[0] === null) return { panes: [panes[1]], focused: 0 };
  return { panes, focused: Math.min(layout.focused, panes.length - 1) };
}

// ---------- Layouts (M2): grid order, board columns, space groups, snapshots ----------

/**
 * Grid order: the space's Main session first, then by state (needs you, working, starting, done,
 * stopped, exited). Unlike sidebar order it never uses "last updated" as a tie-break, so tiles do not
 * jump around while a working agent prints: ties fall back to creation time, then name.
 * @template {{agent:{name:string, createdAt?:number, role?:{id?:string}}, status?:{state:string, needsSince?:number}}} T
 * @param {T[]} entries
 * @returns {T[]}
 */
export function gridOrder(entries) {
  /** @param {T} e */
  const main = (e) => (e.agent.role && e.agent.role.id === 'main' ? 0 : 1);
  return [...entries].sort((a, b) => {
    const m = main(a) - main(b);
    if (m) return m;
    const sa = a.status ? a.status.state : 'stopped';
    const sb = b.status ? b.status.state : 'stopped';
    const r = stateRank(sa) - stateRank(sb);
    if (r) return r;
    if (sa === 'needs_you') {
      const na = (a.status && a.status.needsSince) || Infinity;
      const nb = (b.status && b.status.needsSince) || Infinity;
      if (na !== nb) return na - nb;
    }
    const ca = a.agent.createdAt || 0;
    const cb = b.agent.createdAt || 0;
    if (ca !== cb) return ca - cb;
    return a.agent.name.localeCompare(b.agent.name);
  });
}

/** Board columns, left to right. */
export const BOARD_COLUMNS = Object.freeze([
  Object.freeze({ id: 'needs', label: 'Needs you', states: Object.freeze(['needs_you']) }),
  Object.freeze({ id: 'working', label: 'Working', states: Object.freeze(['working', 'starting']) }),
  Object.freeze({ id: 'done', label: 'Done', states: Object.freeze(['idle']) }),
  Object.freeze({ id: 'stopped', label: 'Stopped', states: Object.freeze(['stopped', 'exited']) }),
]);

/** Which board column a state belongs to. @param {string} state */
export function boardColumnOf(state) {
  const c = BOARD_COLUMNS.find((x) => x.states.includes(state));
  return c ? c.id : 'stopped';
}

/**
 * Entries split into the board columns, each in sidebar order (Main first within a column).
 * @template {{agent:{name:string, createdAt?:number, role?:{id?:string}}, status?:{state:string, updatedAt?:number, needsSince?:number}}} T
 * @param {T[]} entries
 * @returns {Record<string, T[]>}
 */
export function boardColumns(entries) {
  /** @type {Record<string, T[]>} */
  const out = {};
  for (const c of BOARD_COLUMNS) out[c.id] = [];
  for (const e of sortAgents(/** @type {any[]} */ (entries))) out[boardColumnOf(e.status ? e.status.state : 'stopped')].push(e);
  return out;
}

/**
 * "All spaces" mode: entries grouped by space, spaces that need you first (most waiting first), then
 * the spaces' own order. Spaces without agents are left out; agents of unknown spaces are grouped under their id.
 * @template {{agent:{name:string, spaceId:string}, status?:{state:string}}} T
 * @param {T[]} entries
 * @param {Array<{id:string, name:string}>} spaces
 * @returns {Array<{space:{id:string, name:string}, entries:T[]}>}
 */
export function groupBySpace(entries, spaces) {
  const known = new Map(spaces.map((s) => [s.id, s]));
  /** @type {Map<string, T[]>} */
  const by = new Map();
  for (const e of entries) {
    const list = by.get(e.agent.spaceId) || [];
    list.push(e);
    by.set(e.agent.spaceId, list);
  }
  const ids = [...spaces.map((s) => s.id), ...[...by.keys()].filter((id) => !known.has(id))];
  const groups = ids.filter((id) => by.has(id)).map((id, i) => {
    const list = sortAgents(/** @type {any[]} */ (by.get(id)));
    const needs = list.filter((e) => e.status && e.status.state === 'needs_you').length;
    return { space: known.get(id) || { id, name: id }, entries: /** @type {T[]} */ (list), needs, i };
  });
  groups.sort((a, b) => (b.needs > 0) - (a.needs > 0) || b.needs - a.needs || a.i - b.i);
  return groups.map(({ space, entries: list }) => ({ space, entries: list }));
}

/**
 * Last `max` lines of a terminal buffer for a tile snapshot: trailing blank lines dropped.
 * @param {string[]} lines @param {number} [max]
 */
export function tailLines(lines, max = 40) {
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  return lines.slice(Math.max(0, end - max), end).map((l) => l.replace(/\s+$/, ''));
}
