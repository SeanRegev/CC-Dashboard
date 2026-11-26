// @ts-check
'use strict';
/**
 * Mock `library.*` for the dev mock core (screenshots, e2e). Owner: the Library track (M2).
 * Groundwork: plausible, static data shaped like protocol.js Library; actions update it in memory.
 */
const path = require('path');
const os = require('os');

/** @param {{broadcast:(e:string,d:any)=>void, fail:(c:string,m:string)=>Error, ERRORS:any, home:string}} ctx */
function libraryMethods(ctx) {
  const claude = path.join(os.homedir(), '.claude');
  const plug = (/** @type {string} */ name) => path.join(claude, 'plugins', 'cache', 'claude-plugins-official', name);
  /** @type {any} */
  const lib = {
    plugins: [
      { id: 'engineering@claude-plugins-official', name: 'engineering', version: '1.2.0', scope: 'user', enabled: true, installPath: plug('engineering'), description: 'Standups, code review, architecture decisions, incident response and docs.', author: 'Anthropic', marketplace: 'claude-plugins-official', managed: false, components: { skills: ['code-review', 'debug', 'standup', 'system-design'], agents: [], commands: [], hooks: 0, mcpServers: ['github', 'linear'] }, tokens: { alwaysOn: 873 }, hasConfig: false, updateAvailable: true, dashboards: [] },
      { id: 'codeburn@getagentseal', name: 'codeburn', version: '0.9.4', scope: 'user', enabled: true, installPath: plug('codeburn'), description: 'See where your Claude Code tokens and money go.', author: 'AgentSeal', homepage: 'https://github.com/getagentseal/codeburn', marketplace: 'getagentseal', managed: false, components: { skills: [], agents: [], commands: ['cost'], hooks: 0, mcpServers: [] }, tokens: { alwaysOn: 40 }, hasConfig: false, updateAvailable: false, dashboards: ['codeburn-terminal', 'codeburn-web'] },
      { id: 'security-guidance@synced', name: 'security-guidance', version: '2.0.20', scope: 'synced', enabled: true, installPath: plug('security-guidance'), description: 'Warns about risky patterns while editing.', author: 'Anthropic', managed: true, components: { skills: [], agents: [], commands: [], hooks: 2, mcpServers: [] }, tokens: { alwaysOn: 0 }, hasConfig: false, dashboards: [] },
      { id: 'figma@claude-plugins-official', name: 'figma', version: '2.2.211', scope: 'user', enabled: false, installPath: plug('figma'), description: 'Design to code with Figma.', author: 'Figma', homepage: 'https://www.figma.com', marketplace: 'claude-plugins-official', managed: false, components: { skills: ['figma-use', 'figma-design-to-code'], agents: [], commands: [], hooks: 0, mcpServers: ['figma'] }, tokens: { alwaysOn: 610 }, hasConfig: true, dashboards: [] },
    ],
    skills: [
      { id: 'user:session-start-hook', name: 'session-start-hook', description: 'Creating and developing startup hooks for Claude Code cloud sessions.', source: 'user', path: path.join(claude, 'skills', 'session-start-hook', 'SKILL.md'), deletable: true },
      { id: 'project:cc-dashboard:release', name: 'release', description: 'Cut a CC-Dashboard release: bump, tag, publish.', source: 'project', spaceId: 'cc-dashboard', path: path.join(os.homedir(), 'code', 'cc-dashboard', '.claude', 'skills', 'release', 'SKILL.md'), deletable: true },
      { id: 'plugin:engineering@claude-plugins-official:code-review', name: 'code-review', description: 'Review code changes for security, performance, and correctness.', source: 'plugin', pluginId: 'engineering@claude-plugins-official', path: path.join(plug('engineering'), 'skills', 'code-review', 'SKILL.md'), deletable: false },
      { id: 'plugin:engineering@claude-plugins-official:debug', name: 'debug', description: 'Structured debugging session: reproduce, isolate, diagnose, fix.', source: 'plugin', pluginId: 'engineering@claude-plugins-official', path: path.join(plug('engineering'), 'skills', 'debug', 'SKILL.md'), deletable: false },
    ],
    marketplaces: [
      { name: 'claude-plugins-official', source: 'github:anthropics/claude-plugins-official', lastUpdated: '2026-11-24T19:41:58.818Z' },
      { name: 'getagentseal', source: 'github:getagentseal/codeburn' },
    ],
    scannedAt: Date.now(),
    errors: [],
  };
  const changed = () => { lib.scannedAt = Date.now(); ctx.broadcast('library.changed', { library: lib }); return lib; };
  const plugin = (/** @type {string} */ id) => {
    const p = lib.plugins.find((/** @type {any} */ x) => x.id === id);
    if (!p) throw ctx.fail(ctx.ERRORS.NOT_FOUND, `no plugin ${id}`);
    return p;
  };
  return {
    'library.list': (/** @type {any} */ p) => (p && p.refresh ? changed() : lib),
    'library.available': () => [
      { id: 'pr-review-toolkit@claude-plugins-official', name: 'pr-review-toolkit', description: 'Specialized PR review agents.', marketplace: 'claude-plugins-official', installed: false },
      { id: 'engineering@claude-plugins-official', name: 'engineering', description: 'Engineering workflows.', marketplace: 'claude-plugins-official', installed: true },
    ],
    'library.pluginAction': (/** @type {any} */ p) => {
      const pl = lib.plugins.find((/** @type {any} */ x) => x.id === (p && p.id));
      if (p && p.action === 'install') { changed(); return { ok: true, message: `Installed ${p.id}` }; }
      if (!pl) throw ctx.fail(ctx.ERRORS.NOT_FOUND, `no plugin ${p && p.id}`);
      if (pl.managed) throw ctx.fail(ctx.ERRORS.NOT_ALLOWED, `${pl.name} is managed by your organization`);
      if (p.action === 'enable' || p.action === 'disable') pl.enabled = p.action === 'enable';
      if (p.action === 'update') pl.updateAvailable = false;
      if (p.action === 'uninstall') lib.plugins = lib.plugins.filter((/** @type {any} */ x) => x !== pl);
      changed();
      return { ok: true, message: `${p.action} ${pl.name}: done` };
    },
    'library.configure': (/** @type {any} */ p) => { plugin(p && p.id); return { options: [{ key: 'token', title: 'Access token', type: 'string' }], values: (p && p.values) || {} }; },
    'library.marketplace': (/** @type {any} */ p) => ({ ok: true, message: `${(p && p.action) || 'update'}: done` }),
    'library.skillRead': (/** @type {any} */ p) => {
      const sk = lib.skills.find((/** @type {any} */ x) => x.id === (p && p.id));
      if (!sk) throw ctx.fail(ctx.ERRORS.NOT_FOUND, `no skill ${p && p.id}`);
      return { content: `---\nname: ${sk.name}\ndescription: ${sk.description}\n---\n\n# ${sk.name}\n\n${sk.description}\n` };
    },
    'library.skillWrite': (/** @type {any} */ p) => {
      const name = (p && (p.name || (p.id || '').split(':').pop())) || 'new-skill';
      const sk = { id: `${(p && p.scope) || 'user'}:${name}`, name, description: '', source: (p && p.scope) || 'user', path: path.join(claude, 'skills', name, 'SKILL.md'), deletable: true };
      if (!lib.skills.some((/** @type {any} */ x) => x.id === sk.id)) lib.skills.push(sk);
      changed();
      return sk;
    },
  };
}

module.exports = { libraryMethods };
