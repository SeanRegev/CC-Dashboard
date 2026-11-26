// @ts-check
'use strict';
/**
 * Shared JSDoc types for the core. The public shapes live in packages/shared/protocol.js.
 *
 * @typedef {Object} AgentStatus
 * @property {string} agentId
 * @property {'needs_you'|'working'|'starting'|'idle'|'stopped'|'exited'} state
 * @property {string} [tool]
 * @property {string} [detail]
 * @property {string} [message]
 * @property {boolean} [permission]
 * @property {import('./prompt').PermissionPrompt} [prompt]  read off the screen (prompt.js)
 * @property {string} [lastPrompt]
 * @property {{tools:number, turns:number, errors:number, subagents:number}} counts
 * @property {string[]} files
 * @property {{total:number, context:number, contextPct:number, model:string}} usage
 * @property {Array<[number,string]>} history
 * @property {number} updatedAt
 * @property {number} [needsSince]
 *
 * @typedef {Object} Runtime        Internal per-agent bookkeeping (persisted, never sent to the app).
 * @property {number} permAt        when the last PermissionRequest arrived
 * @property {number} answeredAt    when a prompt was last answered (PostToolUse, approve, deny, ...)
 * @property {number} turnStartedAt when the current turn's UserPromptSubmit arrived
 * @property {string} transcriptPath Claude's session JSONL, from hook payloads
 * @property {number} launchAt      when the process was last spawned
 * @property {boolean} hookSinceLaunch any hook received since the last spawn
 * @property {boolean} [stuck]      shown as needs_you because no hook came after launch
 */
module.exports = {};
