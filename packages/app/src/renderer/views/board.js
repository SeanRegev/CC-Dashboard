// @ts-check
/**
 * Board view. Owner: the Layouts track (M2). Agents as cards in columns: Needs you, Working (incl.
 * starting), Done, Stopped (incl. exited). Filter: all spaces / the current space.
 */
import { h, mount } from '../dom.js';
import { boardColumns, BOARD_COLUMNS, describeActivity, cardTime, contextPercent, gaugeLevel } from '../logic.js';
import { roleBadge } from '../roles.js';
import { approvalButtons } from '../components/approval.js';
import { attachAgentMenu } from '../components/agent-menu.js';

const FILTER_KEY = 'cc.board.filter';
/** @returns {'all'|'space'} */
function loadFilter() { try { return localStorage.getItem(FILTER_KEY) === 'space' ? 'space' : 'all'; } catch { return 'all'; } }

/** @param {import('../context.js').ViewContext} ctx @returns {import('../context.js').View} */
export function createBoardView(ctx) {
  let filter = loadFilter();
  const bar = h('div', { class: 'board-bar' });
  const cols = h('div', { class: 'board-cols' });
  const el = h('section', { class: 'view view-board', dataset: { view: 'board' } }, bar, cols);

  /** @param {'all'|'space'} f */
  function setFilter(f) {
    filter = f;
    try { localStorage.setItem(FILTER_KEY, f); } catch { /* storage unavailable */ }
    update();
  }

  /** @param {{agent:any, status:any, running:boolean}} e */
  function card(e) {
    const st = e.status ? e.status.state : 'stopped';
    const id = e.agent.id;
    const pct = contextPercent(e.status && e.status.usage);
    const node = h('div', {
      class: `board-card st-${st}`, role: 'button', tabindex: '0', dataset: { agent: id, state: st },
      onclick: (/** @type {MouseEvent} */ ev) => { if (!(/** @type {HTMLElement} */ (ev.target)).closest('button')) ctx.openAgent(id); },
      onkeydown: (/** @type {KeyboardEvent} */ ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === ev.currentTarget) { ev.preventDefault(); ctx.openAgent(id); } },
    },
    h('div', { class: 'bc-top' }, h('span', { class: `dot st-${st}` }), h('span', { class: 'bc-name', title: e.agent.name }, e.agent.name), h('span', { class: 'bc-time' }, cardTime(e.status))),
    h('div', { class: 'bc-meta' }, roleBadge(e.agent), h('span', { class: 'bc-space' }, ctx.spaceName(e.agent.spaceId))),
    h('div', { class: 'bc-activity', title: describeActivity(e.status) }, describeActivity(e.status)),
    h('div', { class: 'bc-foot' },
      h('span', { class: 'bc-ctx', title: `Context window ${pct}% full` }, h('span', { class: `gauge-bar lvl-${gaugeLevel(pct)}` }, h('span', { class: 'gauge-fill', style: { width: `${pct}%` } })), h('span', { class: 'gauge-pct' }, `${pct}%`))),
    approvalButtons(ctx, e));
    attachAgentMenu(node, ctx, id);
    return node;
  }

  function update() {
    const S = ctx.state();
    const space = S.spaces.find((/** @type {any} */ s) => s.id === S.currentSpace);
    const entries = [...S.entries.values()].filter((e) => filter === 'all' || e.agent.spaceId === S.currentSpace);
    const by = boardColumns(entries);
    mount(bar,
      h('span', { class: 'board-title' }, 'Board'),
      h('div', { class: 'seg-mini board-filter', role: 'group', 'aria-label': 'Which agents' },
        h('button', { class: filter === 'all' ? 'on' : '', type: 'button', id: 'board-all', 'aria-pressed': String(filter === 'all'), onclick: () => setFilter('all') }, 'All spaces'),
        h('button', { class: filter === 'space' ? 'on' : '', type: 'button', id: 'board-space', 'aria-pressed': String(filter === 'space'), title: space ? space.name : '', onclick: () => setFilter('space') }, space ? space.name : 'Current space')),
      h('span', { class: 'board-count' }, `${entries.length} agent${entries.length === 1 ? '' : 's'}`));
    mount(cols, ...BOARD_COLUMNS.map((c) => h('section', { class: `board-col col-${c.id}`, dataset: { col: c.id } },
      h('header', { class: 'board-col-head' }, h('span', { class: 'bch-label' }, c.label), h('span', { class: 'bch-count' }, String(by[c.id].length))),
      h('div', { class: 'board-col-body' },
        by[c.id].length ? by[c.id].map(card) : h('div', { class: 'board-col-empty' }, 'Nothing here')))));
  }

  return { el, update, show: update };
}
