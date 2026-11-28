// @ts-check
/**
 * Outside sessions (contract v3 ExternalSession): Claude Code sessions that run on this computer but that
 * CC-Dashboard did not start (a terminal, VS Code, ...). Owner: the Outside UI track (M3).
 *
 * They are view only: the app has no terminal for them, so no Allow / Deny and no typing. What you can do is look
 * at their activity (ctx.openActivity) and take one over (external.takeOver), which ends the outside process and
 * reopens the same conversation in the app.
 *
 * Two halves in this file:
 *   - pure helpers (labels, grouping, sorting, feed lines): no DOM, unit-tested in Node (tests/unit/external.test.js)
 *   - DOM pieces the views plug in: createExternalTiles (Grid), outsideBlock / otherFoldersBlock (sidebar),
 *     externalBoardCard (Board), externalInboxRow (Inbox), openTakeOverDialog (all of them)
 */
import { h, mount, icon } from '../dom.js';
import { formatRelativeTime } from '../logic.js';
import { openModal } from '../dialogs.js';
import { sidebarSubagents } from './subagent-cards.js';

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

/**
 * Where a session runs, as a short name, from Claude's `entrypoint` ("cli", "claude-vscode", "jetbrains", ...).
 * @param {string|undefined} entrypoint
 */
export function entrypointLabel(entrypoint) {
  const e = String(entrypoint || '').trim().toLowerCase();
  if (!e || e === 'cli' || e === 'terminal' || e === 'repl') return 'Terminal';
  if (e.includes('vscode') || e.includes('vs-code') || e === 'code') return 'VS Code';
  if (e.includes('cursor')) return 'Cursor';
  if (e.includes('windsurf')) return 'Windsurf';
  if (e.includes('jetbrains') || e.includes('intellij') || e.includes('idea') || e.includes('pycharm') || e.includes('webstorm')) return 'JetBrains';
  if (e.includes('desktop')) return 'Claude Desktop';
  if (e.startsWith('sdk')) return 'an SDK app';
  return String(entrypoint).trim();
}

/** "running in VS Code" / "running in a terminal". @param {string|undefined} entrypoint */
export function runsIn(entrypoint) {
  const l = entrypointLabel(entrypoint);
  return l === 'Terminal' ? 'running in a terminal' : `running in ${l}`;
}

/** @param {'working'|'idle'|'needs_you'|'unknown'|string} state */
export function externalStateLabel(state) {
  return /** @type {Record<string, string>} */ ({ working: 'Working', idle: 'Idle', needs_you: 'Waiting for you', unknown: 'State unknown' })[state] || 'State unknown';
}

/** Dot class: the app's own states. @param {string} state */
export function externalDotState(state) {
  return state === 'working' ? 'working' : state === 'needs_you' ? 'needs_you' : state === 'idle' ? 'idle' : 'stopped';
}

/** Board column of an outside session. @param {string} state @returns {'needs'|'working'|'done'} */
export function externalBoardColumn(state) {
  return state === 'needs_you' ? 'needs' : state === 'working' ? 'working' : 'done';
}

const STATE_RANK = /** @type {Record<string, number>} */ ({ needs_you: 0, working: 1, idle: 2, unknown: 3 });

/**
 * Needs you first, then working, idle, unknown; most recently active first; name as the last tie-break.
 * @template {{state:string, updatedAt?:number, name?:string}} T
 * @param {T[]} list @returns {T[]}
 */
export function sortExternal(list) {
  return [...list].sort((a, b) =>
    (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9)
    || (b.updatedAt || 0) - (a.updatedAt || 0)
    || String(a.name || '').localeCompare(String(b.name || '')));
}

/** Folder path with one slash style and no trailing slash; case-folded when it is a Windows path. @param {string} p */
export function normPath(p) {
  const s = String(p || '');
  const win = /^[a-z]:[\\/]/i.test(s) || s.startsWith('\\\\') || s.includes('\\');
  let n = s.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!n && s) n = '/';
  return win ? n.toLowerCase() : n;
}

/** Last folder name of a path, either slash. @param {string} p */
export function folderName(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || '');
}

