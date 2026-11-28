// @ts-check
'use strict';
/**
 * Status line (contract v4). Claude Code pipes a JSON snapshot to the statusLine command on every update; the
 * relay forwards it to POST /statusline?agent=<id> and core.handleStatusLine() hands it here.
 * From it: AgentStatus.usage (exact context window and %, cost) and the account Usage (rate limits, cost and token
 * totals per agent / space / day, daily totals saved in <CC_HOME>/usage.json).
 *
 * Owner: track A (M4). Wave 0 stub: accepts updates, answers usage.get with an empty Usage.
 * Fixtures: tests/fixtures/statusline/{startup,sample}.json.
 */

/** @typedef {import('./types').Usage} Usage */

/** @returns {Usage} */
function emptyUsage() {
  return { limits: { updatedAt: 0 }, byAgent: {}, bySpace: {}, byDay: {}, updatedAt: 0 };
}

class StatusLine {
  /** @param {import('./core').Core} core */
  constructor(core) {
    this.core = core;
    /** @type {Usage} */
    this.usage = emptyUsage();
  }

  /** Load <CC_HOME>/usage.json (track A). */
  start() {}

  /** Flush what is pending (track A). */
  shutdown() {}

  /**
   * One status-line update from an agent the core knows.
   * @param {string} agentId @param {any} payload
   */
  handle(agentId, payload) { void agentId; void payload; }

  /** usage.get @param {any} [params] @returns {Usage} */
  usageGet(params) { void params; return this.usage; }

  /** agents.remove: keep its totals (byAgent keeps the name), drop live state. @param {string} agentId */
  onRemove(agentId) { void agentId; }
}

module.exports = { StatusLine, emptyUsage };
