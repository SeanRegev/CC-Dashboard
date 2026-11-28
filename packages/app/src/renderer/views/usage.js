// @ts-check
/**
 * Usage view (Ctrl+Shift+U, contract v4). Owner: track B (M4).
 * Cost and tokens per agent, per space and per day from ctx.usage(), labelled "API-equivalent estimate".
 * Contract for views: context.js (View, ViewContext).
 */
import { h, mount } from '../dom.js';
import { formatTokens } from '../logic.js';
import { formatCost, totalsRows, maxCost, dayLabel } from '../components/usage-logic.js';

/**
 * @param {string} title
 * @param {string} id
 * @param {ReturnType<typeof totalsRows>} rows
 * @param {(r:any)=>string|null} [sub]
 */
function table(title, id, rows, sub) {
  const max = maxCost(rows);
  return h('section', { class: 'usage-block', dataset: { block: id } },
    h('h3', null, title),
    rows.length
      ? h('table', { class: 'usage-table' },
        h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', { class: 'num' }, 'Cost'), h('th', { class: 'bar-col' }), h('th', { class: 'num' }, 'Input'), h('th', { class: 'num' }, 'Output'))),
        h('tbody', null, ...rows.map((r) => h('tr', { dataset: { key: r.key } },
          h('td', { class: 'name', title: r.label }, r.label, sub && sub(r) ? h('span', { class: 'usage-sub' }, sub(r)) : null),
          h('td', { class: 'num cost' }, formatCost(r.costUsd)),
          h('td', { class: 'bar-col' }, h('span', { class: 'usage-bar' }, h('span', { class: 'usage-bar-fill', style: { width: `${max ? Math.round((r.costUsd / max) * 100) : 0}%` } }))),
          h('td', { class: 'num' }, formatTokens(r.inputTokens)),
          h('td', { class: 'num' }, formatTokens(r.outputTokens))))))
      : h('p', { class: 'muted' }, 'Nothing yet.'));
}

/** @param {import('../context.js').ViewContext} ctx @returns {import('../context.js').View} */
export function createUsageView(ctx) {
  const el = h('section', { class: 'usage-view', 'aria-label': 'Usage' });
  return {
    el,
    update() {
      const u = ctx.usage();
      const head = h('div', { class: 'usage-head' },
        h('h2', null, 'Usage'),
        h('span', { class: 'usage-note', title: 'On a subscription these amounts are not a bill: they are what the same tokens would cost at API prices.' }, 'API-equivalent estimate'));
      if (!u) { mount(el, head, h('p', { class: 'muted usage-loading' }, 'Loading…')); return; }
      const agents = totalsRows(u.byAgent, { label: (k, t) => t.name || k });
      const spaces = totalsRows(u.bySpace, { label: (k) => ctx.spaceName(k) || k });
      const days = totalsRows(u.byDay, { byKey: true, label: (k) => dayLabel(k) });
      if (!agents.length && !spaces.length && !days.length) {
        mount(el, head, h('p', { class: 'muted usage-empty' }, 'No usage recorded yet. Totals appear once an agent has replied.'));
        return;
      }
      const live = ctx.state().entries;
      const total = agents.reduce((s, r) => s + r.costUsd, 0);
      mount(el, head,
        h('p', { class: 'usage-total' }, 'Total ', h('strong', null, formatCost(total)), ' across ', String(agents.length), agents.length === 1 ? ' agent' : ' agents'),
        table('Per agent', 'agents', agents, (r) => (live.has(r.key) ? null : 'removed')),
        table('Per space', 'spaces', spaces),
        table('Per day', 'days', days));
    },
  };
}
