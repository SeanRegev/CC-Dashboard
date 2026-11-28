// @ts-check
/**
 * Subagent cards (M4). Owner: track C. Pure helpers: subagent-cards-logic.js.
 *
 *   sidebarSubagents(ctx, agentId)   child cards indented under a session in the sidebar (collapsible per session,
 *                                    remembered per window; finished ones fold into "✓ N done")
 *   gridSubagentRow(ctx, agentId)    a row of cards under a grid tile (renderGridSubagents keeps it cheap)
 *   paneSubagentBar(ctx, agentId)    a bar under a Terminals pane header
 * Each returns null when the session has no subagents. A click opens ctx.openActivity(agentId, subagentId).
 * Data: ctx.subagents(agentId) → Subagent[] (protocol.js; v4 adds model).
 */
import { h, mount } from '../dom.js';
import { typeInfo, subagentTitle, stateInfo } from './activity-logic.js';
import { splitSubagents, subModelLabel, subDoing, subElapsed, cardLabel, cardsKey, summaryLine } from './subagent-cards-logic.js';

const COLLAPSE_KEY = 'cc.sidebar.subagentsCollapsed';
const DONE_OPEN_KEY = 'cc.sidebar.subagentsDoneOpen';

/** @param {string} key @returns {Record<string, boolean>} */
function loadMap(key) { try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { return {}; } }
/** @param {string} key @param {string} id @param {boolean} on */
function setFlag(key, id, on) {
  const m = loadMap(key);
  if (on) m[id] = true; else delete m[id];
  try { localStorage.setItem(key, JSON.stringify(m)); } catch { /* storage unavailable */ }
}

/** Running cards show their elapsed time ticking; one timer for every card in the window. @type {ReturnType<typeof setInterval>|null} */
let ticker = null;
function ensureTicker() {
  if (ticker || typeof document === 'undefined') return;
  ticker = setInterval(() => {
    const now = Date.now();
    for (const n of document.querySelectorAll('.sub-card-time[data-since]')) {
      const since = Number(/** @type {HTMLElement} */ (n).dataset.since);
      if (since) n.textContent = subElapsed({ state: 'running', startedAt: since }, now);
    }
  }, 1000);
}

/**
 * One card: state, type emoji, title, model, current tool (or "needs you") and elapsed time. A real button.
 * @param {import('../context.js').ViewContext} ctx @param {string} agentId @param {any} s
 */
function card(ctx, agentId, s) {
  const info = typeInfo(s.type);
  const st = stateInfo(s.state);
  const model = subModelLabel(s);
  const doing = subDoing(s);
  const time = subElapsed(s);
  ensureTicker();
  return h('button', {
    class: `sub-card st-${s.state}${s.needsYou ? ' needs' : ''}`, type: 'button', dataset: { sub: s.id, state: s.state },
    'aria-label': cardLabel(s), title: `${info.label}: ${subagentTitle(s)}${s.summary ? `\n${s.summary}` : ''}`,
    onclick: (/** @type {Event} */ ev) => { ev.stopPropagation(); ctx.openActivity(agentId, s.id); },
  },
  h('span', { class: 'sub-card-top' },
    h('span', { class: `sub-card-state st-${s.state}`, 'aria-hidden': 'true', title: st.label }, s.state === 'running' ? h('span', { class: 'act-spin' }) : st.glyph),
    h('span', { class: 'sub-card-emoji', 'aria-hidden': 'true' }, info.emoji),
    h('span', { class: 'sub-card-title' }, subagentTitle(s))),
  h('span', { class: 'sub-card-meta' },
    model ? h('span', { class: 'sub-card-model' }, model) : null,
    doing ? h('span', { class: `sub-card-tool${s.needsYou ? ' is-needs' : ''}` }, s.needsYou ? '◆ needs you' : doing) : null,
    time ? h('span', { class: 'sub-card-time', dataset: s.state === 'running' && s.startedAt ? { since: String(s.startedAt) } : {} }, time) : null));
}

