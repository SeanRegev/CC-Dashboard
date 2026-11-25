// @ts-check
/**
 * Renderer entry: wires the core client, the sidebar, tabs, split panes and keyboard shortcuts.
 * Terminals are TerminalView instances (one per open tab), moved between panes as tabs change.
 */
import { CoreClient } from './client.js';
import { h, mount, icon, kbd } from './dom.js';
import {
  shortcutFor, cycleIndex, toggleSplit, showInPane, closeInLayout, stateLabel, describeActivity,
  contextPercent, gaugeLevel, formatTokens, modelLabel, sortAgents, spaceCounts,
} from './logic.js';
import { TerminalView } from './terminal.js';
import { renderSidebar } from './views/sidebar.js';
import { openNewAgentDialog, openQuickSwitcher, isModalOpen, modalKind, closeModal, toast } from './dialogs.js';

/** @type {{platform:string, getConnection:() => Promise<{port:number, token:string}|null>, notify:(t:string, b:string, id?:string) => Promise<any>, pickFolder:() => Promise<string|null>, onSelectAgent:(fn:(id:string)=>void) => any}} */
const bridge = /** @type {any} */ (window).cc || {
  platform: 'win32',
  getConnection: async () => null,
  notify: async () => false,
  pickFolder: async () => null,
  onSelectAgent: () => {},
};
const platform = bridge.platform;
const MOD = platform === 'darwin' ? '⌘' : 'Ctrl';
document.body.classList.add(`platform-${platform}`);

const STORE_KEY = 'cc.ui.v1';

const S = {
  /** @type {'idle'|'connecting'|'open'|'closed'} */
  conn: 'connecting',
  everConnected: false,
  version: '',
  /** @type {any[]} */
  spaces: [],
  /** @type {Map<string, {agent:any, status:any, running:boolean}>} */
  entries: new Map(),
  /** @type {string|null} */
  currentSpace: null,
  /** @type {string[]} open tabs (agent ids) */
  tabs: [],
  /** @type {{panes: Array<string|null>, focused: number}} */
  layout: { panes: [null], focused: 0 },
  /** @type {Map<string, TerminalView>} */
  views: new Map(),
  loaded: false,
};

const client = new CoreClient({ getConnection: () => bridge.getConnection(), clientName: 'cc-dashboard-app' });

// ---------- persistence (per-window convenience only) ----------
function saveUi() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ currentSpace: S.currentSpace, tabs: S.tabs, layout: S.layout }));
  } catch { /* storage unavailable */ }
}
function loadUi() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
}

// ---------- helpers ----------
const entriesArr = () => [...S.entries.values()];
const visibleIds = () => new Set(/** @type {string[]} */ (S.layout.panes.filter(Boolean)));
const focusedId = () => S.layout.panes[S.layout.focused] || null;
/** @param {string} id */
const spaceName = (id) => (S.spaces.find((s) => s.id === id) || {}).name || id;

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderChrome(); });
}

// ---------- data ----------
async function loadAll() {
  const [spaces, list] = await Promise.all([client.call('spaces.list'), client.call('agents.list')]);
  S.spaces = spaces || [];
  S.entries = new Map((list || []).map((/** @type {any} */ e) => [e.agent.id, e]));
  if (!S.loaded) {
    S.loaded = true;
    const ui = loadUi();
    if (ui && S.spaces.some((s) => s.id === ui.currentSpace)) S.currentSpace = ui.currentSpace;
    const tabs = ui && Array.isArray(ui.tabs) ? ui.tabs.filter((/** @type {string} */ id) => S.entries.has(id)) : [];
    for (const id of tabs) ensureView(id);
    if (ui && ui.layout && Array.isArray(ui.layout.panes)) {
      const panes = ui.layout.panes.slice(0, 2).map((/** @type {any} */ p) => (p && S.tabs.includes(p) ? p : null));
      S.layout = { panes: panes.length ? panes : [null], focused: Math.min(ui.layout.focused || 0, panes.length - 1) };
      if (S.layout.panes.every((p) => !p) && S.tabs.length) S.layout = { panes: [S.tabs[0]], focused: 0 };
    }
  } else {
    // after a reconnect: drop tabs whose agents are gone
    for (const id of [...S.tabs]) if (!S.entries.has(id)) closeTab(id);
  }
  if (!S.currentSpace || !S.spaces.some((s) => s.id === S.currentSpace)) {
    const counts = spaceCounts(entriesArr());
    const needy = S.spaces.find((s) => counts[s.id] && counts[s.id].needs);
    S.currentSpace = (S.spaces[0] && (needy || S.spaces[0]).id) || null;
  }
  layoutPanes();
  renderChrome();
}

