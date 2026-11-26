// @ts-check
/**
 * Library view. Owner: the Library track (M2). Your plugins and skills: install, update, turn on/off, configure, uninstall; create, edit, delete skills.
 * Groundwork stub: a placeholder. Contract for views: context.js (View, ViewContext).
 */
import { h } from '../dom.js';

/** @param {import('../context.js').ViewContext} ctx @returns {import('../context.js').View} */
// eslint-disable-next-line no-unused-vars
export function createLibraryView(ctx) {
  const el = h('section', { class: 'view view-library', dataset: { view: 'library' } },
    h('div', { class: 'view-placeholder' }, h('div', { class: 'empty-title' }, 'Library'), h('div', { class: 'empty-sub' }, 'Coming in this milestone.')));
  return { el, update() {} };
}
