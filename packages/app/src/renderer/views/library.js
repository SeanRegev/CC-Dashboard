// @ts-check
/**
 * Library view. Owner: the Library track (M2). Your plugins and skills: install, update, turn on/off, configure,
 * uninstall; create, edit, delete skills; marketplaces. Talks to the core's library.* methods (protocol.js).
 * Contract for views: context.js (View, ViewContext).
 */
import { h, mount, icon } from '../dom.js';

const TABS = /** @type {Array<[string, string]>} */ ([['plugins', 'Plugins'], ['browse', 'Browse'], ['skills', 'Skills'], ['marketplaces', 'Marketplaces']]);

/** @param {string} p absolute file path → file:// URL */
function fileUrl(p) {
  const s = p.replace(/\\/g, '/');
  return encodeURI(`file://${s.startsWith('/') ? '' : '/'}${s}`).replace(/#/g, '%23');
}

/** @param {number|undefined} n */
function tokens(n) { return n === undefined ? '…' : `~${n >= 10000 ? `${Math.round(n / 1000)}k` : n.toLocaleString('en-US')} tok`; }

/** @param {string} s */
const pluralize = (/** @type {number} */ n, /** @type {string} */ one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Parts a plugin has, e.g. "4 skills · 2 MCP". @param {any} p */
function counts(p) {
  const c = p.components || {};
  const parts = [];
  if (c.skills && c.skills.length) parts.push(pluralize(c.skills.length, 'skill'));
  if (c.agents && c.agents.length) parts.push(pluralize(c.agents.length, 'agent'));
  if (c.commands && c.commands.length) parts.push(pluralize(c.commands.length, 'command'));
  if (c.hooks) parts.push(pluralize(c.hooks, 'hook'));
  if (c.mcpServers && c.mcpServers.length) parts.push(`${c.mcpServers.length} MCP`);
  return parts.length ? parts.join(' · ') : 'no parts';
}

/** @param {any} p @param {string} [cls] */
function logo(p, cls = '') {
  const initial = h('span', { class: `plugin-logo ${cls}`.trim() }, (p.name || '?').slice(0, 1).toUpperCase());
  if (p.logo) {
    const img = /** @type {HTMLImageElement} */ (h('img', { src: fileUrl(p.logo), alt: '' }));
    img.addEventListener('error', () => img.remove());
    initial.append(img);
  }
  return initial;
}

/** @param {any} lib @param {string} id */
const pluginName = (lib, id) => { const p = lib && lib.plugins.find((/** @type {any} */ x) => x.id === id); return p ? p.name : id.split('@')[0]; };

/** @param {import('../context.js').ViewContext} ctx @returns {import('../context.js').View} */
export function createLibraryView(ctx) {
  /** @type {any} */ let lib = null;
  let tab = 'plugins';
  let search = '';
  /** @type {string|null} */ let selPlugin = null;
  /** @type {string|null} */ let selSkill = null;
  /** @type {any[]|null} */ let available = null;
  /** @type {Map<string, string>} */ const skillText = new Map();
  /** @type {{id: string, text: string}|null} */ let editing = null;
  /** @type {Set<string>} agent ids that were running when the plugins or skills changed */
  const stale = new Set();
  /** @type {Set<string>} */ const busy = new Set();
  let loading = true;
  let marketBusy = false;

  // ---- skeleton ------------------------------------------------------------------------------
  const tabsEl = h('div', { class: 'lib-tabs', role: 'tablist' });
  const searchEl = /** @type {HTMLInputElement} */ (h('input', { class: 'input lib-search', placeholder: 'Search…', 'aria-label': 'Search', autocomplete: 'off', spellcheck: 'false' }));
  const actionsEl = h('div', { class: 'lib-actions' });
  const barEl = h('div', { class: 'lib-bar', hidden: true, dataset: { testid: 'restart-bar' } });
  const errorsEl = h('div', { class: 'lib-errors', hidden: true });
  const mainEl = h('div', { class: 'lib-main' });
  const detailEl = h('aside', { class: 'lib-detail', hidden: true });
  const el = h('section', { class: 'view view-library', dataset: { view: 'library' } },
    h('div', { class: 'lib-head' }, tabsEl, h('span', { class: 'grow' }), searchEl, actionsEl),
    barEl, errorsEl,
    h('div', { class: 'lib-body' }, mainEl, detailEl));
  searchEl.addEventListener('input', () => { search = searchEl.value; renderMain(); });

  // ---- data ----------------------------------------------------------------------------------
  /** @param {boolean} [refresh] */
  async function load(refresh = true) {
    const r = await ctx.rpc('library.list', { refresh });
    if (r) lib = r;
    loading = false;
    render();
  }
  ctx.client.on('library.changed', (/** @type {any} */ d) => { if (d && d.library) { lib = d.library; loading = false; render(); } });

  async function loadAvailable() {
    available = (await ctx.rpc('library.available')) || [];
    renderMain();
  }

  /** Note that running agents now use outdated plugins/skills. @param {string|null} spaceId null = every agent */
  function markStale(spaceId) {
    const entries = /** @type {Map<string, any>} */ (ctx.state().entries);
    for (const [id, e] of entries) if (isRunning(e) && (!spaceId || e.agent.spaceId === spaceId)) stale.add(id);
    renderBar();
  }
  /** @param {any} e */
  const isRunning = (e) => !!e && e.running && !['stopped', 'exited'].includes(e.status ? e.status.state : 'stopped');
  const staleRunning = () => { const entries = /** @type {Map<string, any>} */ (ctx.state().entries); return [...stale].filter((id) => isRunning(entries.get(id))); };

  async function restartStale() {
    const ids = staleRunning();
    let n = 0;
    for (const id of ids) { if (await ctx.rpc('agents.restart', { id })) { n++; stale.delete(id); } }
    renderBar();
    if (n) ctx.toast(`Restarted ${pluralize(n, 'agent')}`);
  }

  // ---- actions -------------------------------------------------------------------------------
  /** @param {string} id @param {string} action @param {{keepData?: boolean, acceptCommand?: string, quiet?: boolean}} [o] */
  async function pluginAction(id, action, o = {}) {
    busy.add(id);
    render();
    try {
      const r = await ctx.rpc('library.pluginAction', { id, action, ...(o.keepData ? { keepData: true } : {}), ...(o.acceptCommand ? { acceptCommand: o.acceptCommand } : {}) });
      if (!r) return null;
      if (r.confirm) { askCommand(id, action, r.confirm); return r; }
      if (r.ok) { markStale(null); if (!o.quiet) ctx.toast(r.message || `${action}: done`); } else ctx.toast(r.message || `${action} failed`, 'error');
      if (r.ok && action === 'uninstall' && selPlugin === id) selPlugin = null;
      if (r.ok && action === 'install' && available) loadAvailable();
      return r;
    } finally { busy.delete(id); render(); }
  }

  /** @param {string} id @param {string} action @param {{command: string, sha256: string}} confirm */
  function askCommand(id, action, confirm) {
    dialog('lib-confirm', `${action === 'update' ? 'Update' : 'Install'} ${id.split('@')[0]}?`,
      'This plugin runs a command. Read it before you allow it.',
      [h('pre', { class: 'lib-command', dataset: { testid: 'confirm-command' } }, confirm.command),
        h('div', { class: 'hint' }, `sha256 ${confirm.sha256.slice(0, 16)}…`)],
      [['Cancel', 'ghost'], ['Run this command and install', 'primary', () => { pluginAction(id, action, { acceptCommand: confirm.sha256 }); }]]);
  }

  /** @param {any} p */
  function askUninstall(p) {
    const keep = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: 'lib-keep-data' }));
    dialog('lib-confirm', `Uninstall ${p.name}?`, 'Its skills, agents and commands go away. Running agents keep using it until you restart them.',
      [h('label', { class: 'check' }, keep, h('span', null, 'Keep its data (settings and files it saved)'))],
      [['Cancel', 'ghost'], ['Uninstall', 'danger', () => { pluginAction(p.id, 'uninstall', { keepData: keep.checked }); }]]);
  }

  /** @param {any} p */
  async function openConfigure(p) {
    const r = await ctx.rpc('library.configure', { id: p.id });
    if (!r) return;
    if (!r.options.length) { ctx.toast(`${p.name} has no options`); return; }
    /** @type {Map<string, HTMLInputElement|HTMLSelectElement>} */
    const fields = new Map();
    const rows = r.options.map((/** @type {any} */ o) => {
      const cur = r.values[o.key] !== undefined ? r.values[o.key] : o.default;
      /** @type {HTMLInputElement|HTMLSelectElement} */
      let input;
      if (Array.isArray(o.options)) {
        input = /** @type {HTMLSelectElement} */ (h('select', { class: 'input', dataset: { key: o.key } }, o.options.map((/** @type {any} */ v) => h('option', { value: String(v), selected: String(v) === String(cur) }, String(v)))));
      } else if (o.type === 'boolean') {
        input = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', dataset: { key: o.key }, checked: cur === true || cur === 'true' }));
      } else {
        input = /** @type {HTMLInputElement} */ (h('input', { class: 'input', type: o.type === 'number' ? 'number' : 'text', value: cur === undefined ? '' : String(cur), dataset: { key: o.key }, autocomplete: 'off', spellcheck: 'false' }));
      }
      fields.set(o.key, input);
      const label = h('span', { class: 'label' }, o.title || o.key);
      return o.type === 'boolean'
        ? h('label', { class: 'check' }, input, h('span', null, o.title || o.key), o.description ? h('span', { class: 'hint' }, o.description) : null)
        : h('label', { class: 'field' }, label, input, o.description ? h('span', { class: 'hint' }, o.description) : null);
    });
    dialog('lib-configure', `Configure ${p.name}`, 'Options this plugin asks for.', rows, [['Cancel', 'ghost'], ['Save', 'primary', async () => {
      /** @type {Record<string, string>} */
      const values = {};
      for (const [k, f] of fields) values[k] = f instanceof HTMLInputElement && f.type === 'checkbox' ? String(f.checked) : f.value;
      const saved = await ctx.rpc('library.configure', { id: p.id, values });
      if (saved) { markStale(null); ctx.toast(`Saved ${p.name} options`); }
    }]]);
  }

  /** @param {any} sk */
  async function tryIt(sk) {
    const name = sk.source === 'plugin' ? `${pluginName(lib, sk.pluginId)}:${sk.name}` : sk.name;
    const st = ctx.state();
    const space = sk.spaceId || st.currentSpace || (st.spaces[0] && st.spaces[0].id) || undefined;
    ctx.newAgent(space, { prompt: `/${name} ` });
  }

  /** @param {any} sk */
  function askDeleteSkill(sk) {
    dialog('lib-confirm', `Delete skill ${sk.name}?`, 'The skill folder moves to your system trash. You can restore it from there.',
      [h('div', { class: 'hint lib-path' }, sk.path)],
      [['Cancel', 'ghost'], ['Delete', 'danger', async () => {
        try {
          if (!ctx.bridge || !ctx.bridge.trashSkill) throw new Error('Deleting needs the desktop app');
          await ctx.bridge.trashSkill(sk.path);
        } catch (e) { ctx.toast(`Could not delete: ${/** @type {any} */ (e).message || e}`, 'error'); return; }
        if (selSkill === sk.id) selSkill = null;
        editing = null;
        skillText.delete(sk.id);
        await load(true);
        markStale(sk.source === 'project' ? sk.spaceId : null);
        ctx.toast(`Moved ${sk.name} to the trash`);
      }]]);
  }

  function askNewSkill() {
    const st = ctx.state();
    const scope = /** @type {HTMLSelectElement} */ (h('select', { class: 'input', id: 'ns-scope' },
      h('option', { value: 'user' }, 'Yours (every project)'),
      ...st.spaces.map((/** @type {any} */ s) => h('option', { value: `project:${s.id}` }, `Project: ${s.name}`))));
    const name = /** @type {HTMLInputElement} */ (h('input', { class: 'input', id: 'ns-name', placeholder: 'my-skill', autocomplete: 'off', spellcheck: 'false', maxlength: '64' }));
    const err = h('div', { class: 'form-error', role: 'alert' });
    dialog('lib-new-skill', 'New skill', 'Starts from a template you can edit next.',
      [h('label', { class: 'field' }, h('span', { class: 'label' }, 'Where'), scope),
        h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name'), name, h('span', { class: 'hint' }, 'Lowercase letters, digits and dashes.')), err],
      [['Cancel', 'ghost'], ['Create', 'primary', async () => {
        const n = name.value.trim();
        if (!/^[a-z0-9][a-z0-9-]*$/.test(n)) { err.textContent = 'Use lowercase letters, digits and dashes.'; return false; }
        const [kind, spaceId] = scope.value.split(':');
        const sk = await ctx.rpc('library.skillWrite', { scope: kind, ...(spaceId ? { spaceId } : {}), name: n, content: '' });
        if (!sk) return false;
        tab = 'skills'; search = ''; searchEl.value = '';
        selSkill = sk.id;
        await load(true);
        await openSkill(sk.id);
        editing = { id: sk.id, text: skillText.get(sk.id) || '' };
        markStale(sk.source === 'project' ? sk.spaceId : null);
        render();
        return undefined;
      }]], name);
  }

  /** @param {string} id */
  async function openSkill(id) {
    selSkill = id;
    editing = null;
    if (!skillText.has(id)) {
      const r = await ctx.rpc('library.skillRead', { id });
      skillText.set(id, r ? r.content : '(could not read this skill)');
    }
    render();
  }

  /** @param {any} sk */
  async function saveSkill(sk) {
    if (!editing) return;
    const saved = await ctx.rpc('library.skillWrite', { id: sk.id, content: editing.text });
    if (!saved) return;
    skillText.set(sk.id, editing.text);
    editing = null;
    ctx.toast(`Saved ${sk.name}`);
    render();
  }

  /** @param {string} name @param {string} source */
  async function marketAction(name, source, action) {
    marketBusy = true; renderMain();
    const r = await ctx.rpc('library.marketplace', { action, ...(action === 'add' ? { source } : name ? { name } : {}) });
    marketBusy = false;
    if (r) { if (r.ok) { if (action !== 'update') markStale(null); ctx.toast(r.message || `${action}: done`); } else ctx.toast(r.message || `${action} failed`, 'error'); }
    if (action !== 'update' || r) { if (available) loadAvailable(); }
    renderMain();
  }

  // ---- dialogs -------------------------------------------------------------------------------
  /**
   * Modal in the look of dialogs.js (its openModal is private to that file).
   * @param {string} kind @param {string} title @param {string} sub @param {Array<HTMLElement|null>} body
   * @param {Array<[string, string, (() => any)?]>} buttons  label, style, handler (return false to stay open)
   * @param {HTMLElement} [focus]
   */
  function dialog(kind, title, sub, body, buttons, focus) {
    const root = document.getElementById('overlay-root');
    if (!root) return;
    const prev = /** @type {HTMLElement|null} */ (document.activeElement);
    const close = () => { backdrop.remove(); if (prev && prev.isConnected) prev.focus(); };
    const foot = h('div', { class: 'modal-foot' }, buttons.map(([label, style, fn], i) => h('button', {
      type: 'button', class: `btn ${style === 'ghost' ? 'ghost' : style === 'primary' ? 'primary' : style === 'danger' ? 'danger' : ''}`.trim(),
      dataset: { testid: i === 0 ? 'cancel' : 'ok' },
      onclick: async () => { if (!fn) return close(); const r = await fn(); if (r !== false) close(); },
    }, label)));
    const card = h('div', { class: 'modal lib-modal', role: 'dialog', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('div', null, h('div', { class: 'modal-title' }, title), h('div', { class: 'modal-sub' }, sub)),
        h('button', { type: 'button', class: 'icon-btn modal-x', title: 'Close (Esc)', onclick: close }, icon('close'))),
      h('div', { class: 'modal-body' }, body), foot);
    const backdrop = h('div', { class: 'modal-backdrop top', dataset: { modal: kind } }, card);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
    backdrop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type !== 'checkbox' && buttons.length > 1) { e.preventDefault(); /** @type {HTMLElement} */ (foot.lastElementChild).click(); }
    });
    root.append(backdrop);
    (focus || /** @type {HTMLElement} */ (foot.lastElementChild)).focus();
  }

  // ---- rendering -----------------------------------------------------------------------------
  function render() { renderHead(); renderBar(); renderErrors(); renderMain(); renderDetail(); }

  function renderHead() {
    mount(tabsEl, TABS.map(([id, label]) => h('button', {
      class: `lib-tab${tab === id ? ' on' : ''}`, role: 'tab', 'aria-selected': String(tab === id), dataset: { tab: id },
      onclick: () => { if (tab === id) return; tab = id; search = ''; searchEl.value = ''; editing = null; if (id === 'browse' && !available) loadAvailable(); render(); },
    }, label, id === 'plugins' && lib ? h('span', { class: 'lib-count' }, String(lib.plugins.length)) : null, id === 'skills' && lib ? h('span', { class: 'lib-count' }, String(lib.skills.length)) : null)));
    searchEl.hidden = tab === 'marketplaces';
    searchEl.placeholder = { plugins: 'Search plugins…', browse: 'Search the marketplaces…', skills: 'Search skills…', marketplaces: '' }[tab] || 'Search…';
    const refreshBtn = h('button', { class: 'btn small ghost', dataset: { act: 'refresh' }, title: 'Rescan plugins and skills', onclick: async () => { await load(true); if (tab === 'browse') loadAvailable(); } }, 'Refresh');
    mount(actionsEl, tab === 'skills' ? h('button', { class: 'btn small primary', dataset: { act: 'new-skill' }, onclick: askNewSkill }, icon('plus'), 'New skill') : null, refreshBtn);
  }

  function renderBar() {
    const n = staleRunning().length;
    barEl.hidden = n === 0;
    if (!n) { mount(barEl); return; }
    mount(barEl, h('span', { class: 'lib-bar-text' }, `${pluralize(n, 'running agent')} ${n === 1 ? 'uses' : 'use'} the old plugins.`),
      h('button', { class: 'btn small primary', dataset: { act: 'restart-stale' }, onclick: restartStale }, 'Restart them'),
      h('button', { class: 'btn small ghost', dataset: { act: 'dismiss-stale' }, onclick: () => { stale.clear(); renderBar(); } }, 'Dismiss'));
  }

  function renderErrors() {
    const errs = lib && lib.errors ? lib.errors : [];
    errorsEl.hidden = !errs.length;
    mount(errorsEl, errs.map((/** @type {string} */ e) => h('div', null, e)));
  }

  /** @param {string} text @param {string} [cls] */
  const badge = (text, cls = '') => h('span', { class: `lib-badge ${cls}`.trim() }, text);

  function renderMain() {
    if (!lib) { mount(mainEl, h('div', { class: 'lib-empty' }, loading ? 'Loading your plugins and skills…' : 'Could not load the library.')); return; }
    if (tab === 'plugins') return renderPlugins();
    if (tab === 'browse') return renderBrowse();
    if (tab === 'skills') return renderSkills();
    return renderMarkets();
  }

  const q = () => search.trim().toLowerCase();
  /** @param {...(string|undefined)} fields */
  const matches = (...fields) => !q() || fields.some((f) => (f || '').toLowerCase().includes(q()));

  function renderPlugins() {
    const list = [...lib.plugins].filter((/** @type {any} */ p) => matches(p.name, p.description, p.author, p.id)).sort((/** @type {any} */ a, /** @type {any} */ b) => a.name.localeCompare(b.name));
    if (!list.length) { mount(mainEl, h('div', { class: 'lib-empty' }, lib.plugins.length ? 'No plugin matches.' : 'No plugins yet. Find some in Browse.')); return; }
    mount(mainEl, h('div', { class: 'plugin-grid' }, list.map((/** @type {any} */ p) => {
      const sw = h('button', {
        class: `switch${p.enabled ? ' on' : ''}`, role: 'switch', 'aria-checked': String(p.enabled), 'aria-label': `${p.enabled ? 'Turn off' : 'Turn on'} ${p.name}`,
        title: p.enabled ? 'Turn off' : 'Turn on', disabled: busy.has(p.id),
        onclick: (/** @type {Event} */ e) => { e.stopPropagation(); pluginAction(p.id, p.enabled ? 'disable' : 'enable', { quiet: true }); },
      }, h('span', { class: 'knob' }));
      return h('div', { class: `plugin-card${selPlugin === p.id ? ' sel' : ''}${p.enabled ? '' : ' off'}${busy.has(p.id) ? ' busy' : ''}`, tabindex: '0', role: 'button', dataset: { plugin: p.id },
        onclick: () => { selPlugin = p.id; render(); },
        onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { selPlugin = p.id; render(); } },
      },
      h('div', { class: 'plugin-top' }, logo(p), h('div', { class: 'plugin-title' }, h('div', { class: 'plugin-name' }, p.name), h('div', { class: 'plugin-ver' }, p.version === 'unknown' ? 'built in' : `v${p.version}`)), sw),
      h('div', { class: 'plugin-desc' }, p.description || 'No description.'),
      h('div', { class: 'plugin-badges' },
        p.updateAvailable ? badge('Update available', 'update') : null, p.managed ? badge('Managed', 'managed') : null, !p.enabled ? badge('Disabled', 'off') : null),
      h('div', { class: 'plugin-meta' }, h('span', null, p.author || '—'), h('span', { class: 'grow' }), h('span', { title: 'Always-on context cost', class: 'tok' }, tokens(p.tokens && p.tokens.alwaysOn))),
      h('div', { class: 'plugin-counts' }, counts(p)));
    })));
  }

  function renderBrowse() {
    if (!available) { mount(mainEl, h('div', { class: 'lib-empty' }, 'Loading the marketplaces…')); return; }
    const list = available.filter((a) => matches(a.name, a.description, a.marketplace));
    if (!list.length) { mount(mainEl, h('div', { class: 'lib-empty' }, 'Nothing found. Add a marketplace in Marketplaces.')); return; }
    mount(mainEl, h('div', { class: 'plugin-grid' }, list.map((a) => h('div', { class: 'plugin-card browse', dataset: { available: a.id } },
      h('div', { class: 'plugin-top' }, logo({ name: a.name }), h('div', { class: 'plugin-title' }, h('div', { class: 'plugin-name' }, a.name), h('div', { class: 'plugin-ver' }, a.marketplace)),
        a.installed
          ? badge('Installed', 'managed')
          : h('button', { class: 'btn small primary', dataset: { act: 'install' }, disabled: busy.has(a.id), onclick: () => pluginAction(a.id, 'install') }, 'Install')),
      h('div', { class: 'plugin-desc' }, a.description || 'No description.')))));
  }

  function renderSkills() {
    const all = /** @type {any[]} */ (lib.skills).filter((s) => matches(s.name, s.description));
    /** @type {Array<[string, any[]]>} */
    const groups = [];
    const yours = all.filter((s) => s.source === 'user');
    if (yours.length) groups.push(['Yours', yours]);
    const spaceIds = [...new Set(all.filter((s) => s.source === 'project').map((s) => s.spaceId))];
    for (const sid of spaceIds) groups.push([`Project: ${ctx.spaceName(sid) || sid}`, all.filter((s) => s.source === 'project' && s.spaceId === sid)]);
    const pluginIds = [...new Set(all.filter((s) => s.source === 'plugin').map((s) => s.pluginId))];
    for (const pid of pluginIds) groups.push([`Plugin: ${pluginName(lib, pid)}`, all.filter((s) => s.source === 'plugin' && s.pluginId === pid)]);
    if (!groups.length) { mount(mainEl, h('div', { class: 'lib-empty' }, lib.skills.length ? 'No skill matches.' : 'No skills yet. Create one with New skill.')); return; }
    mount(mainEl, groups.map(([title, items]) => h('div', { class: 'skill-group' },
      h('div', { class: 'skill-group-title' }, title, h('span', { class: 'lib-count' }, String(items.length))),
      h('div', { class: 'skill-list' }, items.map((s) => h('div', { class: `skill-row${selSkill === s.id ? ' sel' : ''}`, tabindex: '0', role: 'button', dataset: { skill: s.id },
        onclick: () => openSkill(s.id), onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter') openSkill(s.id); },
      }, h('span', { class: 'skill-name' }, `/${s.name}`), h('span', { class: 'skill-desc' }, s.description || 'No description')))))));
  }

  function renderMarkets() {
    const src = /** @type {HTMLInputElement} */ (h('input', { class: 'input', id: 'mk-source', placeholder: 'owner/repo, a git URL or a folder', autocomplete: 'off', spellcheck: 'false' }));
    const add = () => { const v = src.value.trim(); if (v) { marketAction('', v, 'add'); src.value = ''; } };
    src.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    mount(mainEl, h('div', { class: 'market-add' }, src,
      h('button', { class: 'btn primary', dataset: { act: 'add-market' }, disabled: marketBusy, onclick: add }, 'Add marketplace'),
      h('button', { class: 'btn', dataset: { act: 'update-all' }, disabled: marketBusy, onclick: () => marketAction('', '', 'update') }, 'Refresh all')),
    lib.marketplaces.length ? h('div', { class: 'market-list' }, lib.marketplaces.map((/** @type {any} */ m) => h('div', { class: 'market-row', dataset: { market: m.name } },
      h('div', { class: 'grow' }, h('div', { class: 'market-name' }, m.name), h('div', { class: 'hint' }, m.source || '')),
      h('span', { class: 'hint' }, m.lastUpdated ? `Updated ${new Date(m.lastUpdated).toLocaleDateString()}` : ''),
      h('button', { class: 'btn small', dataset: { act: 'update-market' }, disabled: marketBusy, onclick: () => marketAction(m.name, '', 'update') }, 'Refresh'),
      h('button', { class: 'btn small danger', dataset: { act: 'remove-market' }, disabled: marketBusy, onclick: () => dialog('lib-confirm', `Remove ${m.name}?`, 'Plugins already installed from it stay installed.', [], [['Cancel', 'ghost'], ['Remove', 'danger', () => { marketAction(m.name, '', 'remove'); }]]) }, 'Remove'))))
      : h('div', { class: 'lib-empty' }, 'No marketplaces yet.'));
  }

  function renderDetail() {
    const plugin = tab === 'plugins' && lib && selPlugin ? lib.plugins.find((/** @type {any} */ p) => p.id === selPlugin) : null;
    const skill = tab === 'skills' && lib && selSkill ? lib.skills.find((/** @type {any} */ s) => s.id === selSkill) : null;
    detailEl.hidden = !plugin && !skill;
    if (plugin) return renderPluginDetail(plugin);
    if (skill) return renderSkillDetail(skill);
    mount(detailEl);
  }

  /** @param {any} p */
  function renderPluginDetail(p) {
    const c = p.components;
    /** @param {string} title @param {string[]} items */
    const part = (title, items) => items.length ? h('div', { class: 'detail-part' }, h('div', { class: 'detail-part-title' }, `${title} (${items.length})`), h('div', { class: 'chips' }, items.map((i) => h('span', { class: 'chip' }, i)))) : null;
    mount(detailEl,
      h('div', { class: 'detail-head' }, logo(p, 'big'), h('div', { class: 'grow' }, h('div', { class: 'detail-title' }, p.name), h('div', { class: 'hint' }, `${p.version === 'unknown' ? 'built in' : `v${p.version}`} · ${p.scope}${p.marketplace ? ` · ${p.marketplace}` : ''}`)),
        h('button', { class: 'icon-btn small', title: 'Close', onclick: () => { selPlugin = null; render(); } }, icon('close'))),
      h('div', { class: 'plugin-badges' }, p.updateAvailable ? badge('Update available', 'update') : null, p.managed ? badge('Managed', 'managed') : null, !p.enabled ? badge('Disabled', 'off') : null),
      p.managed ? h('div', { class: 'lib-note' }, 'Managed by your organization or built in: you can turn it on or off, but not update or remove it here.') : null,
      h('p', { class: 'detail-desc' }, p.description || 'No description.'),
      h('dl', { class: 'detail-facts' },
        h('dt', null, 'Author'), h('dd', null, p.author || '—'),
        h('dt', null, 'Context cost'), h('dd', null, `${tokens(p.tokens && p.tokens.alwaysOn)} added to every session`),
        h('dt', null, 'Hooks'), h('dd', null, String(c.hooks)),
        p.installPath ? h('dt', null, 'Folder') : null, p.installPath ? h('dd', { class: 'lib-path' }, p.installPath) : null),
      p.homepage ? h('button', { class: 'btn small', dataset: { act: 'homepage' }, onclick: () => ctx.bridge.openExternal(p.homepage) }, 'Open homepage') : null,
      part('Skills', c.skills), part('Agents', c.agents), part('Commands', c.commands), part('MCP servers', c.mcpServers),
      h('div', { class: 'detail-actions' },
        h('button', { class: `btn${p.updateAvailable ? ' primary' : ''}`, dataset: { act: 'update' }, disabled: p.managed || busy.has(p.id), onclick: () => pluginAction(p.id, 'update') }, 'Update'),
        p.hasConfig ? h('button', { class: 'btn', dataset: { act: 'configure' }, disabled: p.managed, onclick: () => openConfigure(p) }, 'Configure') : null,
        h('span', { class: 'grow' }),
        h('button', { class: 'btn danger', dataset: { act: 'uninstall' }, disabled: p.managed || busy.has(p.id), onclick: () => askUninstall(p) }, 'Uninstall')));
  }

  /** @param {any} sk */
  function renderSkillDetail(sk) {
    const text = skillText.get(sk.id);
    const where = sk.source === 'user' ? 'Yours' : sk.source === 'project' ? `Project: ${ctx.spaceName(sk.spaceId) || sk.spaceId}` : `Plugin: ${pluginName(lib, sk.pluginId)}`;
    const isEditing = editing && editing.id === sk.id;
    /** @type {HTMLTextAreaElement|null} */
    let ta = null;
    if (isEditing && editing) {
      ta = /** @type {HTMLTextAreaElement} */ (h('textarea', { class: 'input skill-editor', spellcheck: 'false', 'aria-label': 'SKILL.md' }));
      ta.value = editing.text;
      ta.addEventListener('input', () => { if (editing) editing.text = /** @type {HTMLTextAreaElement} */ (ta).value; });
    }
    mount(detailEl,
      h('div', { class: 'detail-head' }, h('div', { class: 'grow' }, h('div', { class: 'detail-title' }, `/${sk.name}`), h('div', { class: 'hint' }, where)),
        h('button', { class: 'icon-btn small', title: 'Close', onclick: () => { selSkill = null; editing = null; render(); } }, icon('close'))),
      h('p', { class: 'detail-desc' }, sk.description || 'No description.'),
      h('div', { class: 'detail-actions' },
        h('button', { class: 'btn primary', dataset: { act: 'try' }, onclick: () => tryIt(sk) }, icon('play'), 'Try it'),
        sk.deletable && !isEditing ? h('button', { class: 'btn', dataset: { act: 'edit' }, onclick: () => { editing = { id: sk.id, text: text || '' }; renderDetail(); } }, 'Edit') : null,
        isEditing ? h('button', { class: 'btn primary', dataset: { act: 'save' }, onclick: () => saveSkill(sk) }, 'Save') : null,
        isEditing ? h('button', { class: 'btn ghost', dataset: { act: 'cancel-edit' }, onclick: () => { editing = null; renderDetail(); } }, 'Cancel') : null,
        h('span', { class: 'grow' }),
        sk.deletable ? h('button', { class: 'btn danger', dataset: { act: 'delete' }, onclick: () => askDeleteSkill(sk) }, 'Delete') : null),
      sk.source === 'plugin' ? h('div', { class: 'lib-note' }, 'Comes with the plugin. To remove it, turn the plugin off or uninstall it.') : null,
      ta || h('pre', { class: 'skill-text', dataset: { testid: 'skill-text' } }, text === undefined ? 'Loading…' : text),
      h('div', { class: 'hint lib-path' }, sk.path));
    if (ta) ta.focus();
  }

  render();
  return {
    el,
    update() { renderBar(); },
    show() { load(true); if (tab === 'browse') loadAvailable(); },
  };
}
