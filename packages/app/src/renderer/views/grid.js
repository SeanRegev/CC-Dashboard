// @ts-check
/**
 * Grid view. Owner: the Layouts track (M2). Every agent of the selected space as live terminals, two per row, four on screen, scroll for more.
 * Groundwork stub: a placeholder. Contract for views: context.js (View, ViewContext).
 */
import { h } from '../dom.js';

/** @param {import('../context.js').ViewContext} ctx @returns {import('../context.js').View} */
// eslint-disable-next-line no-unused-vars
export function createGridView(ctx) {
  const el = h('section', { class: 'view view-grid', dataset: { view: 'grid' } },
    h('div', { class: 'view-placeholder' }, h('div', { class: 'empty-title' }, 'Grid'), h('div', { class: 'empty-sub' }, 'Coming in this milestone.')));
  return { el, update() {} };
}