/**
 * A path for display: short ones as they are, long ones as `C:\…\parent\folder` (the drive or first segment,
 * an ellipsis, the last two segments), in the path's own slash style. The full path belongs in a tooltip.
 * @param {string} p @param {number} [max]
 */
export function displayPath(p, max = 42) {
  const s = String(p || '');
  if (s.length <= max) return s;
  const sep = s.includes('\\') && !s.includes('/') ? '\\' : s.includes('\\') ? '\\' : '/';
  const parts = s.split(/[\\/]+/);
  const lead = parts[0] === '' ? sep : `${parts[0]}${sep}`; // "/" or "C:\"
  const tail = parts.slice(-2).join(sep);
  const out = `${lead}…${sep}${tail}`;
  return out.length < s.length ? out : s;
}

/**
 * The space of a session: the one the core named (if it still exists), else the space whose folder equals or
 * contains cwd (covers a space that was added after the core last looked). Longest folder wins.
 * @param {{spaceId?:string, cwd:string}} x @param {Array<{id:string, path:string}>} spaces @returns {string|null}
 */
export function spaceOfSession(x, spaces) {
  if (x.spaceId && spaces.some((s) => s.id === x.spaceId)) return x.spaceId;
  const cwd = normPath(x.cwd);
  let best = null;
  let bestLen = -1;
  for (const s of spaces) {
    const sp = normPath(s.path);
    if (!sp) continue;
    if ((cwd === sp || cwd.startsWith(sp.endsWith('/') ? sp : `${sp}/`)) && sp.length > bestLen) { best = s.id; bestLen = sp.length; }
  }
  return best;
}

/**
 * Sessions grouped by space; the ones in no space go to `other`. Each list is sorted (sortExternal).
 * @template {{state:string, spaceId?:string, cwd:string, updatedAt?:number, name?:string}} T
 * @param {T[]} sessions @param {Array<{id:string, path:string}>} spaces
 * @returns {{bySpace: Map<string, T[]>, other: T[]}}
 */
export function groupExternal(sessions, spaces) {
  /** @type {Map<string, T[]>} */
  const bySpace = new Map();
  /** @type {T[]} */
  const other = [];
  for (const x of sortExternal(sessions)) {
    const sid = spaceOfSession(x, spaces);
    if (!sid) { other.push(x); continue; }
    const l = bySpace.get(sid) || [];
    l.push(x);
    bySpace.set(sid, l);
  }
  return { bySpace, other };
}

/**
 * The sessions of one space (or all that match `spaceId === null` → every session), sorted.
 * @template {{state:string, spaceId?:string, cwd:string, updatedAt?:number, name?:string}} T
 * @param {T[]} sessions @param {Array<{id:string, path:string}>} spaces @param {string|null} spaceId
 */
export function externalOfSpace(sessions, spaces, spaceId) {
  if (spaceId === null) return sortExternal(sessions);
  return sortExternal(sessions.filter((x) => spaceOfSession(x, spaces) === spaceId));
}

/** What a session does right now, in one line. @param {any} x */
export function externalActivityText(x) {
  if (x.state === 'working') return x.tool ? `${x.tool}${x.detail ? ` ${x.detail}` : ''}` : 'Working…';
  if (x.state === 'needs_you') return `Waiting for you in ${entrypointLabel(x.entrypoint)}`;
  if (x.state === 'idle') return x.lastPrompt ? `Idle · ${x.lastPrompt}` : 'Idle';
  return 'State unknown';
}

/** Short text of an entry's detail. @param {string|undefined} s @param {number} n */
function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * One activity entry as a feed line, or null for the ones a small tile skips.
 * @param {any} e @returns {{icon:string, text:string, kind:string, error:boolean}|null}
 */
