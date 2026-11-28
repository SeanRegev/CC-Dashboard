// @ts-check
/** Modal dialogs: new agent, quick switcher. Plus toasts. */
import { h, icon, kbd } from './dom.js';
import { roleBadge } from './roles.js';
import { createRolePicker } from './components/role-picker.js';
import { filterAgents, describeActivity, suggestAgentName, stateLabel } from './logic.js';

const root = () => /** @type {HTMLElement} */ (document.getElementById('overlay-root'));

/** @type {{close: () => void, kind: string} | null} */
let current = null;

/**
 * Is a dialog open? Also true for the Library's and Dashboards' own dialogs (they draw their own
 * `.modal-backdrop[data-modal]`), so shortcuts and focus grabs stay out of their way.
 */
export function isModalOpen() { return !!current || !!document.querySelector('#overlay-root [data-modal]'); }
export function modalKind() { return current ? current.kind : null; }
/** A dialog that is not ours to replace (Library / Dashboards). */
export function foreignModalOpen() { return !current && isModalOpen(); }
export function closeModal() { if (current) current.close(); }

/**
 * @param {string} kind @param {HTMLElement} card @param {{top?: boolean, onClose?: () => void}} [o]
 */
export function openModal(kind, card, o = {}) {
  closeModal();
  const prevFocus = /** @type {HTMLElement|null} */ (document.activeElement);
  const backdrop = h('div', { class: `modal-backdrop${o.top ? ' top' : ''}`, dataset: { modal: kind } }, card);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  const close = () => {
    if (!current || current.close !== close) return;
    current = null;
    backdrop.remove();
    o.onClose && o.onClose();
    if (prevFocus && prevFocus.isConnected) prevFocus.focus();
  };
  current = { close, kind };
  root().append(backdrop);
  return close;
}

/**
 * Segmented control. @param {string} name @param {Array<[string,string]>} options value,label @param {string} value
 */
export function segmented(name, options, value) {
  const wrap = h('div', { class: 'segmented', role: 'radiogroup', dataset: { name } });
  for (const [v, label] of options) {
    const b = h('button', { type: 'button', class: `seg${v === value ? ' on' : ''}`, role: 'radio', 'aria-checked': String(v === value), dataset: { value: v } }, label);
    b.addEventListener('click', () => {
      wrap.querySelectorAll('.seg').forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); });
      b.classList.add('on');
      b.setAttribute('aria-checked', 'true');
      wrap.dataset.value = v;
    });
    wrap.append(b);
  }
  wrap.dataset.value = value;
  return wrap;
}

/**
 * New-agent dialog.
 * @param {{spaces:any[], entries:any[], spaceId:string|null, mod:string, prompt?:string, warning?:HTMLElement|null}} s  warning (v4): shown above the form error
 * @param {(params:{spaceId:string, name:string, prompt:string, model:string, mode:string, worktree:boolean, role?:{id:string,label:string,emoji:string}}) => Promise<void>} onCreate
 */
export function openNewAgentDialog(s, onCreate) {
  const spaceId = s.spaceId || (s.spaces[0] && s.spaces[0].id) || '';
  /** The space's current Main agent, if any. @param {string} sid */
  const mainOf = (sid) => s.entries.find((e) => e.agent.spaceId === sid && e.agent.role && e.agent.role.id === 'main');
  /** Default role: Main when the space has none yet, else Worker. @param {string} sid */
  const defaultRole = (sid) => (mainOf(sid) ? 'worker' : 'main');
  const spaceSel = /** @type {HTMLSelectElement} */ (h('select', { id: 'na-space', class: 'input' },
    s.spaces.map((sp) => h('option', { value: sp.id, selected: sp.id === spaceId }, sp.name))));
  const name = /** @type {HTMLInputElement} */ (h('input', { id: 'na-name', class: 'input', placeholder: suggestAgentName(s.entries, spaceId), autocomplete: 'off', spellcheck: 'false', maxlength: '60' }));
  let roleTouched = false;
  const rolePicker = createRolePicker({
    value: { id: defaultRole(spaceId) },
    mainHolder: () => { const m = mainOf(spaceSel.value); return m ? m.agent.name : null; },
    onChange: () => { roleTouched = true; },
  });
  spaceSel.addEventListener('change', () => {
    name.placeholder = suggestAgentName(s.entries, spaceSel.value);
    if (!roleTouched) rolePicker.select(defaultRole(spaceSel.value));
    else rolePicker.refreshNote();
  });
  const prompt = /** @type {HTMLTextAreaElement} */ (h('textarea', { id: 'na-prompt', class: 'input', rows: '4', placeholder: 'What should this agent do? (optional: you can also type in its terminal)' }));
  if (s.prompt) prompt.value = s.prompt;
  const model = segmented('model', [['', 'Default'], ['haiku', 'Haiku'], ['sonnet', 'Sonnet'], ['opus', 'Opus']], '');
  const mode = segmented('mode', [['', 'Ask'], ['acceptEdits', 'Accept edits'], ['plan', 'Plan']], '');
  const worktree = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: 'na-worktree', disabled: true }));
  const err = h('div', { class: 'form-error', role: 'alert' });
  const createBtn = /** @type {HTMLButtonElement} */ (h('button', { type: 'submit', class: 'btn primary', id: 'na-create' }, 'Start agent', kbd(s.mod, '↵')));

  const form = /** @type {HTMLFormElement} */ (h('form', { class: 'modal new-agent-modal', role: 'dialog', 'aria-label': 'New agent' },
    h('div', { class: 'modal-head' },
      h('span', { class: 'modal-icon' }, icon('bolt')),
      h('div', null, h('div', { class: 'modal-title' }, 'New agent'), h('div', { class: 'modal-sub' }, 'Starts a fresh Claude Code session in the space folder.')),
      h('button', { type: 'button', class: 'icon-btn modal-x', title: 'Close (Esc)', onclick: () => close() }, icon('close'))),
    h('div', { class: 'modal-body' },
      h('div', { class: 'field-row' },
        h('label', { class: 'field' }, h('span', { class: 'label' }, 'Space'), spaceSel),
        h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name'), name)),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'First prompt'), prompt),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Role'), rolePicker.el),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Model'), model),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Permissions'), mode,
        h('span', { class: 'hint' }, 'Ask: approve each tool. Accept edits: file edits go through. Plan: read-only planning.')),
      h('label', { class: 'check disabled', title: 'Available in milestone 3' }, worktree,
        h('span', null, 'Own git worktree'), h('span', { class: 'soon' }, 'coming soon')),
      s.warning || null, // v4: e.g. the 5-hour limit is nearly used up (components/usage.js limitWarning)
      err),
    h('div', { class: 'modal-foot' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, 'Cancel'),
      createBtn)));

  const submit = async () => {
    if (!spaceSel.value) { err.textContent = 'Add a space first.'; return; }
    const role = rolePicker.get();
    if (!role) { err.textContent = 'Give the custom role a label.'; return; }
    createBtn.disabled = true;
    err.textContent = '';
    try {
      await onCreate({
        // sent only when it differs from the default, which the core applies anyway
        ...(role.id !== defaultRole(spaceSel.value) ? { role } : {}),
        spaceId: spaceSel.value,
        name: name.value.trim() || name.placeholder,
        prompt: prompt.value.trim(),
        model: model.dataset.value || '',
        mode: mode.dataset.value || '',
        worktree: worktree.checked,
      });
      close();
    } catch (e) {
      err.textContent = /** @type {any} */ (e).message || 'Could not start the agent';
      createBtn.disabled = false;
    }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
  });
  const close = openModal('new-agent', form);
  prompt.focus();
  return close;
}

