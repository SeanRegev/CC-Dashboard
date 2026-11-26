// @ts-check
/**
 * Settings dialog (Ctrl+,), the agent edit dialog (F2: rename + role, "Make Main"), the top bar's ⋯ app menu,
 * "Quit and stop all agents", themes and the notification policy. Owner: the Settings track (M2).
 * Settings persist through the main process: ctx.bridge.getSettings() / setSettings(patch) / onSettings(fn).
 */
import { h, icon } from '../dom.js';
import { openModal, segmented, closeModal } from '../dialogs.js';
import { TERMINAL_FONT, setTerminalAppearance } from '../terminal.js';
import { createRolePicker } from '../components/role-picker.js';
import { roleOf, isMain } from '../roles.js';

/**
 * @typedef {{theme:'dark'|'light'|'system', terminalFontSize:number, terminalFontFamily:string, notifications:'all'|'needs_you'|'off', sound:boolean}} UiSettings
 */

/** @type {UiSettings} */
const DEFAULTS = { theme: 'dark', terminalFontSize: 13, terminalFontFamily: TERMINAL_FONT, notifications: 'all', sound: true };
/** @type {UiSettings} */
let current = { ...DEFAULTS };
let subscribed = false;

export const getCurrentSettings = () => current;

/** Is the light colour scheme in effect? @param {UiSettings} s */
export function isLight(s) {
  if (s.theme === 'light') return true;
  if (s.theme === 'dark') return false;
  try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches); } catch { return false; }
}

/**
 * Notification policy (pure). 'needs_you' mode lets through the "needs you" notifications only: by the
 * v2 `kind`, or, from a core that sends none, by the title the core writes ("<name> needs you").
 * @param {Pick<UiSettings,'notifications'>} s @param {{kind?: string, title?: string}} n
 */
export function notificationAllowed(s, n) {
  if (s.notifications === 'off') return false;
  if (s.notifications === 'all') return true;
  if (n && n.kind) return n.kind === 'needs_you';
  return !!(n && typeof n.title === 'string' && / needs you\b/.test(n.title));
}

/** Short two-note chime for a notification (WebAudio; no sound file needed). */
function chime() {
  try {
    const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    if (!AC) return;
    const ac = new AC();
    const t = ac.currentTime;
    [660, 880].forEach((f, i) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.22);
      o.connect(g).connect(ac.destination);
      o.start(t + i * 0.12);
      o.stop(t + i * 0.12 + 0.25);
    });
    setTimeout(() => ac.close().catch(() => {}), 800);
  } catch { /* no audio: fine */ }
}

/** app.js's notify handler calls this: true = show the native notification (and the chime when Sound is on). @param {{kind?:string,title?:string}} n */
export function prepareNotification(n) {
  if (!notificationAllowed(current, n)) return false;
  if (current.sound) chime();
  return true;
}

/** Theme + terminal font to the document and every terminal. @param {UiSettings} s */
function applyNow(s) {
  current = { ...DEFAULTS, ...s };
  document.documentElement.dataset.theme = current.theme;
  setTerminalAppearance({ light: isLight(current), fontSize: current.terminalFontSize, fontFamily: current.terminalFontFamily });
}

/** Apply saved settings (theme, terminal font) at startup and whenever they change. @param {import('../context.js').ViewContext} ctx */
export function applySettings(ctx) {
  const b = ctx.bridge;
  if (!b || typeof b.getSettings !== 'function') { applyNow(current); return; }
  if (!subscribed) {
    subscribed = true;
    if (typeof b.onSettings === 'function') b.onSettings((/** @type {any} */ s) => { if (s) applyNow(s); });
    try {
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      mq.addEventListener('change', () => { if (current.theme === 'system') applyNow(current); });
    } catch { /* no matchMedia */ }
  }
  applyNow(current);
  Promise.resolve(b.getSettings()).then((s) => { if (s) applyNow(s); }).catch(() => {});
}