export function feedLine(e) {
  const tool = e.tool || 'tool';
  const what = `${tool}${e.detail ? ` ${clip(e.detail, 120)}` : ''}`;
  switch (e.kind) {
    case 'prompt': return { icon: '›', text: clip(e.text, 140) || 'prompt', kind: e.kind, error: false };
    case 'tool': return { icon: '▸', text: what, kind: e.kind, error: false };
    case 'tool_done': return { icon: '✓', text: what, kind: e.kind, error: false };
    case 'tool_error': return { icon: '✗', text: what, kind: e.kind, error: true };
    case 'permission': return { icon: '◆', text: `asked to run ${what}`, kind: e.kind, error: false };
    case 'subagent_start': return { icon: '↳', text: `started ${clip(e.text, 100) || 'a subagent'}`, kind: e.kind, error: false };
    case 'subagent_end': return { icon: '↲', text: `finished ${clip(e.text, 100) || 'a subagent'}`, kind: e.kind, error: false };
    case 'turn_end': return { icon: '■', text: e.text ? `turn finished: ${clip(e.text, 100)}` : 'turn finished', kind: e.kind, error: false };
    case 'notice': return { icon: '·', text: clip(e.text, 140), kind: e.kind, error: false };
    case 'session_end': return { icon: '■', text: 'session ended', kind: e.kind, error: false };
    default: return null; // session_start
  }
}

/**
 * The last `max` lines for a tile. A `tool` line is dropped once its `tool_done` / `tool_error` is there
 * (same subagent, tool and detail), so every call shows once.
 * @param {any[]} entries oldest first @param {number} [max]
 * @returns {Array<{seq:number, icon:string, text:string, kind:string, error:boolean, sub:boolean}>}
 */
export function recentFeed(entries, max = 6) {
  /** @type {Array<{seq:number, icon:string, text:string, kind:string, error:boolean, sub:boolean}>} */
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.kind === 'tool') {
      const closed = entries.slice(i + 1).some((n) => (n.kind === 'tool_done' || n.kind === 'tool_error') && n.subagentId === e.subagentId && n.tool === e.tool && n.detail === e.detail);
      if (closed) continue;
    }
    const l = feedLine(e);
    if (l) out.push({ seq: e.seq, ...l, sub: !!e.subagentId });
  }
  return out.slice(-max);
}

/**
 * Merge two lists of activity entries (by seq, oldest first), keeping the newest `cap`.
 * @param {any[]} a @param {any[]} b @param {number} [cap]
 */
export function mergeEntries(a, b, cap = 60) {
  /** @type {Map<number, any>} */
  const by = new Map();
  for (const e of a) by.set(e.seq, e);
  for (const e of b) by.set(e.seq, e);
  const all = [...by.values()].sort((x, y) => x.seq - y.seq);
  return all.length > cap ? all.slice(all.length - cap) : all;
}

/**
 * The words of the take-over dialog. `working`: the session is busy now (or the core said so).
 * @param {{name:string, entrypoint?:string, cwd:string, state:string, tool?:string, detail?:string}} x
 * @param {{working: boolean, spaceName: string|null}} o
 */
/** external.takeOver can need ~13 s on the core plus process queries on Windows. */
export const TAKEOVER_TIMEOUT_MS = 45000;