client.on('connection', (/** @type {any} */ st) => {
  S.conn = st;
  if (st === 'open') S.everConnected = true;
  scheduleRender();
});
client.on('ready', (/** @type {any} */ hello) => {
  S.version = (hello && hello.version) || '';
  loadAll().catch((e) => toast(`Could not load agents: ${e.message}`, 'error'));
});
client.onReattach((id, replay) => { const v = S.views.get(id); if (v) v.reattach(replay); });
client.on('reattach-failed', (/** @type {any} */ d) => closeTab(d.id));

client.on('agent.output', (/** @type {any} */ d) => {
  const v = d && S.views.get(d.id);
  if (v) v.write(d.data);
});
client.on('agent.status', (/** @type {any} */ st) => {
  const e = st && S.entries.get(st.agentId);
  if (!e) return;
  e.status = st;
  if (st.state === 'stopped' || st.state === 'exited') e.running = false;
  else e.running = true;
  scheduleRender();
});
client.on('agent.created', (/** @type {any} */ d) => {
  if (!d || !d.agent) return;
  S.entries.set(d.agent.id, { agent: d.agent, status: d.status, running: true });
  scheduleRender();
});
client.on('agent.removed', (/** @type {any} */ d) => {
  if (!d) return;
  closeTab(d.id);
  S.entries.delete(d.id);
  scheduleRender();
});
client.on('agent.exit', (/** @type {any} */ d) => {
  const e = d && S.entries.get(d.id);
  if (!e) return;
  e.running = false;
  if (e.status && !['stopped', 'exited'].includes(e.status.state)) e.status = { ...e.status, state: 'exited', updatedAt: Date.now() };
  scheduleRender();
});
client.on('space.changed', (/** @type {any} */ d) => {
  S.spaces = (d && d.spaces) || [];
  if (S.currentSpace && !S.spaces.some((s) => s.id === S.currentSpace)) S.currentSpace = S.spaces[0] ? S.spaces[0].id : null;
  scheduleRender();
});
client.on('notify', (/** @type {any} */ n) => {
  if (!n) return;
  // Don't ping about an agent you are looking at right now.
  if (n.agentId && document.hasFocus() && visibleIds().has(n.agentId)) return;
  bridge.notify(n.title || 'CC-Dashboard', n.body || '', n.agentId);
});
bridge.onSelectAgent((id) => { if (S.entries.has(id)) openAgent(id); });

// ---------- tabs & panes ----------
/** @param {string} id */
function ensureView(id) {
  let v = S.views.get(id);
  if (!v) {
    v = new TerminalView({
      id, client, platform,
      onFocus: () => {
        const i = S.layout.panes.indexOf(id);
        if (i >= 0 && i !== S.layout.focused) { S.layout = { ...S.layout, focused: i }; markFocus(); scheduleRender(); }
      },
      onError: (m) => toast(m, 'error'),
    });
    S.views.set(id, v);
    if (!S.tabs.includes(id)) S.tabs.push(id);
    v.attach();
  }
  return v;
}

/** Open an agent: tab + focused pane + keyboard focus. @param {string} id */
function openAgent(id) {
  const e = S.entries.get(id);
  if (!e) return;
  closeModal();
  ensureView(id);
  S.layout = showInPane(S.layout, id);
  S.currentSpace = e.agent.spaceId;
  layoutPanes();
  renderChrome();
  saveUi();
  focusTerminal();
}

/** Close a tab: detach its terminal; the agent keeps running in the core. @param {string} id */
function closeTab(id) {
  const v = S.views.get(id);
  if (!v && !S.tabs.includes(id)) return;
  if (v) v.dispose();
  S.views.delete(id);
  S.tabs = S.tabs.filter((t) => t !== id);
  S.layout = closeInLayout(S.layout, id, S.tabs);
  layoutPanes();
  scheduleRender();
  saveUi();
  focusTerminal();
}

/** @param {string} id */
function selectTab(id) {
  S.layout = showInPane(S.layout, id);
  const e = S.entries.get(id);
  if (e) S.currentSpace = e.agent.spaceId;
  layoutPanes();
  renderChrome();
  saveUi();
  focusTerminal();
}

