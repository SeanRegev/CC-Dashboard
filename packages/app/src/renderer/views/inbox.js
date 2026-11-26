// @ts-check
/**
 * Inbox view. Owner: the Approvals track (M2). Everything waiting on you, across every space, with Allow / Always / Deny.
 * Groundwork stub: a placeholder. Contract for views: context.js (View, ViewContext).
 */
import { h } from '../dom.js';

/** @param {import('../context.js').ViewContext} ctx @returns {import('../context.js').View} */
// eslint-disable-next-line no-unused-vars
export function createInboxView(ctx) {
  const el = h('section', { class: 'view view-inbox', dataset: { view: 'inbox' } },
    h('div', { class: 'view-placeholder' }, h('div', { class: 'empty-title' }, 'Inbox'), h('div', { class: 'empty-sub' }, 'Coming in this milestone.')));
  return { el, update() {} };
}