export function takeOverCopy(x, o) {
  const where = entrypointLabel(x.entrypoint);
  const whereIn = where === 'Terminal' ? 'the terminal' : where;
  const doing = x.tool ? `${x.tool}${x.detail ? ` ${clip(x.detail, 80)}` : ''}` : '';
  return {
    title: `Take over “${x.name}”`,
    lead: `This ends the session in ${whereIn} and reopens the same conversation here, with its terminal. Anything it is doing right now stops.`,
    warning: o.working ? `It is working right now${doing ? ` (${doing})` : ''}. Taking over stops it in the middle of its turn.` : '',
    space: o.spaceName ? `It joins the space “${o.spaceName}”.` : `Its folder is not a space yet: a new space “${folderName(x.cwd)}” is added for it.`,
    button: o.working ? 'End it and take over' : 'Take over',
    busy: 'Taking over…',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Take over dialog
// ---------------------------------------------------------------------------------------------------------------

/**
 * Ask, then external.takeOver. Idle: confirm. Working (or the core answers still_working): a warning and
 * "End it and take over" (force). On success the new agent opens.
 * @param {import('../context.js').ViewContext} ctx @param {any} x the outside session
 */
export function openTakeOverDialog(ctx, x) {
  const live = () => ctx.external().find((s) => s.id === x.id) || x;
  let force = live().state === 'working';
  let busy = false;
  const spaceName = () => {
    const sid = spaceOfSession(live(), ctx.state().spaces);
    const sp = sid && ctx.state().spaces.find((/** @type {any} */ s) => s.id === sid);
    return sp ? sp.name : null;
  };

  const body = h('div', { class: 'modal-body eo-body' });
  const err = h('div', { class: 'form-error', role: 'alert' });
  const cancel = h('button', { type: 'button', class: 'btn ghost', id: 'eo-cancel', onclick: () => close() }, 'Cancel');
  const go = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn primary', id: 'eo-confirm' }));
  const card = h('div', { class: 'modal eo-modal', role: 'dialog', 'aria-label': 'Take over', dataset: { ext: x.id } },
    h('div', { class: 'modal-head' },
      h('span', { class: 'modal-icon eo-icon' }, '👁'),
      h('div', null, h('div', { class: 'modal-title', id: 'eo-title' }), h('div', { class: 'modal-sub', id: 'eo-sub' })),
      h('button', { type: 'button', class: 'icon-btn modal-x', title: 'Close (Esc)', onclick: () => close() }, icon('close'))),
    body, h('div', { class: 'modal-foot' }, cancel, go));

  function draw() {
    const cur = live();
    const t = takeOverCopy(cur, { working: force, spaceName: spaceName() });
    /** @type {HTMLElement} */ (card.querySelector('#eo-title')).textContent = t.title;
    /** @type {HTMLElement} */ (card.querySelector('#eo-sub')).textContent = `${runsIn(cur.entrypoint)} · ${displayPath(cur.cwd, 48)}`;
    mount(body,
      h('p', { class: 'eo-lead' }, t.lead),
      force ? h('div', { class: 'eo-warn', role: 'note', id: 'eo-warn' }, h('span', { class: 'eo-warn-mark', 'aria-hidden': 'true' }, '⚠'), h('span', null, t.warning)) : null,
      h('dl', { class: 'eo-facts' },
        h('dt', null, 'Folder'), h('dd', { title: cur.cwd, class: 'eo-path' }, cur.cwd),
        h('dt', null, 'Space'), h('dd', null, spaceName() || `New: ${folderName(cur.cwd)}`),
        h('dt', null, 'Last asked'), h('dd', null, cur.lastPrompt || '—')),
      h('p', { class: 'hint' }, t.space),
      err);
    go.textContent = busy ? t.busy : t.button;
    go.className = `btn ${force ? 'danger-solid' : 'primary'}`;
    go.disabled = busy;
    cancel.disabled = busy;
  }

  async function submit() {
    if (busy) return;
    busy = true;
    err.textContent = '';
    draw();
    try {
      const cur = live();
      // Ending the outside process can take a while (grace period + wait, slower on Windows): allow 45 s.
      const agent = await ctx.client.call('external.takeOver', { id: x.id, ...(force ? { force: true } : {}) }, { timeout: TAKEOVER_TIMEOUT_MS });
      const S = ctx.state();
      if (agent && !S.entries.has(agent.id)) {
        S.entries.set(agent.id, { agent, status: { agentId: agent.id, state: 'starting', counts: { tools: 0, turns: 0, errors: 0, subagents: 0 }, files: [], usage: { total: 0, context: 0, contextPct: 0, model: agent.model || '' }, history: [], updatedAt: Date.now() }, running: true });
      }
      S.external = S.external.filter((/** @type {any} */ s) => s.id !== x.id); // it leaves the outside list at once
      close();
      if (agent) ctx.openAgent(agent.id);
      ctx.toast(`Took over “${(agent && agent.name) || cur.name}”: it runs in the app now`);
      ctx.render();
    } catch (e) {
      busy = false;
      const code = /** @type {any} */ (e).code;
      if (code === 'still_working') { force = true; err.textContent = ''; } // busy after all: ask again, with the warning
      else err.textContent = code === 'not_allowed'
        ? `Could not end it safely: ${/** @type {any} */ (e).message}`
        : `Take over failed: ${/** @type {any} */ (e).message}`;
      draw();
    }
  }
  go.addEventListener('click', submit);
  card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !(ev.target instanceof HTMLButtonElement)) { ev.preventDefault(); submit(); } });

  const close = openModal('external-takeover', card);
  draw();
  go.focus();
  return close;
}

// ---------------------------------------------------------------------------------------------------------------
// Shared small pieces
// ---------------------------------------------------------------------------------------------------------------