/** Save a patch through the main process and apply the result. @param {import('../context.js').ViewContext} ctx @param {Partial<UiSettings>} patch */
async function save(ctx, patch) {
  applyNow({ ...current, ...patch });
  try {
    const s = await ctx.bridge.setSettings(patch);
    if (s) applyNow(s);
  } catch (e) { ctx.toast(`Could not save settings: ${/** @type {any} */ (e).message}`, 'error'); }
}

// ---------- confirm + quit all ----------

/**
 * Small confirm modal. Resolves true on confirm.
 * @param {{title: string, text: string, confirm: string, danger?: boolean}} o
 * @returns {Promise<boolean>}
 */
function confirmDialog(o) {
  return new Promise((resolve) => {
    let answered = false;
    const done = (/** @type {boolean} */ v) => { if (!answered) { answered = true; resolve(v); } };
    const ok = h('button', { type: 'button', class: `btn primary${o.danger ? ' danger' : ''}`, id: 'confirm-ok', onclick: () => { done(true); close(); } }, o.confirm);
    const card = h('div', { class: 'modal confirm-modal', role: 'alertdialog', 'aria-label': o.title },
      h('div', { class: 'modal-head' },
        h('div', null, h('div', { class: 'modal-title' }, o.title), h('div', { class: 'modal-sub' }, o.text))),
      h('div', { class: 'modal-foot' },
        h('button', { type: 'button', class: 'btn ghost', id: 'confirm-cancel', onclick: () => { done(false); close(); } }, 'Cancel'),
        ok));
    const close = openModal('confirm', card, { onClose: () => done(false) });
    ok.focus();
  });
}

/** "Stop N running agents and quit?" then stop the core and quit. @param {import('../context.js').ViewContext} ctx */
export async function confirmQuitAll(ctx) {
  const entries = /** @type {Map<string, any>} */ (ctx.state().entries);
  let n = 0;
  for (const e of entries.values()) if (e.running) n++;
  const yes = await confirmDialog({
    title: n ? `Stop ${n} running agent${n === 1 ? '' : 's'} and quit?` : 'Quit and stop the background service?',
    text: n ? 'Every agent is stopped (their records are kept) and the background service exits. You can resume them later.' : 'No agents are running. The background service exits and the app closes.',
    confirm: 'Stop all and quit',
    danger: true,
  });
  if (!yes) return false;
  try { await ctx.bridge.quitAll(); } catch (e) { ctx.toast(`Could not quit: ${/** @type {any} */ (e).message}`, 'error'); }
  return true;
}

// ---------- top bar ⋯ menu ----------