/** Focus the focused pane's terminal on the next frame (after layout), unless a dialog opened in between. */
function focusTerminal() {
  requestAnimationFrame(() => {
    // A shortcut like Ctrl+K can open a dialog within the same frame; taking focus back would send
    // what the user types into the dialog to the agent instead.
    if (isModalOpen()) return;
    const id = focusedId();
    const v = id && S.views.get(id);
    if (v) v.focus();
  });
}

function doToggleSplit() {
  S.layout = toggleSplit(S.layout, S.tabs);
  layoutPanes();
  renderChrome();
  saveUi();
  focusTerminal();
}

/** @type {Array<{root:HTMLElement, head:HTMLElement, host:HTMLElement, foot:HTMLElement, ro:ResizeObserver}>} */
const paneEls = [];
const workspace = /** @type {HTMLElement} */ (document.getElementById('workspace'));

/** @param {number} i */
function paneEl(i) {
  if (!paneEls[i]) {
    const head = h('div', { class: 'pane-head' });
    const host = h('div', { class: 'term-host' });
    const foot = h('div', { class: 'pane-foot' });
    const root = h('section', { class: 'pane', dataset: { pane: String(i) } }, head, host, foot);
    root.addEventListener('mousedown', () => {
      if (S.layout.focused !== i && i < S.layout.panes.length) { S.layout = { ...S.layout, focused: i }; markFocus(); scheduleRender(); }
    }, true);
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const id = S.layout.panes[i];
        const v = id && S.views.get(id);
        if (v) v.fit();
      });
    });
    ro.observe(host);
    paneEls[i] = { root, head, host, foot, ro };
  }
  return paneEls[i];
}

/** Put each pane's terminal (or the empty state) in place. Terminals are moved, never rebuilt. */
function layoutPanes() {
  const n = S.layout.panes.length;
  workspace.classList.toggle('split', n > 1);
  const keep = [];
  for (let i = 0; i < n; i++) {
    const p = paneEl(i);
    keep.push(p.root);
    const id = S.layout.panes[i];
    const v = id ? S.views.get(id) : null;
    if (v) {
      if (v.el.parentElement !== p.host) p.host.replaceChildren(v.el);
    } else {
      p.host.replaceChildren(emptyState());
    }
  }
  // remove extra panes, and park terminals that are not on screen
  for (let i = n; i < paneEls.length; i++) paneEls[i].root.remove();
  for (const [id, v] of S.views) if (!S.layout.panes.includes(id) && v.el.isConnected) v.el.remove();
  const banner = workspace.querySelector('.conn-banner');
  workspace.replaceChildren(...(banner ? [banner] : []), ...keep);
  markFocus();
  requestAnimationFrame(() => {
    for (const id of S.layout.panes) {
      const v = id && S.views.get(id);
      if (v) v.fit(true);
    }
  });
}

function markFocus() {
  paneEls.forEach((p, i) => p.root.classList.toggle('focused', i === S.layout.focused && S.layout.panes.length > 1));
}

function emptyState() {
  if (!S.spaces.length && S.loaded) {
    return h('div', { class: 'empty' },
      h('div', { class: 'empty-mark' }),
      h('div', { class: 'empty-title' }, 'Welcome to CC-Dashboard'),
      h('div', { class: 'empty-sub' }, 'Add a project folder as a space, then start agents in it. They keep running when you close this window.'),
      h('div', { class: 'empty-actions' }, h('button', { class: 'btn primary', onclick: addSpace }, icon('folder'), 'Add space')));
  }
  const needy = sortAgents(entriesArr()).filter((e) => e.status && e.status.state === 'needs_you').slice(0, 3);
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon('terminal')),
    h('div', { class: 'empty-title' }, 'No agent in this pane'),
    h('div', { class: 'empty-sub' }, 'Open one from the sidebar, or start a new one.'),
    h('div', { class: 'empty-actions' },
      h('button', { class: 'btn primary', onclick: newAgent, disabled: !S.spaces.length }, icon('plus'), 'New agent', kbd(MOD, 'T')),
      h('button', { class: 'btn', onclick: quickSwitch }, icon('search'), 'Jump to agent', kbd(MOD, 'K'))),
    needy.length ? h('div', { class: 'empty-needs' },
      h('div', { class: 'empty-needs-title' }, '◆ Waiting for you'),
      needy.map((e) => h('button', { class: 'empty-need', onclick: () => openAgent(e.agent.id) },
        h('span', { class: 'dot st-needs_you' }),
        h('span', { class: 'empty-need-name' }, e.agent.name),
        h('span', { class: 'empty-need-msg' }, describeActivity(e.status)),
        h('span', { class: 'empty-need-space' }, spaceName(e.agent.spaceId))))) : null,
    h('div', { class: 'shortcuts' },
      shortcutRow([MOD, 'T'], 'New agent'), shortcutRow([MOD, 'K'], 'Jump to agent'),
      shortcutRow([MOD, 'Tab'], 'Next tab'), shortcutRow([MOD, '1–9'], 'Go to tab'),
      shortcutRow([MOD, '\\'], 'Split / unsplit'), shortcutRow([MOD, 'W'], 'Close tab')));
}
/** @param {string[]} keys @param {string} label */
function shortcutRow(keys, label) {
  return h('div', { class: 'shortcut' }, kbd(...keys), h('span', null, label));
}

