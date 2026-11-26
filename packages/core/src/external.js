// @ts-check
'use strict';
/**
 * Claude Code sessions running on this computer that CC-Dashboard did not start (contract v3).
 * Owner: the Outside sessions track (docs/M3.md). Read from Claude's running-session files and
 * transcripts: no model call, no tokens. external.takeOver moves one into the app.
 *
 * Groundwork stub: the methods exist so the server can route them; the track fills them in.
 */
const { ERRORS } = require('../../shared/protocol');
const { RpcError } = require('./errors');

class External {
  /** @param {import('./core').Core} core */
  constructor(core) {
    this.core = core;
  }

  /** Called from Core.start(). */
  start() {}

  /** Called from Core.shutdown(). */
  shutdown() {}

  /** @returns {any[]} ExternalSession[] */
  list() { return []; }

  /** @param {{agentId: string}} p */
  subagentsList(p) { void p; return []; }

  /** @param {{agentId: string, subagentId?: string, before?: number, limit?: number}} p */
  activityList(p) { void p; return { entries: [], more: false }; }

  /** @param {{id: string, spaceId?: string, name?: string, force?: boolean}} p */
  takeOver(p) { void p; throw new RpcError(ERRORS.NOT_IMPLEMENTED, 'external.takeOver is not implemented yet'); }
}

module.exports = { External };
