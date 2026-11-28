// @ts-check
/**
 * Subagent cards (M4). Owner: track C.
 *
 *   sidebarSubagents(ctx, agentId)   child cards indented under a session in the sidebar (collapsible; finished
 *                                    ones fold into "✓ N done")
 *   gridSubagentRow(ctx, agentId)    a row of cards under a grid tile
 *   paneSubagentBar(ctx, agentId)    a bar under a Terminals pane header
 * Each returns null when the session has no subagents. A click opens ctx.openActivity(agentId, subagentId).
 * Data: ctx.subagents(agentId) → Subagent[] (protocol.js; v4 adds model).
 * Wave 0 stubs: nothing is shown yet.
 */

/** @param {import('../context.js').ViewContext} ctx @param {string} agentId @returns {HTMLElement|null} */
export function sidebarSubagents(ctx, agentId) { void ctx; void agentId; return null; }

/** @param {import('../context.js').ViewContext} ctx @param {string} agentId @returns {HTMLElement|null} */
export function gridSubagentRow(ctx, agentId) { void ctx; void agentId; return null; }

/** @param {import('../context.js').ViewContext} ctx @param {string} agentId @returns {HTMLElement|null} */
export function paneSubagentBar(ctx, agentId) { void ctx; void agentId; return null; }