// ---------- chrome rendering ----------
const els = {
  crumb: /** @type {HTMLElement} */ (document.getElementById('crumb')),
  tabs: /** @type {HTMLElement} */ (document.getElementById('tabs')),
  actions: /** @type {HTMLElement} */ (document.getElementById('top-actions')),
  sidebar: /** @type {HTMLElement} */ (document.getElementById('sidebar')),
};

function renderChrome() {
  const visible = visibleIds();
  const focused = focusedId();
  const entries = entriesArr();

  // top bar: current space + tabs
  const space = S.spaces.find((s) => s.id === S.currentSpace);
  mount(els.crumb, space
    ? h('span', { class: 'crumb-space', title: space.path }, icon('folder'), h('span', { class: 'crumb-name' }, space.name))
    : h('span', { class: 'crumb-space muted' }, S.loaded ? 'No space' : '…'));

  mount(els.tabs,
    ...S.tabs.map((id, i) => {
      const e = S.entries.get(id);
      const st = e && e.status ? e.status.state : 'stopped';
      const tab = h('div', {
        class: `tab st-${st}${id === focused ? ' active' : ''}${visible.has(id) && id !== focused ? ' shown' : ''}`,
        role: 'tab', 'aria-selected': String(id === focused), tabindex: '-1',
        title: `${e ? e.agent.name : id} · ${e ? spaceName(e.agent.spaceId) : ''}${i < 9 ? `  (${MOD}+${i + 1})` : ''}`,
        dataset: { agent: id },
        onmousedown: (/** @type {MouseEvent} */ ev) => { if (ev.button === 1) { ev.preventDefault(); closeTab(id); } },
        onclick: () => selectTab(id),
      },
      h('span', { class: `dot st-${st}` }),
      h('span', { class: 'tab-name' }, e ? e.agent.name : id),
      st === 'needs_you' ? h('span', { class: 'tab-needs', title: 'Needs you' }, '◆') : null,
      h('button', { class: 'tab-close', title: `Close tab (${MOD}+W); the agent keeps running`, onclick: (/** @type {Event} */ ev) => { ev.stopPropagation(); closeTab(id); } }, icon('close')));
      return tab;
    }),
    h('button', { class: 'tab-new', title: `New agent (${MOD}+T)`, onclick: newAgent, disabled: !S.spaces.length }, icon('plus')));
  const activeTab = els.tabs.querySelector('.tab.active');
  if (activeTab && /** @type {any} */ (activeTab).scrollIntoView) /** @type {any} */ (activeTab).scrollIntoView({ block: 'nearest', inline: 'nearest' });

  const split = S.layout.panes.length > 1;
  const needs = entries.filter((e) => e.status && e.status.state === 'needs_you').length;
  mount(els.actions,
    needs ? h('button', { class: 'needs-pill', title: 'Open the agent that has waited longest', onclick: openNextNeedy }, `◆ ${needs} need${needs === 1 ? 's' : ''} you`) : null,
    h('button', { class: `icon-btn${split ? ' on' : ''}`, id: 'btn-split', title: `${split ? 'Unsplit' : 'Split'} (${MOD}+\\)`, onclick: doToggleSplit }, icon(split ? 'unsplit' : 'split')));
  document.title = needs ? `(${needs}) CC-Dashboard` : 'CC-Dashboard';

  renderSidebar(els.sidebar, {
    spaces: S.spaces, entries, currentSpace: S.currentSpace, visible, openTabs: new Set(S.tabs),
    conn: S.conn, version: S.version, mod: MOD,
  }, {
    selectSpace: (id) => { S.currentSpace = id; saveUi(); scheduleRender(); },
    addSpace, openAgent, newAgent, quickSwitch,
  });

  S.layout.panes.forEach((id, i) => renderPaneChrome(i, id));
  renderBanner();
}