/** The 👁 Outside badge. @param {any} x @param {{compact?: boolean}} [o] */
export function externalBadge(x, o = {}) {
  return h('span', { class: 'ext-badge', title: `Outside the app: ${runsIn(x.entrypoint)}. View only.`, dataset: { where: entrypointLabel(x.entrypoint) } },
    h('span', { class: 'ext-eye', 'aria-hidden': 'true' }, '👁'), h('span', { class: 'ext-badge-label' }, o.compact ? 'Outside' : 'Outside'));
}

/**
 * Activity + Take over (+ Add as space) buttons.
 * @param {import('../context.js').ViewContext} ctx @param {any} x @param {{addSpace?: boolean}} [o]
 */
export function externalActions(ctx, x, o = {}) {
  return h('span', { class: 'ext-actions' },
    h('button', { type: 'button', class: 'btn ghost small ext-activity', title: 'See what it is doing', onclick: (/** @type {Event} */ ev) => { ev.stopPropagation(); ctx.openActivity(x.id); } }, 'Activity'),
    o.addSpace ? h('button', { type: 'button', class: 'btn ghost small ext-add-space', title: `Add ${x.cwd} as a space`, onclick: (/** @type {Event} */ ev) => { ev.stopPropagation(); addAsSpace(ctx, x); } }, icon('plus'), 'Add as space') : null,
    h('button', { type: 'button', class: 'btn small ext-takeover', title: 'End it outside and continue the same conversation here', onclick: (/** @type {Event} */ ev) => { ev.stopPropagation(); openTakeOverDialog(ctx, x); } }, 'Take over'));
}

/** spaces.add for the session's folder. @param {import('../context.js').ViewContext} ctx @param {any} x */
export async function addAsSpace(ctx, x) {
  const space = await ctx.rpc('spaces.add', { path: x.cwd });
  if (!space) return;
  const S = ctx.state();
  if (!S.spaces.some((/** @type {any} */ s) => s.id === space.id)) S.spaces = [...S.spaces, space];
  ctx.toast(`Added the space “${space.name}”`);
  ctx.render();
}

/** @param {any} x */
function timeOf(x) { return formatRelativeTime(x.updatedAt); }

// ---------------------------------------------------------------------------------------------------------------
// Grid: view-only tiles
// ---------------------------------------------------------------------------------------------------------------

/**
 * The outside sessions' live feed (last ~40 lines each): activity.list once per session, then ctx.onActivity.
 * @param {import('../context.js').ViewContext} ctx
 */
function createFeed(ctx) {
  /** @type {Map<string, any[]>} */
  const logs = new Map();
  /** @type {Set<string>} */
  const asked = new Set();
  /** @type {Set<(id: string) => void>} */
  const listeners = new Set();
  const notify = (/** @type {string} */ id) => { for (const fn of listeners) fn(id); };
  const off = ctx.onActivity((id, entries) => {
    if (!id.startsWith('ext:')) return;
    logs.set(id, mergeEntries(logs.get(id) || [], entries));
    notify(id);
  });
  return {
    /** @param {string} id */
    entries(id) { return logs.get(id) || []; },
    /** @param {string} id */
    async ensure(id) {
      if (asked.has(id)) return;
      asked.add(id);
      try {
        const r = await ctx.client.call('activity.list', { agentId: id, limit: 40 });
        logs.set(id, mergeEntries(r && Array.isArray(r.entries) ? r.entries : [], logs.get(id) || []));
        notify(id);
      } catch { asked.delete(id); }
    },
    /** @param {string} id */
    forget(id) { logs.delete(id); asked.delete(id); },
    /** @param {(id: string) => void} fn */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    dispose() { off(); listeners.clear(); },
  };
}

/**
 * @typedef {Object} ExtTile
 * @property {HTMLElement} root
 * @property {HTMLElement} dot @property {HTMLElement} name @property {HTMLElement} where @property {HTMLElement} time
 * @property {HTMLElement} now @property {HTMLElement} prompt @property {HTMLElement} feed
 * @property {HTMLElement} state @property {HTMLElement} subs @property {HTMLElement} actions
 * @property {string} feedKey
 */