/** @param {import('../context.js').ViewContext} ctx @param {string} agentId @returns {HTMLElement|null} */
export function sidebarSubagents(ctx, agentId) {
  const subs = ctx.subagents(agentId);
  if (!subs.length) return null;
  const { active, failed, done } = splitSubagents(subs);
  const collapsed = !!loadMap(COLLAPSE_KEY)[agentId];
  const doneOpen = !!loadMap(DONE_OPEN_KEY)[agentId];
  const needs = active.some((s) => s.needsYou);
  const head = h('button', {
    type: 'button', class: `sub-group-head${needs ? ' needs' : ''}`, 'aria-expanded': String(!collapsed), dataset: { agent: agentId },
    title: collapsed ? 'Show the subagents' : 'Hide the subagents',
    onclick: (/** @type {Event} */ ev) => { ev.stopPropagation(); setFlag(COLLAPSE_KEY, agentId, !collapsed); ctx.render(); },
  },
  h('span', { class: 'sub-chev', 'aria-hidden': 'true' }, collapsed ? '▸' : '▾'),
  h('span', { class: 'sub-group-title' }, `Subagents (${subs.length})`),
  h('span', { class: 'sub-group-sum' }, summaryLine(subs)));
  /** @param {any} s */
  const li = (s) => h('li', null, card(ctx, agentId, s));
  const doneToggle = done.length ? h('li', null, h('button', {
    type: 'button', class: 'sub-done-toggle', 'aria-expanded': String(doneOpen), dataset: { done: agentId },
    onclick: (/** @type {Event} */ ev) => { ev.stopPropagation(); setFlag(DONE_OPEN_KEY, agentId, !doneOpen); ctx.render(); },
  }, `${doneOpen ? '▾' : '▸'} ✓ ${done.length} done`)) : null;
  return h('div', { class: `sub-group${collapsed ? ' collapsed' : ''}`, dataset: { agent: agentId } },
    head,
    collapsed ? null : h('ul', { class: 'sub-list' }, active.map(li), failed.map(li), doneToggle, doneOpen ? done.map(li) : null));
}

/**
 * The cards of a row: running and failed ones, then a "✓ N done" pill (opens the log).
 * @param {import('../context.js').ViewContext} ctx @param {string} agentId @param {string} cls
 * @returns {HTMLElement|null}
 */
function row(ctx, agentId, cls) {
  const subs = ctx.subagents(agentId);
  if (!subs.length) return null;
  const { active, failed, done } = splitSubagents(subs);
  return h('div', { class: `sub-row ${cls}`, role: 'group', 'aria-label': `Subagents: ${summaryLine(subs)}` },
    ...active.map((s) => card(ctx, agentId, s)),
    ...failed.map((s) => card(ctx, agentId, s)),
    done.length ? h('button', {
      class: 'sub-pill done', type: 'button', title: `${done.length} finished: open the activity log`, 'aria-label': `${done.length} subagents done: open the activity log`,
      onclick: (/** @type {Event} */ ev) => { ev.stopPropagation(); ctx.openActivity(agentId); },
    }, `✓ ${done.length} done`) : null);
}

/** @param {import('../context.js').ViewContext} ctx @param {string} agentId @returns {HTMLElement|null} */
export function gridSubagentRow(ctx, agentId) { return row(ctx, agentId, 'in-grid'); }

/** @param {import('../context.js').ViewContext} ctx @param {string} agentId @returns {HTMLElement|null} */
export function paneSubagentBar(ctx, agentId) { return row(ctx, agentId, 'in-pane'); }

/**
 * Fill a grid tile's slot (the strip under the header). Rebuilds only when the cards would look different.
 * @param {import('../context.js').ViewContext} ctx @param {HTMLElement} slot @param {string} agentId
 */
export function renderGridSubagents(ctx, slot, agentId) {
  const key = cardsKey(ctx.subagents(agentId));
  if (slot.dataset.key === key) return;
  slot.dataset.key = key;
  const el = gridSubagentRow(ctx, agentId);
  slot.hidden = !el;
  mount(slot, el);
}
