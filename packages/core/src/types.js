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
 * @property {AgentUsage} usage
 * @property {Array<[number,string]>} history
 * @property {number} updatedAt
 * @property {number} [needsSince]
 * @property {{running: number, total: number}} [subagents]  (v3)
 * @property {string} [askedBy]     (v3) Subagent id the permission prompt is for
 *
 * @typedef {Object} AgentUsage     see protocol.js (v4 adds contextWindow, costUsd, source)
 * @property {number} total
 * @property {number} context
 * @property {number} contextPct
 * @property {string} model
 * @property {number} [contextWindow]
 * @property {number} [costUsd]
 * @property {'statusline'|'transcript'} [source]
 *
 * @typedef {Object} UsageLimit     (v4) see protocol.js
 * @property {number} usedPct
 * @property {number} resetsAt      ms epoch
 *
 * @typedef {Object} UsageTotals    (v4) see protocol.js
 * @property {number} costUsd
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {string} [name]
 * @property {string} [spaceId]
 *
 * @typedef {Object} Usage          (v4) see protocol.js
 * @property {{fiveHour?: UsageLimit, sevenDay?: UsageLimit, updatedAt: number, fromAgentId?: string}} limits
 * @property {Record<string, UsageTotals>} byAgent
 * @property {Record<string, UsageTotals>} bySpace
 * @property {Record<string, UsageTotals>} byDay
 * @property {number} updatedAt
 *
 * @typedef {Object} Subagent       (v3) see protocol.js
 * @property {string} id
 * @property {string} agentId
 * @property {string} title
 * @property {string} type
 * @property {'running'|'done'|'failed'|'stopped'} state
 * @property {string} [model]       (v4)
 * @property {boolean} background
 * @property {string} [tool]
 * @property {string} [detail]
 * @property {boolean} [needsYou]
 * @property {{tools: number, errors: number}} counts
 * @property {string} [summary]
 * @property {number} startedAt
 * @property {number} [endedAt]
 * @property {number} updatedAt
 *
 * @typedef {Object} ActivityEntry  (v3) see protocol.js
 * @property {number} seq
 * @property {number} at
 * @property {string} subagentId
 * @property {string} kind
 * @property {string} [tool]
 * @property {string} [detail]
 * @property {number} [ms]
 * @property {string} [text]
 * @property {string} [type]
 *
 * @typedef {Object} Runtime        Internal per-agent bookkeeping (persisted, never sent to the app).
 * @property {number} permAt        when the last PermissionRequest arrived
 * @property {number} answeredAt    when a prompt was last answered (PostToolUse, approve, deny, ...)
 * @property {number} turnStartedAt when the current turn's UserPromptSubmit arrived
 * @property {number} [doneFrom]   (v3) start of a turn whose "done" notification waits for its background subagents
 * @property {string} transcriptPath Claude's session JSONL, from hook payloads
 * @property {number} launchAt      when the process was last spawned
 * @property {boolean} hookSinceLaunch any hook received since the last spawn
 * @property {boolean} [stuck]      shown as needs_you because no hook came after launch
 */
module.exports = {};
