// @ts-check
/**
 * Usage view (Ctrl+Shift+U, contract v4). Owner: track B (M4).
 * Cost and tokens per agent, per space and per day from ctx.usage(), labelled "API-equivalent estimate".
 * Contract for views: context.js (View, ViewContext). Wave 0 stub.
 */
import { h, mount } from '../dom.js';

/** @param {import('../context.js').ViewContext} ctx @returns {import('../context.js').View} */
export function createUsageView(ctx) {
  const el = h('section', { class: 'usage-view', 'aria-label': 'Usage' });
  return {
    el,
    update() {
      const u = ctx.usage();
      mount(el, h('h2', null, 'Usage'), h('p', { class: 'muted' }, u ? 'API-equivalent estimate' : 'Loading…'));
    },
  };
}
