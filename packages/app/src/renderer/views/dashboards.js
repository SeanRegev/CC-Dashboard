// @ts-check
/**
 * Dashboards view. Owner: the Dashboards track (M2). Dashboards from your tools and plugins (CodeBurn and more), and your own.
 * Terminal dashboards open in a panel inside this view; web and page dashboards open in their own locked-down window.
 * Contract for views: context.js (View, ViewContext).
 */
import { h, icon } from '../dom.js';
import { TerminalView } from '../terminal.js';

const KIND_LABEL = /** @type {Record<string, string>} */ ({ terminal: 'Terminal', web: 'Web page', page: 'Plugin page', url: 'Web address', app: 'Program' });
const EXTRA_ICONS = /** @type {Record<string, string>} */ ({
  web: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.8 1.6 2.6 3.4 2.6 5.5S9.8 11.9 8 13.5C6.2 11.9 5.4 10.1 5.4 8S6.2 4.1 8 2.5z"/>',
  page: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3M6 9h4M6 11h3"/>',
  url: '<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.6.6M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.6-.6"/>',
  app: '<rect x="2.5" y="3" width="11" height="10" rx="2"/><path d="M2.5 6h11"/>',
});

/** @param {string} kind */
function kindIcon(kind) {
  if (kind === 'terminal') return icon('terminal');
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${EXTRA_ICONS[kind] || EXTRA_ICONS.app}</svg>`;
  return span;
}

/** Who provides it, for the card. @param {any} d */
export function sourceLabel(d) {
  if (d.source === 'builtin') return 'Built in';
  if (d.source === 'user') return 'Yours';
  return String(d.pluginId || d.name || 'plugin').split('@')[0];
}

/** What to tell the user when a built-in tool is missing. @param {any} d */
export function installHint(d) {
  return /^codeburn/.test(d.id) ? 'npm i -g codeburn' : 'Install it, then it shows up here.';
}

/** @param {string} kind */
function openLabel(kind) { return kind === 'url' ? 'Open in browser' : kind === 'app' ? 'Launch' : 'Open'; }

/** @param {import('../context.js').ViewContext} ctx @returns {import('../context.js').View} */
export function createDashboardsView(ctx) {
  /** @type {any[]} */
  let list = [];
  let loaded = false;
  let loading = false;
  /** @type {{id: string, name: string, tv: TerminalView, exited: boolean, code: number|null, body: HTMLElement, status: HTMLElement, restart: HTMLButtonElement, stop: HTMLButtonElement}|null} */
  let panel = null;
  const grid = h('div', { class: 'dash-grid', dataset: { testid: 'dash-grid' } });
  const head = h('div', { class: 'dash-head' });
  const root = h('div', { class: 'dash-main' });
  const el = h('section', { class: 'view view-dashboards', dataset: { view: 'dashboards' } }, root);

  async function refresh(force = false) {
    if (loading) return;
    loading = true;
    try {
      const r = await ctx.client.call('dashboards.list', force ? { refresh: true } : {});
      if (Array.isArray(r)) { list = r; loaded = true; }
    } catch (e) {
      ctx.toast(`Could not load dashboards: ${/** @type {any} */ (e).message}`, 'error');
    } finally {
      loading = false;
      draw();
    }
  }

  /** @param {any} d */
  function card(d) {
    const missing = d.available === false;
    const untrusted = !!d.command && !d.trusted;
    const open = h('button', { class: 'btn small primary dash-open', type: 'button', disabled: missing, title: missing ? installHint(d) : '', onclick: () => openDashboard(d) }, openLabel(d.kind));
    return h('div', { class: `dash-card${missing ? ' missing' : ''}`, dataset: { dash: d.id, kind: d.kind, source: d.source } },
      h('div', { class: 'dash-card-top' },
        h('span', { class: 'dash-kind', title: KIND_LABEL[d.kind] || d.kind }, kindIcon(d.kind)),
        h('div', { class: 'dash-titles' },
          h('div', { class: 'dash-name' }, d.name),
          h('div', { class: 'dash-meta' }, h('span', { class: 'dash-source' }, sourceLabel(d)), ' · ', KIND_LABEL[d.kind] || d.kind))),
      d.description ? h('div', { class: 'dash-desc' }, d.description) : null,
      missing ? h('div', { class: 'dash-warn' }, h('span', { class: 'dash-badge' }, 'not installed'), h('code', null, installHint(d))) : null,
      untrusted ? h('div', { class: 'dash-warn' }, h('span', { class: 'dash-badge need' }, 'asks first'), 'runs a command from a plugin') : null,
      h('div', { class: 'dash-actions' }, open,
        d.source === 'user' ? h('button', { class: 'btn small ghost dash-remove', type: 'button', onclick: () => removeEntry(d) }, 'Remove') : null));
  }

  function draw() {
    if (panel) return;
    root.replaceChildren(
      h('div', { class: 'dash-head' },
        h('div', null, h('div', { class: 'dash-title' }, 'Dashboards'), h('div', { class: 'dash-sub' }, 'Dashboards of your tools and plugins, opened from here.')),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => refresh(true) }, 'Rescan'),
        h('button', { class: 'btn small primary', type: 'button', id: 'dash-add', onclick: () => addDialog() }, icon('plus'), 'Add your own')),
      loaded ? (list.length ? grid : h('div', { class: 'empty' }, h('div', { class: 'empty-title' }, 'No dashboards yet'))) : h('div', { class: 'dash-loading' }, 'Looking for dashboards…'));
    grid.replaceChildren(...list.map(card));
  }

  // ---- opening ----

  /** @param {any} d */
  async function openDashboard(d) {
    if (d.command && !d.trusted) {
      const ok = await trustDialog(d);
      if (!ok) return;
      const t = await ctx.rpc('dashboards.trust', { id: d.id });
      if (!t) return;
      d = { ...d, trusted: true };
    }
    if (d.kind === 'url') {
      if (!(await ctx.bridge.openExternal(d.url))) ctx.toast('Could not open the address', 'error');
    } else if (d.kind === 'page') {
      if (!(await ctx.bridge.openDashboard({ title: d.name, file: d.file }))) ctx.toast('Could not open the page', 'error');
    } else if (d.kind === 'web') {
      let url = d.url;
      if (d.command) {
        ctx.toast(`Starting ${d.name}…`);
        const r = await ctx.rpc('dashboards.start', { id: d.id });
        if (!r) return;
        url = r.url;
      }
      if (!url || !(await ctx.bridge.openDashboard({ title: d.name, url }))) ctx.toast(`${d.name} did not give an address to open`, 'error');
    } else if (d.kind === 'app') {
      const r = await ctx.rpc('dashboards.start', { id: d.id });
      if (r) ctx.toast(`Launched ${d.name}`);
    } else if (d.kind === 'terminal') {
      const r = await ctx.rpc('dashboards.start', { id: d.id });
      if (!r) return;
      showTerminal(d);
    }
  }

  /** @param {any} d */
  async function removeEntry(d) {
    if (await ctx.rpc('dashboards.remove', { id: d.id })) refresh();
  }

  // ---- the terminal panel ----

  /** @param {any} d */
  function showTerminal(d) {
    closePanel();
    const id = d.id;
    const client = ctx.client;
    const tv = new TerminalView({
      id, client, platform: ctx.platform,
      onError: (m) => ctx.toast(m, 'error'),
      backend: {
        input: 'dashboards.input', resize: 'dashboards.resize',
        attach: () => client.call('dashboards.attach', { id }),
        detach: () => { client.call('dashboards.detach', { id }).catch(() => {}); },
      },
    });
    const status = h('span', { class: 'dash-status' }, 'Running');
    const stop = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn small', type: 'button', dataset: { act: 'stop' }, onclick: () => { client.call('dashboards.stop', { id }).catch(() => {}); } }, icon('stop'), 'Stop'));
    const restart = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn small primary', type: 'button', hidden: true, dataset: { act: 'restart' }, onclick: () => restartTerminal() }, icon('play'), 'Restart'));
    const body = h('div', { class: 'dash-term', dataset: { testid: 'dash-term' } }, tv.el);
    const back = h('button', { class: 'btn small ghost', type: 'button', dataset: { act: 'back' }, onclick: () => { closePanel(); draw(); } }, '← Back');
    panel = { id, name: d.name, tv, exited: false, code: null, body, status, restart, stop };
    root.replaceChildren(
      h('div', { class: 'dash-head' }, back, h('div', { class: 'dash-title small' }, d.name), status, h('span', { class: 'grow' }), restart, stop),
      body);
    tv.attach().then(() => tv.focus());
    fitSoon();
  }

  function fitSoon() {
    requestAnimationFrame(() => { if (panel) panel.tv.fit(true); });
  }

  async function restartTerminal() {
    if (!panel) return;
    const p = panel;
    const r = await ctx.rpc('dashboards.start', { id: p.id });
    if (!r || panel !== p) return;
    p.exited = false;
    p.restart.hidden = true;
    p.stop.hidden = false;
    p.status.textContent = 'Running';
    try {
      const a = await ctx.client.call('dashboards.attach', { id: p.id });
      p.tv.reattach((a && a.replay) || '');
    } catch { /* the output events still flow */ }
    p.tv.focus();
  }

  function closePanel() {
    if (!panel) return;
    const p = panel;
    panel = null;
    p.tv.dispose();
  }

  ctx.client.on('dashboard.output', (/** @type {any} */ d) => { if (panel && d && d.id === panel.id) panel.tv.write(d.data); });
  ctx.client.on('dashboard.exit', (/** @type {any} */ d) => {
    if (!panel || !d || d.id !== panel.id) return;
    panel.exited = true;
    panel.code = d.code;
    panel.status.textContent = `Exited${d.code ? ` (code ${d.code})` : ''}`;
    panel.status.classList.add('done');
    panel.restart.hidden = false;
    panel.stop.hidden = true;
  });
  ctx.client.on('dashboards.changed', (/** @type {any} */ d) => {
    if (d && Array.isArray(d.dashboards)) { list = d.dashboards; loaded = true; draw(); }
  });
  ctx.client.on('reconnected', () => {
    refresh();
    if (!panel) return;
    const p = panel;
    ctx.client.call('dashboards.attach', { id: p.id }).then((a) => { if (panel === p) p.tv.reattach((a && a.replay) || ''); }).catch(() => {});
  });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (panel) panel.tv.fit(); }).observe(el);

  // ---- dialogs ----

  /**
   * A small modal in the overlay root (the shared dialog helper is private to dialogs.js).
   * @param {string} name @param {HTMLElement} card @param {() => void} onClose
   */
  function modal(name, card, onClose) {
    const backdrop = h('div', { class: 'modal-backdrop', dataset: { modal: name } }, card);
    const prev = /** @type {HTMLElement|null} */ (document.activeElement);
    const close = () => { backdrop.remove(); if (prev && prev.isConnected) prev.focus(); onClose(); };
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
    backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } });
    /** @type {HTMLElement} */ (document.getElementById('overlay-root')).append(backdrop);
    return close;
  }

  /** Show the exact command of a plugin's dashboard and ask. @param {any} d @returns {Promise<boolean>} */
  function trustDialog(d) {
    return new Promise((resolve) => {
      let answer = false;
      const yes = h('button', { type: 'button', class: 'btn primary', dataset: { act: 'trust' }, onclick: () => { answer = true; close(); } }, 'Trust and open');
      const card = h('div', { class: 'modal dash-trust', role: 'dialog', 'aria-label': 'Run a plugin command?' },
        h('div', { class: 'modal-head' },
          h('span', { class: 'modal-icon' }, icon('terminal')),
          h('div', null, h('div', { class: 'modal-title' }, `Run a command from ${sourceLabel(d)}?`), h('div', { class: 'modal-sub' }, `${d.name} wants to run this on your computer:`))),
        h('div', { class: 'modal-body' },
          h('pre', { class: 'dash-command', dataset: { testid: 'trust-command' } }, d.command),
          d.cwd ? h('div', { class: 'hint' }, `In: ${d.cwd}`) : null,
          h('div', { class: 'hint' }, 'Only continue if you trust this plugin. You are asked again if the command changes.')),
        h('div', { class: 'modal-foot' }, h('button', { type: 'button', class: 'btn ghost', dataset: { act: 'cancel' }, onclick: () => close() }, 'Cancel'), yes));
      const close = modal('dash-trust', card, () => resolve(answer));
      yes.focus();
    });
  }

  function addDialog() {
    let kind = 'terminal';
    const name = /** @type {HTMLInputElement} */ (h('input', { class: 'input', id: 'dash-name', placeholder: 'My dashboard', autocomplete: 'off', spellcheck: 'false', maxlength: '60' }));
    const value = /** @type {HTMLInputElement} */ (h('input', { class: 'input', id: 'dash-value', autocomplete: 'off', spellcheck: 'false' }));
    const valueLabel = h('span', { class: 'label' });
    const hint = h('span', { class: 'hint' });
    const err = h('div', { class: 'form-error', role: 'alert' });
    const KINDS = /** @type {Array<[string,string]>} */ ([['terminal', 'Terminal'], ['web', 'Web (local server)'], ['url', 'Web address'], ['app', 'Program']]);
    const seg = h('div', { class: 'segmented', role: 'radiogroup' });
    const sync = () => {
      for (const b of seg.querySelectorAll('.seg')) { const on = /** @type {HTMLElement} */ (b).dataset.value === kind; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
      const isUrl = kind === 'url';
      valueLabel.textContent = isUrl ? 'Address' : 'Command';
      value.placeholder = isUrl ? 'https://…' : kind === 'web' ? 'mytool serve --port 4000' : kind === 'app' ? 'C:\\Tools\\mytool.exe' : 'npx codeburn';
      hint.textContent = isUrl ? 'Opens in your default browser.'
        : kind === 'terminal' ? 'Runs in a terminal inside CC-Dashboard.'
          : kind === 'web' ? 'Must print the local address (http://localhost:…) when it is ready; CC-Dashboard opens it.' : 'Starts the program outside CC-Dashboard.';
    };
    for (const [v, label] of KINDS) {
      seg.append(h('button', { type: 'button', class: 'seg', role: 'radio', dataset: { value: v }, onclick: () => { kind = v; sync(); } }, label));
    }
    sync();
    const save = /** @type {HTMLButtonElement} */ (h('button', { type: 'submit', class: 'btn primary', id: 'dash-save' }, 'Add dashboard'));
    const form = /** @type {HTMLFormElement} */ (h('form', { class: 'modal dash-add-modal', role: 'dialog', 'aria-label': 'Add your own dashboard' },
      h('div', { class: 'modal-head' },
        h('span', { class: 'modal-icon' }, icon('plus')),
        h('div', null, h('div', { class: 'modal-title' }, 'Add your own dashboard'), h('div', { class: 'modal-sub' }, 'Anything you run or open to see how your work is going.'))),
      h('div', { class: 'modal-body' },
        h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name'), name),
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Kind'), seg),
        h('label', { class: 'field' }, valueLabel, value, hint),
        err),
      h('div', { class: 'modal-foot' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, 'Cancel'), save)));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const v = value.value.trim();
      if (!name.value.trim()) { err.textContent = 'Give it a name.'; return; }
      if (!v) { err.textContent = kind === 'url' ? 'Enter a web address.' : 'Enter the command to run.'; return; }
      save.disabled = true;
      try {
        await ctx.client.call('dashboards.add', { name: name.value.trim(), kind, ...(kind === 'url' ? { url: v } : { command: v }) });
        close();
        refresh();
      } catch (e2) {
        err.textContent = /** @type {any} */ (e2).message || 'Could not add it';
        save.disabled = false;
      }
    });
    const close = modal('dash-add', form, () => {});
    name.focus();
  }

  draw();
  return {
    el,
    update() { if (!loaded && !loading) refresh(); },
    show() { refresh(); if (panel) fitSoon(); },
    hide() {},
  };
}
