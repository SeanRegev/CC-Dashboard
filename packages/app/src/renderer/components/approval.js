// @ts-check
/**
 * Allow / Always / Deny for an agent waiting on a permission prompt (status.prompt, protocol v2).
 * Owner: the Approvals track (M2). Already placed by the groundwork on: sidebar agent cards,
 * the pane header, and (Layouts) grid tiles and board cards. Groundwork stub: shows nothing.
 *
 * Rules for the implementation (see protocol.js agents.approve):
 *  - send promptId = status.prompt.id and choice by kind ('allow' | 'allow_always'); never a raw key;
 *  - on prompt_changed, tell the user the prompt changed and let the new one render;
 *  - no status.prompt (unreadable prompt): offer "Open terminal" instead of guessing.
 */

/**
 * @param {import('../context.js').ViewContext} ctx
 * @param {{agent:any, status:any, running:boolean}} entry
 * @param {{compact?: boolean}} [opts]
 * @returns {HTMLElement|null}
 */
// eslint-disable-next-line no-unused-vars
export function approvalButtons(ctx, entry, opts = {}) {
  return null;
}
