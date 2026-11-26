// @ts-check
'use strict';
/**
 * Library: the user's Claude Code plugins, skills and marketplaces (protocol `library.*`).
 * Owner: the Library track (M2). Groundwork stub: every method answers not_implemented.
 *
 * Contract: packages/shared/protocol.js (LibraryPlugin, LibrarySkill, Library and the library.* methods).
 * Runs `claude plugin ...` with the same claude the agents use (see command.js baseCommand / spawnSpec),
 * reads SKILL.md files from ~/.claude/skills, <space>/.claude/skills and each plugin's skills/ folder,
 * and emits 'library.changed' through core.broadcast after a rescan or an action.
 */
const { ERRORS } = require('../../shared/protocol');

class Library {
  /** @param {import('./core').Core} core */
  constructor(core) {
    this.core = core;
  }

  /** @param {string} method */
  todo(method) {
    const { RpcError } = require('./core');
    throw new RpcError(ERRORS.NOT_IMPLEMENTED, `${method} is not implemented yet`);
  }

  list(_params) { return this.todo('library.list'); }
  available(_params) { return this.todo('library.available'); }
  pluginAction(_params) { return this.todo('library.pluginAction'); }
  configure(_params) { return this.todo('library.configure'); }
  marketplace(_params) { return this.todo('library.marketplace'); }
  skillRead(_params) { return this.todo('library.skillRead'); }
  skillWrite(_params) { return this.todo('library.skillWrite'); }
}

module.exports = { Library };
