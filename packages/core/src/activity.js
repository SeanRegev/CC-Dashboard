// @ts-check
'use strict';
/**
 * Subagents and the activity log of the sessions CC-Dashboard started (contract v3). Owner: the
 * Subagents track (docs/M3.md). Everything here comes from hook events: no model call, no tokens.
 *
 * Groundwork stub: the methods exist so the server can route them; the track fills them in.
 */
const { ERRORS } = require('../../shared/protocol');

class Activity {
  /** @param {import('./core').Core} core */
  constructor(core) {
    this.core = core;
  }

  /** Called from Core.start() after the state is loaded. */
  start() {}

  /** Called from Core.shutdown(). */
  shutdown() {}

  /**
   * Every hook event of an agent, before Core applies it to the agent's status.
   * @param {string} agentId @param {string} event @param {any} payload
   */
  onHook(agentId, event, payload) { void agentId; void event; void payload; }

  /** The agent was removed: drop its log. @param {string} agentId */
  onRemove(agentId) { void agentId; }

  /** @param {{agentId: string}} p @returns {import('./types').Subagent[]} */
  subagentsList(p) { void p; return []; }

  /** @param {{agentId: string, subagentId?: string, before?: number, limit?: number}} p */
  list(p) { void p; return { entries: [], more: false }; }
}

module.exports = { Activity, ERRORS };
