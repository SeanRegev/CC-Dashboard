// @ts-check
/**
 * Dashboards view. Owner: the Dashboards track (M2). Dashboards from your tools and plugins (CodeBurn and more), and your own.
 * Groundwork stub: a placeholder. Contract for views: context.js (View, ViewContext).
 */
import { h } from '../dom.js';

/** @param {import('../context.js').ViewContext} ctx @returns {import('../context.js').View} */
// eslint-disable-next-line no-unused-vars
export function createDashboardsView(ctx) {
  const el = h('section', { class: 'view view-dashboards', dataset: { view: 'dashboards' } },
    h('div', { class: 'view-placeholder' }, h('div', { class: 'empty-title' }, 'Dashboards'), h('div', { class: 'empty-sub' }, 'Coming in this milestone.')));
  return { el, update() {} };
}