/** @param {number} i @param {string|null} id */
function renderPaneChrome(i, id) {
  const p = paneEl(i);
  const e = id ? S.entries.get(id) : null;
  const split = S.layout.panes.length > 1;
  const closePane = split ? h('button', { class: 'icon-btn small', title: `Close this pane (${MOD}+\\ unsplits)`, onclick: () => { S.layout = { panes: S.layout.panes.filter((_, j) => j !== i), focused: 0 }; layoutPanes(); renderChrome(); saveUi(); } }, icon('close')) : null;
  if (!e) {
    p.root.classList.add('is-empty');
    mount(p.head, h('span', { class: 'pane-title muted' }, split ? `Pane ${i + 1}` : ''), h('span', { class: 'grow' }), closePane);
    mount(p.foot);
    if (S.loaded && !p.host.querySelector('.empty')) p.host.replaceChildren(emptyState());
    return;
  }
  p.root.classList.remove('is-empty');
  const st = e.status ? e.status.state : 'stopped';
  const running = e.running && !['stopped', 'exited'].includes(st);
  mount(p.head,
    h('span', { class: `dot st-${st}` }),
    h('span', { class: 'pane-title' }, e.agent.name),
    h('span', { class: 'pane-path', title: e.agent.cwd }, `${spaceName(e.agent.spaceId)}  ·  ${e.agent.cwd}`),
    h('span', { class: 'grow' }),
    running
      ? h('button', { class: 'btn ghost small', title: 'Stop the Claude process (the chat is kept)', onclick: () => rpc('agents.stop', { id: e.agent.id }) }, icon('stop'), 'Stop')
      : h('button', { class: 'btn primary small', title: 'Resume this session', onclick: () => rpc('agents.resume', { id: e.agent.id }) }, icon('play'), 'Resume'),
    closePane);

  const pct = contextPercent(e.status && e.status.usage);
  const usage = (e.status && e.status.usage) || {};
  const mode = e.agent.mode === 'acceptEdits' ? 'Accept edits' : e.agent.mode === 'plan' ? 'Plan' : '';
  mount(p.foot,
    h('span', { class: `state-chip st-${st}` }, h('span', { class: `dot st-${st}` }), stateLabel(st)),
    h('span', { class: 'foot-activity', title: describeActivity(e.status) }, describeActivity(e.status).replace(/^Done · /, '')),
    h('span', { class: 'grow' }),
    mode ? h('span', { class: 'foot-item mode' }, mode) : null,
    h('span', { class: 'foot-item gauge', title: `Context window ${pct}% full` },
      h('span', { class: 'gauge-label' }, 'Context'),
      h('span', { class: `gauge-bar lvl-${gaugeLevel(pct)}` }, h('span', { class: 'gauge-fill', style: { width: `${pct}%` } })),
      h('span', { class: 'gauge-pct' }, `${pct}%`)),
    h('span', { class: 'foot-item', title: `${usage.total || 0} tokens this session` }, h('span', { class: 'foot-num' }, formatTokens(usage.total)), ' tokens'),
    h('span', { class: 'foot-item model' }, modelLabel(usage.model || e.agent.model)));
}

function renderBanner() {
  let b = workspace.querySelector('.conn-banner');
  const show = S.everConnected && S.conn !== 'open';
  if (!show) { if (b) b.remove(); return; }
  if (!b) {
    b = h('div', { class: 'conn-banner' }, h('span', { class: 'spinner' }), 'Reconnecting to the core… your agents keep running.');
    workspace.prepend(b);
  }
}

// ---------- actions ----------
/** @param {string} method @param {any} params */
async function rpc(method, params) {
  try {
    return await client.call(method, params);
  } catch (e) {
    toast(`${method} failed: ${/** @type {any} */ (e).message}`, 'error');
    return undefined;
  }
}