/**
 * The Grid's outside tiles. `sync(container, sessions)` makes sure the container ends with one tile per
 * session (in the given order), creating, updating in place and removing. Tiles are `.tile.ext-tile` so
 * they take part in the 4-visible / scroll layout like any other tile; they hold no terminal.
 * @param {import('../context.js').ViewContext} ctx
 */
export function createExternalTiles(ctx) {
  /** @type {Map<string, ExtTile>} */
  const tiles = new Map();
  /** @type {Map<string, any>} */
  const sessions = new Map();
  const feed = createFeed(ctx);
  feed.onChange((id) => { const t = tiles.get(id); if (t) drawFeed(t, id); });

  /** @param {any} x */
  function make(x) {
    const dot = h('span', { class: 'dot' });
    const name = h('span', { class: 'tile-name' });
    const where = h('span', { class: 'tile-activity' });
    const time = h('span', { class: 'tile-time' });
    const head = h('div', { class: 'tile-head' }, dot, externalBadge(x), name, where, time);
    const now = h('div', { class: 'ext-now' });
    const prompt = h('div', { class: 'ext-prompt' });
    const feedEl = h('ul', { class: 'ext-feed', 'aria-label': 'Latest activity' });
    const note = h('div', { class: 'ext-note' }, 'View only. Take over to type to it.');
    const body = h('div', { class: 'ext-tile-body' }, now, prompt, feedEl, note);
    const state = h('span', { class: 'tile-state' });
    const subs = h('span', { class: 'ext-subs' });
    const actions = h('span', { class: 'ext-foot-actions' });
    const foot = h('div', { class: 'tile-foot ext-foot' }, state, subs, h('span', { class: 'grow' }), actions);
    const root = h('article', { class: 'tile ext-tile', tabindex: '0', dataset: { ext: x.id } }, head, body, foot);
    root.addEventListener('keydown', (ev) => { if (ev.target === root && ev.key === 'Enter') { ev.preventDefault(); ctx.openActivity(x.id); } });
    const t = { root, dot, name, where, time, now, prompt, feed: feedEl, state, subs, actions, feedKey: '\0' };
    mount(actions, externalActions(ctx, x));
    return t;
  }

  /** @param {ExtTile} t @param {string} id */
  function drawFeed(t, id) {
    const lines = recentFeed(feed.entries(id), 6);
    const key = lines.map((l) => l.seq).join(',');
    if (key === t.feedKey) return;
    t.feedKey = key;
    mount(t.feed, lines.length
      ? lines.map((l) => h('li', { class: `ext-line k-${l.kind}${l.error ? ' err' : ''}${l.sub ? ' sub' : ''}`, title: l.text }, h('span', { class: 'ext-line-icon', 'aria-hidden': 'true' }, l.icon), h('span', { class: 'ext-line-text' }, l.text)))
      : h('li', { class: 'ext-line empty' }, 'No activity read yet'));
  }

  /** @param {ExtTile} t @param {any} x */
  function fill(t, x) {
    const dstate = externalDotState(x.state);
    t.root.dataset.state = x.state;
    t.root.className = `tile ext-tile st-${dstate}`;
    t.dot.className = `dot st-${dstate}`;
    t.name.textContent = x.name;
    t.name.title = `${x.name} · ${x.cwd}`;
    t.where.textContent = entrypointLabel(x.entrypoint);
    t.where.title = `${runsIn(x.entrypoint)} · ${x.cwd}`;
    t.time.textContent = timeOf(x);
    t.now.textContent = externalActivityText(x);
    t.now.className = `ext-now st-${x.state}`;
    t.now.title = t.now.textContent;
    t.prompt.textContent = x.lastPrompt ? `Last asked: ${x.lastPrompt}` : '';
    t.prompt.title = x.lastPrompt || '';
    t.state.textContent = externalStateLabel(x.state);
    const subs = ctx.subagents(x.id);
    const running = subs.length ? subs.filter((s) => s.state === 'running').length : (x.subagents ? x.subagents.running : 0);
    const total = subs.length || (x.subagents ? x.subagents.total : 0);
    t.subs.textContent = total ? `⑂ ${running ? `${running} subagent${running === 1 ? '' : 's'} running` : `${total} subagent${total === 1 ? '' : 's'}`}` : '';
    t.subs.hidden = !total;
  }

  return {
    /** @param {HTMLElement} container @param {any[]} list already sorted */
    sync(container, list) {
      const ids = new Set(list.map((x) => x.id));
      for (const [id, t] of tiles) {
        if (ids.has(id)) continue;
        t.root.remove();
        tiles.delete(id);
        sessions.delete(id);
        feed.forget(id);
      }
      for (const x of list) {
        let t = tiles.get(x.id);
        if (!t) { t = make(x); tiles.set(x.id, t); feed.ensure(x.id); }
        sessions.set(x.id, x);
        fill(t, x);
        drawFeed(t, x.id);
      }
      // After the agents' tiles (grid.js keeps those first), in order.
      const own = list.map((x) => /** @type {ExtTile} */ (tiles.get(x.id)).root);
      const first = container.children.length - own.filter((n) => n.parentElement === container).length;
      own.forEach((node, i) => { if (container.children[first + i] !== node) container.append(node); });
    },
    /** @param {string} id */
    tile(id) { return tiles.get(id) ? tiles.get(id)?.root : undefined; },
    dispose() { feed.dispose(); for (const t of tiles.values()) t.root.remove(); tiles.clear(); },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------------------------------------------

const COLLAPSE_KEY = 'cc.sidebar.outsideCollapsed';
/** @returns {Record<string, boolean>} */
function loadCollapsed() { try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') || {}; } catch { return {}; } }
/** @param {string} key @param {boolean} on */
function setCollapsed(key, on) {
  const m = loadCollapsed();
  if (on) m[key] = true; else delete m[key];
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(m)); } catch { /* storage unavailable */ }
}

/**
 * A compact view-only card.
 * @param {import('../context.js').ViewContext} ctx @param {any} x @param {{folder?: boolean}} [o] folder: show the path (Other folders)
 */
export function externalCard(ctx, x, o = {}) {
  const ds = externalDotState(x.state);
  const el = h('div', {
    class: `ext-card st-${ds}`, role: 'button', tabindex: '0', dataset: { ext: x.id, state: x.state },
    title: `${x.name} · ${runsIn(x.entrypoint)} · view only`,
    onclick: (/** @type {MouseEvent} */ ev) => { if (!(/** @type {HTMLElement} */ (ev.target)).closest('button')) ctx.openActivity(x.id); },
    onkeydown: (/** @type {KeyboardEvent} */ ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === ev.currentTarget) { ev.preventDefault(); ctx.openActivity(x.id); } },
  },
  h('span', { class: 'card-row' },
    h('span', { class: `dot st-${ds}`, 'aria-label': externalStateLabel(x.state) }),
    h('span', { class: 'agent-name' }, x.name),
    h('span', { class: 'card-time' }, timeOf(x))),
  h('span', { class: 'card-meta' },
    externalBadge(x),
    h('span', { class: 'ext-where' }, entrypointLabel(x.entrypoint)),
    x.state === 'needs_you' ? h('span', { class: 'needs-badge' }, '◆ waiting') : null),
  h('span', { class: 'card-activity', title: externalActivityText(x) }, externalActivityText(x)),
  o.folder ? h('span', { class: 'card-activity ext-path', title: x.cwd }, displayPath(x.cwd, 34)) : null,
  externalActions(ctx, x, { addSpace: !!o.folder }));
  return el;
}

