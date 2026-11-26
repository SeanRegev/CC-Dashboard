// @ts-check
'use strict';
/**
 * Mock `dashboards.*` for the dev mock core (screenshots, e2e). Owner: the Dashboards track (M2).
 * A CodeBurn-like terminal dashboard with fake output (press q to quit), a web one with a fake URL,
 * a plugin page, a plugin terminal command that needs trust, and a "not installed" entry.
 */
const fs = require('fs');
const path = require('path');

const SCREEN = '\x1b[1mCodeBurn\x1b[0m  last 7 days   \x1b[2m(q quits)\x1b[0m\r\n\r\n  Total   $42.18   1.9M tokens\r\n  Opus    $30.02   ████████████▌\r\n  Sonnet  $11.40   ████▊\r\n  Haiku    $0.76   ▏\r\n\r\n';

/**
 * @param {{broadcast:(e:string,d:any)=>void, fail:(c:string,m:string)=>Error, ERRORS:any, home:string,
 *          attachments: Map<any, Set<string>>, emitOutput:(id:string, data:string)=>void}} ctx
 */
function dashboardMethods(ctx) {
  const pageDir = path.join(ctx.home, 'plugins', 'pager-duty');
  const pageFile = path.join(pageDir, 'dashboard', 'index.html');
  try {
    fs.mkdirSync(path.dirname(pageFile), { recursive: true });
    fs.writeFileSync(pageFile, '<!doctype html><title>On-call</title><body style="font-family:sans-serif;background:#141312;color:#eee"><h1>On-call dashboard</h1><p>Mock page from a plugin.</p>');
  } catch { /* the page is optional in the mock */ }
  /** @type {any[]} */
  let list = [
    { id: 'codeburn-terminal', name: 'CodeBurn', kind: 'terminal', source: 'builtin', command: 'codeburn', available: true, trusted: true, description: 'Token and cost dashboard in a terminal' },
    { id: 'codeburn-web', name: 'CodeBurn (web)', kind: 'web', source: 'builtin', command: 'codeburn web', available: true, trusted: true, description: 'Token and cost dashboard in your browser' },
    { id: 'plugin:pager-duty@acme', name: 'Pager Duty', kind: 'page', source: 'plugin', pluginId: 'pager-duty@acme', file: pageFile, available: true, trusted: true, description: 'Dashboard page of the pager-duty plugin' },
    { id: 'plugin:basemind@acme', name: 'Basemind', kind: 'terminal', source: 'plugin', pluginId: 'basemind@acme', command: 'basemind dash --live', available: true, trusted: false, description: 'Dashboard from the basemind plugin' },
    { id: 'plugin:docs-kit@acme', name: 'docs-kit', kind: 'url', source: 'plugin', pluginId: 'docs-kit@acme', url: 'https://example.com/docs-kit', available: true, trusted: true, description: 'Homepage of the docs-kit plugin' },
    { id: 'mock-missing', name: 'Missing tool', kind: 'terminal', source: 'builtin', command: 'missing-tool', available: false, trusted: true, description: 'Not installed. npm i -g missing-tool' },
  ];
  let counter = 0;
  /** @type {Map<string, string>} */
  const screens = new Map();
  /** @type {Set<string>} */
  const live = new Set();
  const get = (/** @type {string} */ id) => {
    const d = list.find((x) => x.id === id);
    if (!d) throw ctx.fail(ctx.ERRORS.NOT_FOUND, `no dashboard ${id}`);
    return d;
  };
  const changed = () => ctx.broadcast('dashboards.changed', { dashboards: list });
  /** @param {string} id @param {string} data */
  const out = (id, data) => { screens.set(id, (screens.get(id) || '') + data); ctx.emitOutput(id, data); };
  return {
    'dashboards.list': () => list,
    'dashboards.add': (/** @type {any} */ p) => {
      if (!p || !p.name || !String(p.name).trim()) throw ctx.fail(ctx.ERRORS.BAD_REQUEST, 'name is required');
      const d = { id: `user-${++counter}`, name: String(p.name).trim(), kind: p.kind || 'url', source: 'user', command: p.command, url: p.url, available: true, trusted: true };
      list.push(d);
      changed();
      return d;
    },
    'dashboards.remove': (/** @type {any} */ p) => {
      const d = get(p && p.id);
      if (d.source !== 'user') throw ctx.fail(ctx.ERRORS.NOT_ALLOWED, 'only your own dashboards can be removed');
      list = list.filter((x) => x !== d);
      changed();
      return true;
    },
    'dashboards.trust': (/** @type {any} */ p) => { const d = get(p && p.id); d.trusted = true; changed(); return d; },
    'dashboards.start': (/** @type {any} */ p) => {
      const d = get(p && p.id);
      if (d.command && !d.trusted) throw ctx.fail(ctx.ERRORS.NOT_ALLOWED, `the command "${d.command}" has not been trusted yet`);
      if (d.kind === 'web') return { url: 'http://127.0.0.1:4545/' };
      if (d.kind === 'url') return { url: d.url };
      if (d.kind === 'terminal' && !live.has(d.id)) {
        live.add(d.id);
        screens.set(d.id, '');
        setTimeout(() => out(d.id, SCREEN), 0);
      }
      return {};
    },
    'dashboards.stop': (/** @type {any} */ p) => {
      const id = p && p.id;
      if (live.delete(id)) ctx.broadcast('dashboard.exit', { id, code: 0 });
      return true;
    },
    'dashboards.attach': (/** @type {any} */ p, /** @type {any} */ ws) => {
      get(p && p.id);
      let set = ctx.attachments.get(ws);
      if (!set) ctx.attachments.set(ws, (set = new Set()));
      set.add(`dash:${p.id}`);
      return { replay: screens.get(p.id) || '' };
    },
    'dashboards.detach': (/** @type {any} */ p, /** @type {any} */ ws) => { const set = ctx.attachments.get(ws); if (set) set.delete(`dash:${p && p.id}`); return true; },
    'dashboards.input': (/** @type {any} */ p) => {
      get(p && p.id);
      if (!live.has(p.id)) throw ctx.fail(ctx.ERRORS.NOT_RUNNING, 'not running');
      if (p.data === 'q') { out(p.id, '\r\n[quit]\r\n'); live.delete(p.id); ctx.broadcast('dashboard.exit', { id: p.id, code: 0 }); }
      else out(p.id, String(p.data).replace(/\r/g, '\r\n'));
      return true;
    },
    'dashboards.resize': (/** @type {any} */ p) => { get(p && p.id); return true; },
  };
}

module.exports = { dashboardMethods };