function newAgent() {
  if (!S.spaces.length) { addSpace(); return; }
  openNewAgentDialog({ spaces: S.spaces, entries: entriesArr(), spaceId: S.currentSpace, mod: MOD }, async (p) => {
    /** @type {any} */
    const params = { spaceId: p.spaceId, name: p.name };
    if (p.prompt) params.prompt = p.prompt;
    if (p.model) params.model = p.model;
    if (p.mode) params.mode = p.mode;
    if (p.worktree) params.worktree = true;
    const agent = await client.call('agents.create', params);
    if (!S.entries.has(agent.id)) {
      S.entries.set(agent.id, { agent, status: { agentId: agent.id, state: 'starting', counts: { tools: 0, turns: 0, errors: 0, subagents: 0 }, files: [], usage: { total: 0, context: 0, contextPct: 0, model: agent.model || '' }, history: [], updatedAt: Date.now() }, running: true });
    }
    openAgent(agent.id);
  });
}

async function addSpace() {
  const folder = await bridge.pickFolder();
  if (!folder) return;
  const space = await rpc('spaces.add', { path: folder });
  if (space) {
    if (!S.spaces.some((s) => s.id === space.id)) S.spaces = [...S.spaces, space];
    S.currentSpace = space.id;
    saveUi();
    layoutPanes();
    renderChrome();
  }
}

function quickSwitch() {
  if (modalKind() === 'quick-switch') { closeModal(); return; }
  openQuickSwitcher({ entries: entriesArr(), spaces: S.spaces }, openAgent);
}

function openNextNeedy() {
  const next = sortAgents(entriesArr()).find((e) => e.status && e.status.state === 'needs_you');
  if (next) openAgent(next.agent.id);
}

// ---------- keyboard ----------
window.addEventListener('keydown', (ev) => {
  const sc = shortcutFor(ev, platform);
  if (!sc) return;
  const inTerminal = !!(document.activeElement && document.activeElement.closest('.term-slot'));
  if (sc.action === 'copy' || sc.action === 'paste') {
    if (!inTerminal) return; // native copy/paste in inputs
    ev.preventDefault();
    ev.stopPropagation();
    const id = focusedId();
    const v = id && S.views.get(id);
    if (!v) return;
    if (sc.action === 'copy' && v.hasSelection()) navigator.clipboard.writeText(v.getSelection()).catch(() => {});
    if (sc.action === 'paste') navigator.clipboard.readText().then((t) => t && v.paste(t)).catch(() => {});
    return;
  }
  if (isModalOpen() && sc.action !== 'quickSwitch') return;
  ev.preventDefault();
  ev.stopPropagation();
  const cur = focusedId();
  const idx = cur ? S.tabs.indexOf(cur) : -1;
  switch (sc.action) {
    case 'newAgent': newAgent(); break;
    case 'quickSwitch': quickSwitch(); break;
    case 'toggleSplit': doToggleSplit(); break;
    case 'closeTab':
      if (cur) closeTab(cur);
      else if (S.layout.panes.length > 1) doToggleSplit();
      break;
    case 'nextTab':
    case 'prevTab': {
      const n = cycleIndex(idx, S.tabs.length, sc.action === 'nextTab' ? 1 : -1);
      if (n >= 0) selectTab(S.tabs[n]);
      break;
    }
    case 'gotoTab':
      if (sc.index !== undefined && S.tabs[sc.index]) selectTab(S.tabs[sc.index]);
      break;
  }
}, true);

// relative times in the sidebar
setInterval(scheduleRender, 20000);

// ---------- debug hook for e2e tests and screenshots (read-only) ----------
/** @type {any} */ (window).__cc = {
  snapshot: () => ({ conn: S.conn, tabs: [...S.tabs], layout: JSON.parse(JSON.stringify(S.layout)), currentSpace: S.currentSpace, agents: entriesArr().map((e) => e.agent.id) }),
  /** Text of an open terminal's buffer. @param {string} id */
  termText: (id) => {
    const v = S.views.get(id);
    if (!v) return null;
    const buf = v.term.buffer.active;
    const out = [];
    for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i).translateToString(true));
    return out.join('\n');
  },
  termSize: (/** @type {string} */ id) => { const v = S.views.get(id); return v ? { cols: v.term.cols, rows: v.term.rows } : null; },
};

renderChrome();
layoutPanes();
client.start();