/**
 * "Outside the app (N)": a collapsible list of compact cards for one space. Null when there are none.
 * @param {import('../context.js').ViewContext} ctx @param {any[]} sessions @param {string} key remembers the collapsed state
 */
export function outsideBlock(ctx, sessions, key) {
  if (!sessions.length) return null;
  const collapsed = !!loadCollapsed()[key];
  const head = h('button', {
    type: 'button', class: 'ext-block-head', 'aria-expanded': String(!collapsed), dataset: { key },
    title: 'Claude sessions of this space that run outside the app (view only)',
    onclick: () => { setCollapsed(key, !collapsed); ctx.render(); },
  },
  h('span', { class: 'ext-chev', 'aria-hidden': 'true' }, collapsed ? '▸' : '▾'),
  h('span', { class: 'ext-block-title' }, `Outside the app (${sessions.length})`));
  return h('div', { class: `ext-block${collapsed ? ' collapsed' : ''}`, dataset: { block: key } },
    head,
    collapsed ? null : h('ul', { class: 'ext-block-list' }, sessions.map((x) => h('li', null, externalCard(ctx, x), sidebarSubagents(ctx, x.id)))));
}

/**
 * "Other folders": sessions that are in no space, each with Add as space. Null when there are none.
 * @param {import('../context.js').ViewContext} ctx @param {any[]} sessions
 */
