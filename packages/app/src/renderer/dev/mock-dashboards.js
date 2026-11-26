// @ts-check
'use strict';
/**
 * Mock `dashboards.*` for the dev mock core (screenshots, e2e). Owner: the Dashboards track (M2).
 * Groundwork: a CodeBurn-like terminal dashboard with fake output, and a web one with a fake URL.
 */

/**
 * @param {{broadcast:(e:string,d:any)=>void, fail:(c:string,m:string)=>Error, ERRORS:any, home:string,
 *          attachments: Map<any, Set<string>>, emitOutput:(id:string, data:string)=>void}} ctx
 */
function dashboardMethods(ctx) {
  /** @type {any[]} */
  let list = [
    { id: 'codeburn-terminal', name: 'CodeBurn', kind: 'terminal', source: 'builtin', command: 'npx codeburn', available: true, trusted: true, description: 'Token and cost dashboard (terminal)' },
    { id: 'codeburn-web', name: 'CodeBurn (web)', kind: 'web', source: 'builtin', command: 'codeburn web', available: true, trusted: true, description: 'Token and cost dashboard (browser)' },
  ];
  /** @type {Map<string, string>} */
  const screens = new Map();
  const get = (/** @type {string} */ id) => {
    const d = list.find((x) => x.id === id);
    if (!d) throw ctx.fail(ctx.ERRORS.NOT_FOUND, `no dashboard ${id}`);
    return d;
  };
  const changed = () => ctx.broadcast('dashboards.changed', { dashboards: list });
  return {
    'dashboards.list': () => list,
    'dashboards.add': (/** @type {any} */ p) => {
      const d = { id: `user-${list.length + 1}`, name: (p && p.name) || 'Dashboard', kind: (p && p.kind) || 'url', source: 'user', command: p && p.command, url: p && p.url, available: true, trusted: true };
      list.push(d);
      changed();
      return d;
    },
    'dashboards.remove': (/** @type {any} */ p) => { list = list.filter((x) => x.id !== (p && p.id)); changed(); return true; },
    'dashboards.trust': (/** @type {any} */ p) => { const d = get(p && p.id); d.trusted = true; changed(); return d; },
    'dashboards.start': (/** @type {any} */ p) => {
      const d = get(p && p.id);
      if (d.kind === 'web') return { url: 'http://127.0.0.1:4545/' };
      screens.set(d.id, '\x1b[1mCodeBurn\x1b[0m  last 7 days\r\n\r\n  Total   $42.18   1.9M tokens\r\n  Opus    $30.02   ████████████▌\r\n  Sonnet  $11.40   ████▊\r\n  Haiku    $0.76   ▏\r\n');
      return {};
    },
    'dashboards.stop': (/** @type {any} */ p) => { screens.delete(p && p.id); ctx.broadcast('dashboard.exit', { id: p && p.id, code: 0 }); return true; },
    'dashboards.attach': (/** @type {any} */ p, /** @type {any} */ ws) => {
      get(p && p.id);
      let set = ctx.attachments.get(ws);
      if (!set) ctx.attachments.set(ws, (set = new Set()));
      set.add(`dash:${p.id}`);
      return { replay: screens.get(p.id) || '' };
    },
    'dashboards.detach': (/** @type {any} */ p, /** @type {any} */ ws) => { const set = ctx.attachments.get(ws); if (set) set.delete(`dash:${p && p.id}`); return true; },
    'dashboards.input': (/** @type {any} */ p) => { get(p && p.id); if (p.data === 'q') ctx.emitOutput(p.id, '\r\n[quit]\r\n'); return true; },
    'dashboards.resize': (/** @type {any} */ p) => { get(p && p.id); return true; },
  };
}

module.exports = { dashboardMethods };
