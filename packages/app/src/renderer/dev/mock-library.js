// @ts-check
'use strict';
/**
 * Mock `library.*` for the dev mock core (screenshots, e2e). Owner: the Library track (M2).
 * Plausible data shaped like protocol.js Library. User and project skills are real files under <home>/mock-library
 * (so the app's "delete = move to trash" works for real and a refresh drops what is gone); plugin skills are virtual.
 * Special plugin: `cmd-plugin@getagentseal` needs the install-command confirmation (sha256 = 'c0ffee' x 10 + 'c0ff').
 */
const fs = require('fs');
const path = require('path');

const CMD_SHA = `${'c0ffee'.repeat(10)}c0ff`;

/** @param {{broadcast:(e:string,d:any)=>void, fail:(c:string,m:string)=>Error, ERRORS:any, home:string}} ctx */
function libraryMethods(ctx) {
  const root = path.join(ctx.home, 'mock-library');
  const claude = path.join(root, 'claude');
  const proj = path.join(root, 'cc-dashboard');
  const plug = (/** @type {string} */ name) => path.join(claude, 'plugins', 'cache', 'claude-plugins-official', name);
  const fm = (/** @type {string} */ name, /** @type {string} */ desc) => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\n${desc}\n`;
  /** @param {string} file @param {string} text */
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

  /** @type {any[]} */
  const seedSkills = [
    { id: 'user:session-start-hook', name: 'session-start-hook', description: 'Creating and developing startup hooks for Claude Code cloud sessions.', source: 'user', path: path.join(claude, 'skills', 'session-start-hook', 'SKILL.md'), deletable: true },
    { id: 'user:pdf-notes', name: 'pdf-notes', description: 'Summarise a PDF into short notes.', source: 'user', path: path.join(claude, 'skills', 'pdf-notes', 'SKILL.md'), deletable: true },
    { id: 'project:cc-dashboard:release', name: 'release', description: 'Cut a CC-Dashboard release: bump, tag, publish.', source: 'project', spaceId: 'cc-dashboard', path: path.join(proj, '.claude', 'skills', 'release', 'SKILL.md'), deletable: true },
  ];
  for (const s of seedSkills) put(s.path, fm(s.name, s.description));

  /** @type {any} */
  const lib = {
    plugins: [
      { id: 'engineering@claude-plugins-official', name: 'engineering', version: '1.2.0', scope: 'user', enabled: true, installPath: plug('engineering'), description: 'Standups, code review, architecture decisions, incident response and docs.', author: 'Anthropic', marketplace: 'claude-plugins-official', managed: false, components: { skills: ['code-review', 'debug', 'standup', 'system-design'], agents: [], commands: [], hooks: 0, mcpServers: ['github', 'linear'] }, tokens: { alwaysOn: 873 }, hasConfig: false, updateAvailable: true, dashboards: [] },
      { id: 'codeburn@getagentseal', name: 'codeburn', version: '0.9.4', scope: 'user', enabled: true, installPath: plug('codeburn'), description: 'See where your Claude Code tokens and money go.', author: 'AgentSeal', homepage: 'https://github.com/getagentseal/codeburn', marketplace: 'getagentseal', managed: false, components: { skills: [], agents: [], commands: ['cost'], hooks: 0, mcpServers: [] }, tokens: { alwaysOn: 40 }, hasConfig: false, updateAvailable: false, dashboards: ['codeburn-terminal', 'codeburn-web'] },
      { id: 'security-guidance@synced', name: 'security-guidance', version: '2.0.20', scope: 'synced', enabled: true, installPath: plug('security-guidance'), description: 'Warns about risky patterns while editing.', author: 'Anthropic', managed: true, components: { skills: [], agents: [], commands: [], hooks: 2, mcpServers: [] }, tokens: { alwaysOn: 0 }, hasConfig: false, dashboards: [] },
      { id: 'figma@claude-plugins-official', name: 'figma', version: '2.2.211', scope: 'user', enabled: false, installPath: plug('figma'), description: 'Design to code with Figma.', author: 'Figma', homepage: 'https://www.figma.com', marketplace: 'claude-plugins-official', managed: false, components: { skills: ['figma-use', 'figma-design-to-code'], agents: ['designer'], commands: [], hooks: 0, mcpServers: ['figma'] }, tokens: { alwaysOn: 610 }, hasConfig: true, dashboards: [] },
    ],
    skills: [
      ...seedSkills,
      ...['code-review', 'debug', 'standup', 'system-design'].map((n) => ({ id: `plugin:engineering@claude-plugins-official:${n}`, name: n, description: `The ${n} workflow from the engineering plugin.`, source: 'plugin', pluginId: 'engineering@claude-plugins-official', path: path.join(plug('engineering'), 'skills', n, 'SKILL.md'), deletable: false })),
      ...['figma-use', 'figma-design-to-code'].map((n) => ({ id: `plugin:figma@claude-plugins-official:${n}`, name: n, description: `The ${n} skill from the figma plugin.`, source: 'plugin', pluginId: 'figma@claude-plugins-official', path: path.join(plug('figma'), 'skills', n, 'SKILL.md'), deletable: false })),
    ],
    marketplaces: [
      { name: 'claude-plugins-official', source: 'github:anthropics/claude-plugins-official', lastUpdated: '2026-11-24T19:41:58.818Z' },
      { name: 'getagentseal', source: 'github:getagentseal/codeburn' },
    ],
    scannedAt: Date.now(),
    errors: [],
  };
  /** @type {Array<{id:string, name:string, description:string, marketplace:string}>} */
  const catalog = [
    { id: 'pr-review-toolkit@claude-plugins-official', name: 'pr-review-toolkit', description: 'Specialized PR review agents.', marketplace: 'claude-plugins-official' },
    { id: 'cmd-plugin@getagentseal', name: 'cmd-plugin', description: 'Installs by running a command (asks you to confirm it).', marketplace: 'getagentseal' },
  ];
  /** @type {Record<string, any>} */
  const configValues = {};

  const changed = () => { lib.scannedAt = Date.now(); ctx.broadcast('library.changed', { library: lib }); return lib; };
  /** A refresh rescans the disk: skills whose file is gone disappear. */
  const rescan = () => {
    lib.skills = lib.skills.filter((/** @type {any} */ s) => s.source === 'plugin' || fs.existsSync(s.path));
    return changed();
  };
  const plugin = (/** @type {string} */ id) => {
    const p = lib.plugins.find((/** @type {any} */ x) => x.id === id);
    if (!p) throw ctx.fail(ctx.ERRORS.NOT_FOUND, `no plugin ${id}`);
    return p;
  };
  const skill = (/** @type {any} */ id) => {
    const sk = lib.skills.find((/** @type {any} */ x) => x.id === id);
    if (!sk) throw ctx.fail(ctx.ERRORS.NOT_FOUND, `no skill ${id}`);
    return sk;
  };

  return {
    'library.list': (/** @type {any} */ p) => (p && p.refresh ? rescan() : lib),
    'library.available': () => {
      const installed = new Set(lib.plugins.map((/** @type {any} */ x) => x.id));
      return [...lib.plugins.filter((/** @type {any} */ x) => x.marketplace).map((/** @type {any} */ x) => ({ id: x.id, name: x.name, description: x.description, marketplace: x.marketplace, installed: true })),
        ...catalog.map((c) => ({ ...c, installed: installed.has(c.id) }))];
    },
    'library.pluginAction': (/** @type {any} */ p) => {
      if (!p || typeof p.id !== 'string') throw ctx.fail(ctx.ERRORS.BAD_REQUEST, 'id is required');
      if (p.action === 'install') {
        const c = catalog.find((x) => x.id === p.id);
        if (!c) throw ctx.fail(ctx.ERRORS.NOT_FOUND, `no plugin ${p.id} in any marketplace`);
        if (p.id === 'cmd-plugin@getagentseal' && p.acceptCommand !== CMD_SHA) {
          return { ok: false, message: 'This plugin runs a command to install. Review it, then confirm.', confirm: { command: 'npx cmd-plugin-installer --yes', sha256: CMD_SHA } };
        }
        if (!lib.plugins.some((/** @type {any} */ x) => x.id === p.id)) {
          lib.plugins.push({ id: c.id, name: c.name, version: '1.0.0', scope: 'user', enabled: true, installPath: plug(c.name), description: c.description, marketplace: c.marketplace, managed: false, components: { skills: [], agents: ['reviewer'], commands: [], hooks: 0, mcpServers: [] }, tokens: { alwaysOn: 120 }, dashboards: [] });
        }
        changed();
        return { ok: true, message: `Installed ${c.name}` };
      }
      const pl = plugin(p.id);
      if (pl.managed) throw ctx.fail(ctx.ERRORS.NOT_ALLOWED, `${pl.name} is managed by your organization`);
      if (p.action === 'enable' || p.action === 'disable') pl.enabled = p.action === 'enable';
      else if (p.action === 'update') { pl.updateAvailable = false; pl.version = '1.3.0'; }
      else if (p.action === 'uninstall') {
        lib.plugins = lib.plugins.filter((/** @type {any} */ x) => x !== pl);
        lib.skills = lib.skills.filter((/** @type {any} */ s) => s.pluginId !== pl.id);
      } else throw ctx.fail(ctx.ERRORS.BAD_REQUEST, `unknown action ${p.action}`);
      changed();
      return { ok: true, message: `${p.action} ${pl.name}: done` };
    },
    'library.configure': (/** @type {any} */ p) => {
      plugin(p && p.id);
      if (p.values) configValues[p.id] = { ...(configValues[p.id] || {}), ...p.values };
      return {
        options: [
          { key: 'token', title: 'Access token', description: 'Personal access token for the service.', type: 'string' },
          { key: 'region', title: 'Region', type: 'string', default: 'eu', options: ['eu', 'us'] },
          { key: 'verbose', title: 'Verbose logs', type: 'boolean', default: false },
        ],
        values: configValues[p.id] || {},
      };
    },
    'library.marketplace': (/** @type {any} */ p) => {
      const a = (p && p.action) || 'update';
      if (a === 'add') {
        if (!p.source) throw ctx.fail(ctx.ERRORS.BAD_REQUEST, 'source is required');
        const name = String(p.source).split(/[/:]/).filter(Boolean).pop() || 'market';
        lib.marketplaces.push({ name, source: String(p.source), lastUpdated: new Date().toISOString() });
      } else if (a === 'remove') lib.marketplaces = lib.marketplaces.filter((/** @type {any} */ m) => m.name !== p.name);
      else if (a === 'update') { for (const m of lib.marketplaces) if (!p.name || m.name === p.name) m.lastUpdated = new Date().toISOString(); }
      else throw ctx.fail(ctx.ERRORS.BAD_REQUEST, `unknown action ${a}`);
      changed();
      return { ok: true, message: `${a}: done` };
    },
    'library.skillRead': (/** @type {any} */ p) => {
      const sk = skill(p && p.id);
      try { return { content: fs.readFileSync(sk.path, 'utf8') }; } catch { return { content: fm(sk.name, sk.description) }; }
    },
    'library.skillWrite': (/** @type {any} */ p) => {
      if (p && p.id) {
        const sk = skill(p.id);
        if (!sk.deletable) throw ctx.fail(ctx.ERRORS.NOT_ALLOWED, 'plugin skills can not be edited');
        put(sk.path, String(p.content || ''));
        const m = /^description:\s*(.*)$/m.exec(String(p.content || ''));
        if (m) sk.description = m[1].trim();
        changed();
        return sk;
      }
      const name = String((p && p.name) || '');
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw ctx.fail(ctx.ERRORS.BAD_REQUEST, 'skill name: lowercase letters, digits and dashes only');
      const scope = p.scope === 'project' ? 'project' : 'user';
      const id = scope === 'project' ? `project:${p.spaceId || 'cc-dashboard'}:${name}` : `user:${name}`;
      if (lib.skills.some((/** @type {any} */ x) => x.id === id)) throw ctx.fail(ctx.ERRORS.BAD_REQUEST, `a skill named ${name} already exists`);
      const file = scope === 'project' ? path.join(proj, '.claude', 'skills', name, 'SKILL.md') : path.join(claude, 'skills', name, 'SKILL.md');
      const content = p.content && String(p.content).trim() ? String(p.content) : fm(name, 'Describe what this skill does.');
      put(file, content);
      const dm = /^description:\s*(.*)$/m.exec(content);
      const sk = { id, name, description: dm ? dm[1].trim() : '', source: scope, ...(scope === 'project' ? { spaceId: p.spaceId || 'cc-dashboard' } : {}), path: file, deletable: true };
      lib.skills.push(sk);
      changed();
      return sk;
    },
  };
}

module.exports = { libraryMethods };