/**
 * Ctrl+K quick switcher across all spaces.
 * @param {{entries:any[], spaces:any[]}} s
 * @param {(id:string) => void} onPick
 */
export function openQuickSwitcher(s, onPick) {
  /** @type {Record<string, any>} */
  const byId = Object.fromEntries(s.spaces.map((sp) => [sp.id, sp]));
  const input = /** @type {HTMLInputElement} */ (h('input', { id: 'qs-input', class: 'qs-input', placeholder: 'Jump to an agent…', autocomplete: 'off', spellcheck: 'false' }));
  const list = h('ul', { class: 'qs-list', role: 'listbox' });
  let sel = 0;
  /** @type {any[]} */
  let results = [];

  const render = () => {
    results = filterAgents(input.value, s.entries, byId).slice(0, 50);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    list.replaceChildren(...(results.length ? results.map((e, i) => {
      const st = e.status ? e.status.state : 'stopped';
      const li = h('li', { class: `qs-item${i === sel ? ' sel' : ''}`, role: 'option', dataset: { agent: e.agent.id } },
        h('span', { class: `dot st-${st}` }),
        h('span', { class: 'qs-who' }, roleBadge(e.agent, { compact: true }), h('span', { class: 'qs-name' }, e.agent.name)),
        st === 'needs_you' ? h('span', { class: 'needs-badge' }, '◆ needs you') : h('span', { class: `qs-state st-${st}` }, stateLabel(st)),
        h('span', { class: 'qs-activity' }, describeActivity(e.status).replace(/^(Done|Stopped) · /, '')),
        h('span', { class: 'qs-space' }, (byId[e.agent.spaceId] || {}).name || e.agent.spaceId));
      li.addEventListener('mousemove', () => { if (sel !== i) { sel = i; render(); } });
      li.addEventListener('mousedown', (ev) => { ev.preventDefault(); pick(i); });
      return li;
    }) : [h('li', { class: 'qs-empty' }, 'No matching agents')]));
    const el = list.children[sel];
    if (el && /** @type {any} */ (el).scrollIntoView) /** @type {any} */ (el).scrollIntoView({ block: 'nearest' });
  };
  /** @param {number} i */
  const pick = (i) => {
    const e = results[i];
    if (!e) return;
    close();
    onPick(e.agent.id);
  };
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
  });

  const card = h('div', { class: 'modal quick-switcher', role: 'dialog', 'aria-label': 'Quick switcher' },
    h('div', { class: 'qs-bar' }, icon('search'), input, h('span', { class: 'kbd' }, h('kbd', null, 'Esc'))),
    list,
    h('div', { class: 'qs-foot' },
      h('span', null, h('kbd', null, '↑'), h('kbd', null, '↓'), ' move'),
      h('span', null, h('kbd', null, '↵'), ' open'),
      h('span', null, h('kbd', null, 'Esc'), ' close')));
  const close = openModal('quick-switch', card, { top: true });
  render();
  input.focus();
  return close;
}

/**
 * @param {string} text @param {'info'|'error'} [kind]
 */
export function toast(text, kind = 'info') {
  const box = document.getElementById('toasts');
  if (!box) return;
  const t = h('div', { class: `toast ${kind}` }, text);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 5000 : 2800);
}
