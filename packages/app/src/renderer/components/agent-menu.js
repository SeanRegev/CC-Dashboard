// @ts-check
/**
 * Right-click menu for an agent (sidebar card, grid tile, board card). Owner: Layouts (M2).
 * Open, Rename / change role, Make Main, Stop / Resume, Restart, Remove (asks inside the menu).
 * Styles live in views/grid.css (always loaded).
 */
import { h } from '../dom.js';
import { isMain } from '../roles.js';

/** @type {null | (() => void)} */
let closeCurrent = null;

export function closeAgentMenu() { if (closeCurrent) closeCurrent(); }

/**
 * Attach the menu to an element: right-click, or the Menu key / Shift+F10 while it has focus.
 * @param {HTMLElement} el @param {import('../context.js').ViewContext} ctx @param {string} id
 */
export function attachAgentMenu(el, ctx, id) {
  el.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openAgentMenu(ctx, id, ev.clientX, ev.clientY);
  });
  el.addEventListener('keydown', (ev) => {
    if (ev.target === el && (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10'))) {
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      openAgentMenu(ctx, id, r.left + 24, r.top + 24);
    }
  });
}

/** @param {import('../context.js').ViewContext} ctx @param {string} id @param {number} x @param {number} y */
export function openAgentMenu(ctx, id, x, y) {
  closeAgentMenu();
  const entry = ctx.state().entries.get(id);
  if (!entry) return;
  const st = entry.status ? entry.status.state : 'stopped';
  const running = entry.running && !['stopped', 'exited'].includes(st);
  const prevFocus = /** @type {HTMLElement|null} */ (document.activeElement);

  const menu = h('div', { class: 'ctx-menu', role: 'menu', dataset: { agent: id } });
  const close = () => {
    if (closeCurrent !== close) return;
    closeCurrent = null;
    menu.remove();
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    document.removeEventListener('scroll', close, true);
  };
  /** @param {MouseEvent} e */
  const onOutside = (e) => { if (!menu.contains(/** @type {Node} */ (e.target))) close(); };

  /** @param {string} key @param {string} label @param {() => void} run @param {{disabled?: boolean, danger?: boolean, hint?: string}} [o] */
  const item = (key, label, run, o = {}) => h('button', {
    class: `ctx-item${o.danger ? ' danger' : ''}`, role: 'menuitem', type: 'button', disabled: !!o.disabled, dataset: { action: key },
    onclick: () => { run(); },
  }, h('span', { class: 'ctx-label' }, label), o.hint ? h('span', { class: 'ctx-hint' }, o.hint) : null);

  const showMain = () => {
    menu.replaceChildren(
      h('div', { class: 'ctx-title' }, entry.agent.name),
      item('open', 'Open', () => { close(); ctx.openAgent(id); }),
      item('edit', 'Rename / change role…', () => { close(); ctx.editAgent(id); }, { hint: 'F2' }),
      item('make-main', isMain(entry.agent) ? 'Main session (👑)' : 'Make Main 👑', () => { close(); ctx.rpc('agents.update', { id, role: { id: 'main' } }); }, { disabled: isMain(entry.agent) }),
      h('div', { class: 'ctx-sep' }),
      running
        ? item('stop', 'Stop', () => { close(); ctx.rpc('agents.stop', { id }); })
        : item('resume', 'Resume', () => { close(); ctx.rpc('agents.resume', { id }); }),
      item('restart', 'Restart', () => { close(); ctx.rpc('agents.restart', { id }); }, { hint: 'picks up new plugins' }),
      h('div', { class: 'ctx-sep' }),
      item('remove', 'Remove…', showConfirm, { danger: true }));
    focusFirst();
  };
  const showConfirm = () => {
    menu.replaceChildren(
      h('div', { class: 'ctx-title' }, `Remove ${entry.agent.name}?`),
      h('div', { class: 'ctx-note' }, 'Its session record is deleted and its terminal closes. This cannot be undone.'),
      h('div', { class: 'ctx-row' },
        item('cancel', 'Cancel', showMain),
        item('confirm-remove', 'Remove', () => { close(); ctx.rpc('agents.remove', { id }); }, { danger: true })));
    const cancel = /** @type {HTMLElement|null} */ (menu.querySelector('[data-action="cancel"]'));
    if (cancel) cancel.focus();
  };
  function focusFirst() {
    const b = /** @type {HTMLElement|null} */ (menu.querySelector('.ctx-item:not(:disabled)'));
    if (b) b.focus();
  }

  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); if (prevFocus && prevFocus.isConnected) prevFocus.focus(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = /** @type {HTMLElement[]} */ ([...menu.querySelectorAll('.ctx-item:not(:disabled)')]);
      const i = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      const n = items.length;
      if (n) items[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n].focus();
    }
  });
  menu.addEventListener('contextmenu', (e) => e.preventDefault());

  showMain();
  document.body.append(menu);
  focusFirst();
  const w = menu.offsetWidth;
  const hgt = menu.offsetHeight;
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - hgt - 4))}px`;
  closeCurrent = close;
  document.addEventListener('mousedown', onOutside, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  document.addEventListener('scroll', close, true);
}
