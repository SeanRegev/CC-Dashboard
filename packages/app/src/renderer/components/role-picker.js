// @ts-check
/**
 * Role picker: the 8 built-in roles as chips with their emoji, plus Custom (label + emoji).
 * Used by the New agent dialog and the agent edit dialog. Styles: views/settings.css. Owner: Settings track.
 */
import { h } from '../dom.js';
import { ROLES } from '../roles.js';

export const CUSTOM_LABEL_MAX = 24;

/**
 * @param {{
 *   value: {id: string, label?: string, emoji?: string},
 *   mainHolder?: () => string|null,
 *   onChange?: () => void,
 * }} o  mainHolder: name of the agent that is Main now (not the one being edited), for the "Moves 👑 Main from …" note
 */
export function createRolePicker(o) {
  let id = o.value.id;
  const known = ROLES.some((r) => r.id === id);
  if (!known) id = 'custom';
  const label = /** @type {HTMLInputElement} */ (h('input', { class: 'input', id: 'role-custom-label', placeholder: 'Label, e.g. Release', maxlength: String(CUSTOM_LABEL_MAX), autocomplete: 'off', spellcheck: 'false' }));
  const emoji = /** @type {HTMLInputElement} */ (h('input', { class: 'input emoji-input', id: 'role-custom-emoji', placeholder: '🚀', maxlength: '8', autocomplete: 'off' }));
  if (id === 'custom') { label.value = o.value.label || ''; emoji.value = o.value.emoji || ''; }
  const custom = h('div', { class: 'role-custom-fields' },
    h('label', { class: 'field grow' }, h('span', { class: 'label' }, 'Custom label'), label),
    h('label', { class: 'field emoji-field' }, h('span', { class: 'label' }, 'Emoji'), emoji));
  const note = h('div', { class: 'hint role-note', role: 'status' });
  const wrap = h('div', { class: 'role-picker', role: 'radiogroup', 'aria-label': 'Role' });
  const chips = h('div', { class: 'role-chips' });
  wrap.append(chips, custom, note);

  /** @type {Array<[string, HTMLElement]>} */
  const buttons = [];
  /** @param {string} rid @param {string} emo @param {string} text */
  const chip = (rid, emo, text) => {
    const b = h('button', { type: 'button', class: 'role-chip', role: 'radio', dataset: { role: rid } },
      h('span', { class: 'role-chip-emoji', 'aria-hidden': 'true' }, emo), text);
    b.addEventListener('click', () => { set(rid); o.onChange && o.onChange(); if (rid === 'custom') label.focus(); });
    buttons.push([rid, b]);
    chips.append(b);
  };
  for (const r of ROLES) chip(r.id, r.emoji, r.label);
  chip('custom', '✨', 'Custom');
  label.addEventListener('input', () => o.onChange && o.onChange());
  emoji.addEventListener('input', () => o.onChange && o.onChange());

  /** @param {string} rid */
  function set(rid) {
    id = rid;
    for (const [k, b] of buttons) { b.classList.toggle('on', k === id); b.setAttribute('aria-checked', String(k === id)); }
    custom.hidden = id !== 'custom';
    refreshNote();
  }
  function refreshNote() {
    const from = id === 'main' && o.mainHolder ? o.mainHolder() : null;
    note.textContent = from ? `Moves 👑 Main from ${from} to this agent` : '';
    note.hidden = !from;
  }
  set(id);

  return {
    el: wrap,
    refreshNote,
    /** The chosen role as the protocol wants it, or null while a custom role has no label. @returns {{id:string,label:string,emoji:string}|null} */
    get() {
      if (id === 'custom') {
        const l = label.value.trim().slice(0, CUSTOM_LABEL_MAX);
        return l ? { id: 'custom', label: l, emoji: emoji.value.trim() } : null;
      }
      const r = /** @type {any} */ (ROLES.find((x) => x.id === id));
      return { id: r.id, label: r.label, emoji: r.emoji };
    },
    get id() { return id; },
    /** @param {string} rid */
    select: set,
  };
}