/** @param {import('../context.js').ViewContext} ctx @param {HTMLElement} anchor */
export function openAppMenu(ctx, anchor) {
  const existing = document.getElementById('app-menu');
  if (existing) { existing.remove(); return; }
  const r = anchor.getBoundingClientRect();
  const close = () => { menu.remove(); document.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', key, true); };
  /** @param {string} id @param {string} text @param {Node|string|null} right @param {() => void} fn */
  const item = (id, text, right, fn) => h('button', { type: 'button', class: 'menu-item', id, role: 'menuitem', onclick: () => { close(); fn(); } }, h('span', { class: 'grow' }, text), right);
  const menu = h('div', { class: 'app-menu', id: 'app-menu', role: 'menu', style: { top: `${Math.round(r.bottom + 6)}px`, right: `${Math.max(8, Math.round(window.innerWidth - r.right))}px` } },
    item('menu-settings', 'Settings…', h('span', { class: 'kbd' }, h('kbd', null, ctx.mod), h('kbd', null, ',')), () => openSettingsDialog(ctx)),
    h('div', { class: 'menu-sep' }),
    item('menu-quit-all', 'Quit and stop all agents', null, () => { confirmQuitAll(ctx); }));
  const away = (/** @type {MouseEvent} */ e) => { const t = /** @type {HTMLElement} */ (e.target); if (!menu.contains(t) && !(t.closest && t.closest('#btn-menu'))) close(); };
  const key = (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('mousedown', away, true);
  document.addEventListener('keydown', key, true);
  document.body.append(menu);
  const first = /** @type {HTMLElement} */ (menu.querySelector('.menu-item'));
  if (first) first.focus();
}

/** The "⋯" button for the top bar. @param {import('../context.js').ViewContext} ctx */
export function appMenuButton(ctx) {
  const b = h('button', { class: 'icon-btn', id: 'btn-menu', title: 'Menu', 'aria-haspopup': 'menu' }, h('span', { class: 'dots', 'aria-hidden': 'true' }, '⋯'));
  b.addEventListener('click', () => openAppMenu(ctx, b));
  return b;
}

// ---------- settings dialog ----------

/** @param {import('../context.js').ViewContext} ctx */
export function openSettingsDialog(ctx) {
  const s0 = current;
  const st = ctx.state();
  /** @type {any} */
  let saveTimer = null;
  /** @param {Partial<UiSettings>} patch @param {boolean} [debounce] */
  const change = (patch, debounce = false) => {
    if (!debounce) { save(ctx, patch); return; }
    applyPreview({ ...current, ...patch });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(ctx, patch), 200);
  };

  const theme = segmented('theme', [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']], s0.theme);
  const notif = segmented('notifications', [['all', 'All'], ['needs_you', 'Only when an agent needs me'], ['off', 'Off']], s0.notifications);
  for (const [seg, key] of /** @type {Array<[HTMLElement, 'theme'|'notifications']>} */ ([[theme, 'theme'], [notif, 'notifications']])) {
    seg.addEventListener('click', (e) => {
      const b = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.seg'));
      if (b && b.dataset.value) change({ [key]: b.dataset.value });
    });
  }

  const size = /** @type {HTMLInputElement} */ (h('input', { type: 'range', id: 'set-font-size', min: '10', max: '24', step: '1', value: String(s0.terminalFontSize), 'aria-label': 'Terminal font size' }));
  const sizeOut = h('output', { class: 'range-out', for: 'set-font-size' }, `${s0.terminalFontSize} px`);
  const family = /** @type {HTMLInputElement} */ (h('input', { id: 'set-font-family', class: 'input', value: s0.terminalFontFamily, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Terminal font family' }));
  const preview = h('pre', { class: 'font-preview', id: 'font-preview' }, '$ claude\n● Reading src/app.js\n  const answer = 42; // 0O 1lI {} []');
  /** @param {UiSettings} s */
  const applyPreview = (s) => {
    preview.style.fontSize = `${s.terminalFontSize}px`;
    preview.style.fontFamily = s.terminalFontFamily;
    sizeOut.textContent = `${s.terminalFontSize} px`;
  };
  applyPreview(s0);
  size.addEventListener('input', () => change({ terminalFontSize: Number(size.value) }, true));
  family.addEventListener('input', () => { if (family.value.trim()) change({ terminalFontFamily: family.value.trim() }, true); });
  const resetFont = h('button', { type: 'button', class: 'btn ghost small', id: 'set-font-reset', onclick: () => {
    size.value = String(DEFAULTS.terminalFontSize); family.value = DEFAULTS.terminalFontFamily;
    change({ terminalFontSize: DEFAULTS.terminalFontSize, terminalFontFamily: DEFAULTS.terminalFontFamily });
    applyPreview({ ...current, terminalFontSize: DEFAULTS.terminalFontSize, terminalFontFamily: DEFAULTS.terminalFontFamily });
  } }, 'Reset');

  const sound = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: 'set-sound', checked: s0.sound }));
  sound.addEventListener('change', () => { change({ sound: sound.checked }); if (sound.checked) chime(); });

  const conn = st.conn === 'open' ? 'connected' : st.conn === 'connecting' ? 'connecting…' : 'not connected';
  const running = [...(/** @type {Map<string, any>} */ (st.entries)).values()].filter((e) => e.running).length;
  const quitBtn = h('button', { type: 'button', class: 'btn danger-outline', id: 'set-quit-all', onclick: () => { confirmQuitAll(ctx); } }, 'Quit and stop all agents');

  const card = h('div', { class: 'modal settings-modal', role: 'dialog', 'aria-label': 'Settings' },
    h('div', { class: 'modal-head' },
      h('span', { class: 'modal-icon' }, icon('terminal')),
      h('div', null, h('div', { class: 'modal-title' }, 'Settings'), h('div', { class: 'modal-sub' }, 'Changes apply right away.')),
      h('button', { type: 'button', class: 'icon-btn modal-x', title: 'Close (Esc)', onclick: () => closeModal() }, icon('close'))),
    h('div', { class: 'modal-body settings-body' },
      h('section', { class: 'set-section' }, h('h3', { class: 'set-title' }, 'Appearance'), theme),
      h('section', { class: 'set-section' }, h('h3', { class: 'set-title' }, 'Terminal'),
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Font size'), h('div', { class: 'range-row' }, size, sizeOut, resetFont)),
        h('label', { class: 'field' }, h('span', { class: 'label' }, 'Font family'), family),
        preview),
      h('section', { class: 'set-section' }, h('h3', { class: 'set-title' }, 'Notifications'), notif,
        h('label', { class: 'check' }, sound, h('span', null, 'Play a sound with notifications'))),
      h('section', { class: 'set-section' }, h('h3', { class: 'set-title' }, 'About'),
        h('div', { class: 'about', id: 'set-about' },
          h('div', null, h('strong', null, 'CC-Dashboard'), st.version ? ` · core v${String(st.version).replace(/^v/, '')}` : ''),
          h('div', { class: 'muted' }, `Core: ${conn} · ${running} running agent${running === 1 ? '' : 's'}`)),
        h('div', { class: 'quit-row' }, quitBtn,
          h('span', { class: 'hint' }, 'Closing the window keeps agents running in the background. This stops them too.')))),
    h('div', { class: 'modal-foot' }, h('button', { type: 'button', class: 'btn', id: 'set-close', onclick: () => closeModal() }, 'Done')));
  openModal('settings', card, { onClose: () => { clearTimeout(saveTimer); } });
  /** @type {HTMLElement} */ (theme.querySelector('.seg.on') || card).focus();
}

// ---------- agent edit dialog ----------

/** @param {import('../context.js').ViewContext} ctx @param {string} agentId */
export function openAgentEditDialog(ctx, agentId) {
  const entries = /** @type {Map<string, any>} */ (ctx.state().entries);
  const e = entries.get(agentId);
  if (!e) return;
  const agent = e.agent;
  const name = /** @type {HTMLInputElement} */ (h('input', { id: 'ae-name', class: 'input', value: agent.name, maxlength: '60', autocomplete: 'off', spellcheck: 'false' }));
  const picker = createRolePicker({
    value: roleOf(agent),
    mainHolder: () => {
      for (const x of entries.values()) if (x.agent.spaceId === agent.spaceId && x.agent.id !== agent.id && isMain(x.agent)) return x.agent.name;
      return null;
    },
  });
  const err = h('div', { class: 'form-error', role: 'alert' });
  const saveBtn = /** @type {HTMLButtonElement} */ (h('button', { type: 'submit', class: 'btn primary', id: 'ae-save' }, 'Save'));
  const form = /** @type {HTMLFormElement} */ (h('form', { class: 'modal agent-edit-modal', role: 'dialog', 'aria-label': 'Edit agent' },
    h('div', { class: 'modal-head' },
      h('div', null, h('div', { class: 'modal-title' }, 'Rename / change role'), h('div', { class: 'modal-sub' }, `${agent.name} · ${ctx.spaceName(agent.spaceId)}`)),
      h('button', { type: 'button', class: 'icon-btn modal-x', title: 'Close (Esc)', onclick: () => close() }, icon('close'))),
    h('div', { class: 'modal-body' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name'), name),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Role'), picker.el),
      err),
    h('div', { class: 'modal-foot' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, 'Cancel'), saveBtn)));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const role = picker.get();
    if (!role) { err.textContent = 'Give the custom role a label.'; return; }
    const nm = name.value.trim();
    if (!nm) { err.textContent = 'The name cannot be empty.'; return; }
    saveBtn.disabled = true;
    const r = await ctx.rpc('agents.update', { id: agentId, name: nm, role });
    if (r) { close(); } else { saveBtn.disabled = false; }
  });
  const close = openModal('agent-edit', form);
  name.focus();
  name.select();
  return close;
}
