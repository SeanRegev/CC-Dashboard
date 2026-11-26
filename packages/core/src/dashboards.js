// @ts-check
'use strict';
/**
 * Dashboards: tools with a dashboard the app can open (protocol `dashboards.*`).
 * Owner: the Dashboards track (M2). Groundwork stub: every method answers not_implemented.
 *
 * Contract: packages/shared/protocol.js (Dashboard and the dashboards.* methods). Terminal dashboards run
 * in a PTY like agents (see terminal.js AgentTerminal); emit their output with
 *   this.core.emit('dashboard-output', id, data)
 * and the server forwards it as `dashboard.output` to clients that called dashboards.attach (already wired).
 * Emit `dashboard.exit` / `dashboards.changed` with this.core.broadcast(event, data).
 */
const { ERRORS } = require('../../shared/protocol');

class Dashboards {
  /** @param {import('./core').Core} core */
  constructor(core) {
    this.core = core;
  }

  /** @param {string} method */
  todo(method) {
    const { RpcError } = require('./core');
    throw new RpcError(ERRORS.NOT_IMPLEMENTED, `${method} is not implemented yet`);
  }

  list(_params) { return this.todo('dashboards.list'); }
  add(_params) { return this.todo('dashboards.add'); }
  remove(_params) { return this.todo('dashboards.remove'); }
  trust(_params) { return this.todo('dashboards.trust'); }
  start(_params) { return this.todo('dashboards.start'); }
  stop(_params) { return this.todo('dashboards.stop'); }
  /** @returns {{replay: string}} */
  attach(_params) { return /** @type {any} */ (this.todo('dashboards.attach')); }
  input(_params) { return this.todo('dashboards.input'); }
  resize(_params) { return this.todo('dashboards.resize'); }
  /** Called by core.shutdown(): stop every running dashboard process. */
  shutdown() {}
}

module.exports = { Dashboards };
