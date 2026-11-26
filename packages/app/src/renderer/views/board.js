// @ts-check
/**
 * Board view. Owner: the Layouts track (M2). Agents as cards in columns: Needs you, Working, Done, Stopped.
 * Groundwork stub: a placeholder. Contract for views: context.js (View, ViewContext).
 */
import { h } from '../dom.js';

/** @param {import('../context.js').ViewContext} ctx @returns {import('../context.js').View} */
// eslint-disable-next-line no-unused-vars
export function createBoardView(ctx) {
  const el = h('section', { class: 'view view-board', dataset: { view: 'board' } },
    h('div', { class: 'view-placeholder' }, h('div', { class: 'empty-title' }, 'Board'), h('div', { class: 'empty-sub' }, 'Coming in this milestone.')));
  return { el, update() {} };
}