export function otherFoldersBlock(ctx, sessions) {
  if (!sessions.length) return null;
  const key = 'other-folders';
  const collapsed = !!loadCollapsed()[key];
  const head = h('button', {
    type: 'button', class: 'ext-block-head', 'aria-expanded': String(!collapsed), dataset: { key },
    title: 'Claude sessions outside the app whose folder is not a space',
    onclick: () => { setCollapsed(key, !collapsed); ctx.render(); },
  },
  h('span', { class: 'ext-chev', 'aria-hidden': 'true' }, collapsed ? '▸' : '▾'),
  h('span', { class: 'ext-block-title' }, `Other folders (${sessions.length})`));
  return h('section', { class: `sb-section sb-other ext-block${collapsed ? ' collapsed' : ''}`, dataset: { block: key } },
    head,
    collapsed ? null : h('ul', { class: 'ext-block-list' }, sessions.map((x) => h('li', null, externalCard(ctx, x, { folder: true })))));
}

// ---------------------------------------------------------------------------------------------------------------
// Board and Inbox
// ---------------------------------------------------------------------------------------------------------------

/** A board card: badge, name, folder, activity; Activity / Take over only. @param {import('../context.js').ViewContext} ctx @param {any} x */
export function externalBoardCard(ctx, x) {
  const ds = externalDotState(x.state);
  return h('div', {
    class: `ext-board-card st-${ds}`, role: 'button', tabindex: '0', dataset: { ext: x.id, state: x.state },
    title: `${x.name} · ${runsIn(x.entrypoint)} · view only`,
    onclick: (/** @type {MouseEvent} */ ev) => { if (!(/** @type {HTMLElement} */ (ev.target)).closest('button')) ctx.openActivity(x.id); },
    onkeydown: (/** @type {KeyboardEvent} */ ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === ev.currentTarget) { ev.preventDefault(); ctx.openActivity(x.id); } },
  },
  h('div', { class: 'bc-top' }, h('span', { class: `dot st-${ds}` }), h('span', { class: 'bc-name', title: x.name }, x.name), h('span', { class: 'bc-time' }, timeOf(x))),
  h('div', { class: 'bc-meta' }, externalBadge(x), h('span', { class: 'ext-where' }, entrypointLabel(x.entrypoint)), h('span', { class: 'bc-space', title: x.cwd }, folderName(x.cwd))),
  h('div', { class: 'bc-activity', title: externalActivityText(x) }, externalActivityText(x)),
  externalActions(ctx, x));
}

/** An Inbox row for an outside session that waits for you: no Allow / Deny, only Take over. @param {import('../context.js').ViewContext} ctx @param {any} x */
export function externalInboxRow(ctx, x) {
  const where = entrypointLabel(x.entrypoint);
  const waited = formatRelativeTime(x.updatedAt);
  return h('div', { class: 'inbox-row ext-inbox-row', role: 'option', 'aria-selected': 'false', dataset: { ext: x.id } },
    h('div', { class: 'inbox-main' },
      h('div', { class: 'inbox-line' },
        externalBadge(x),
        h('span', { class: 'inbox-name' }, x.name),
        h('span', { class: 'inbox-space' }, folderName(x.cwd)),
        h('span', { class: 'grow' }),
        h('span', { class: 'inbox-wait' }, waited === 'now' ? 'just now' : `waiting ${waited}`)),
      h('div', { class: 'inbox-ask' },
        h('span', { class: 'inbox-message' }, `waiting in ${where === 'Terminal' ? 'a terminal' : where}`),
        h('span', { class: 'inbox-question' }, 'Answer it there, or take it over to answer here'))),
    h('div', { class: 'inbox-actions' }, externalActions(ctx, x)));
}
