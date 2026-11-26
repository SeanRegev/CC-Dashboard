// @ts-check
/**
 * Inbox view. Owner: the Approvals track (M2). Every agent waiting on you, across every space,
 * longest-waiting first, with Allow / Always / Deny for permission prompts and Open for the rest.
 *
 * Keyboard while the Inbox is shown (and focus is not in a text field or a terminal):
 *   J / ↓ next, K / ↑ previous, A allow, S always, D deny, Enter open.
 * Keys act on the prompt as it was last drawn, never on one the user hasn't seen yet.
 */
import { h, icon, kbd } from '../dom.js';
import { sortAgents, formatRelativeTime } from '../logic.js';
import { roleBadge } from '../roles.js';
import { externalInboxRow } from '../components/external.js';
import { approvalButtons, readablePrompt, optionOf, toolLabel, answerPrompt } from '../components/approval.js';

/** Agents waiting on you, longest-waiting first. @param {Iterable<any>} entries */
export function waitingEntries(entries) {
  return sortAgents([...entries].filter((e) => e.status && e.status.state === 'needs_you'));
}

/** @param {EventTarget|null} t */
function inTextField(t) {
  const el = /** @type {HTMLElement|null} */ (t instanceof HTMLElement ? t : null);
  if (!el) return false;
  if (el.closest('.term-slot, .xterm')) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** @param {import('../context.js').ViewContext} ctx @returns {import('../context.js').View} */
export function createInboxView(ctx) {
  /** @type {string|null} */
  let selId = null;
  let selIndex = 0;
  /** Rows as last drawn: what the keyboard acts on. @type {Array<{id: string, prompt: any}>} */
  let drawn = [];
  let shown = false;

  const count = h('span', { class: 'inbox-count' });
  const list = h('div', { class: 'inbox-list', role: 'listbox', tabindex: '-1', 'aria-label': 'Agents waiting on you' });
  const el = h('section', { class: 'view view-inbox', dataset: { view: 'inbox' } },
    h('header', { class: 'inbox-head' },
      h('h2', { class: 'inbox-title' }, 'Inbox'), count,
      h('span', { class: 'grow' }),
      h('span', { class: 'inbox-keys' },
        kbd('J'), kbd('K'), h('span', null, 'move'), kbd('A'), h('span', null, 'allow'), kbd('S'), h('span', null, 'always'),
        kbd('D'), h('span', null, 'deny'), kbd('Enter'), h('span', null, 'open'))),
    list);

  /** @param {any} e @param {boolean} selected */
  function row(e, selected) {
    const id = e.agent.id;
    const st = e.status;
    const p = readablePrompt(st);
    const waited = formatRelativeTime(st.needsSince || st.updatedAt);
    const ask = p
      ? h('div', { class: 'inbox-ask', title: `${p.tool}: ${p.detail}\n${p.question}` },
        h('span', { class: 'inbox-tool' }, toolLabel(p.tool)),
        p.detail ? h('code', { class: 'inbox-detail' }, p.detail) : null,
        h('span', { class: 'inbox-question' }, p.question))
      : h('div', { class: 'inbox-ask' }, h('span', { class: 'inbox-message' }, st.message || 'Waiting for your input'),
        st.permission ? h('span', { class: 'inbox-question' }, 'Answer it in the terminal') : null);
    return h('div', {
      class: `inbox-row${selected ? ' sel' : ''}`, role: 'option', 'aria-selected': String(selected),
      dataset: { agent: id, prompt: p ? p.id : '' },
      onclick: (/** @type {MouseEvent} */ ev) => {
        if ((/** @type {HTMLElement} */ (ev.target)).closest('button')) return;
        selId = id;
        ctx.render();
      },
      ondblclick: (/** @type {MouseEvent} */ ev) => { if (!(/** @type {HTMLElement} */ (ev.target)).closest('button')) ctx.openAgent(id); },
    },
    h('div', { class: 'inbox-main' },
      h('div', { class: 'inbox-line' },
        roleBadge(e.agent),
        h('span', { class: 'inbox-name' }, e.agent.name),
        h('span', { class: 'inbox-space' }, ctx.spaceName(e.agent.spaceId)),
        h('span', { class: 'grow' }),
        h('span', { class: 'inbox-wait', title: st.needsSince ? `Waiting since ${new Date(st.needsSince).toLocaleTimeString()}` : '' },
          waited === 'now' ? 'just now' : `waiting ${waited}`)),
      ask),
    h('div', { class: 'inbox-actions' },
      p ? approvalButtons(ctx, e, { showWhat: false }) : null,
      h('button', { class: `btn small ${p ? 'ghost' : 'primary'} inbox-open`, title: 'Open the terminal (Enter)', onclick: () => ctx.openAgent(id) }, icon('terminal'), 'Open')));
  }

  function update() {
    const items = waitingEntries(ctx.state().entries.values());
    // M3 Outside UI: outside sessions that wait for you (view only, not part of the keyboard selection)
    const outside = ctx.state().external.filter((/** @type {any} */ x) => x.state === 'needs_you');
    let i = selId ? items.findIndex((e) => e.agent.id === selId) : -1;
    // The selected one was answered: keep the place in the list.
    if (i < 0) i = Math.min(selIndex, items.length - 1);
    selIndex = Math.max(0, i);
    selId = items[selIndex] ? items[selIndex].agent.id : null;
    count.textContent = items.length + outside.length ? String(items.length + outside.length) : '';
    drawn = items.map((e) => ({ id: e.agent.id, prompt: readablePrompt(e.status) }));
    const hadFocus = el.contains(document.activeElement);
    if (!items.length && !outside.length) {
      list.replaceChildren(h('div', { class: 'inbox-empty' },
        h('div', { class: 'empty-title' }, 'Nothing needs you'),
        h('div', { class: 'empty-sub' }, 'Agents waiting for an answer, in any space, show up here.')));
    } else {
      list.replaceChildren(...items.map((e, j) => row(e, j === selIndex)), ...outside.map((x) => externalInboxRow(ctx, x)));
      const sel = /** @type {HTMLElement|null} */ (list.querySelector('.inbox-row.sel'));
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
    }
    if (hadFocus && !el.contains(document.activeElement)) list.focus({ preventScroll: true });
  }

  /** @param {number} delta */
  function move(delta) {
    if (!drawn.length) return;
    selIndex = Math.max(0, Math.min(drawn.length - 1, selIndex + delta));
    selId = drawn[selIndex].id;
    update();
  }

  /** @param {'allow'|'allow_always'|'deny'} choice */
  function act(choice) {
    const cur = drawn[selIndex];
    if (!cur) return;
    if (!cur.prompt) { ctx.toast('Open it to answer in the terminal (Enter)'); return; }
    if (choice !== 'deny' && !optionOf(cur.prompt, choice)) {
      ctx.toast(choice === 'allow_always' ? 'This prompt has no "don\'t ask again" option' : 'This prompt has no "Yes" option');
      return;
    }
    answerPrompt(ctx, cur.id, cur.prompt, choice);
  }

  window.addEventListener('keydown', (ev) => {
    if (!shown || el.hidden || ctx.state().view !== 'inbox') return;
    if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.defaultPrevented) return;
    if (document.querySelector('[data-modal]') || inTextField(ev.target)) return;
    const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    const onButton = ev.target instanceof HTMLElement && !!ev.target.closest('button');
    /** @type {null|(() => void)} */
    let fn = null;
    if (key === 'j' || key === 'ArrowDown') fn = () => move(1);
    else if (key === 'k' || key === 'ArrowUp') fn = () => move(-1);
    else if (key === 'a') fn = () => act('allow');
    else if (key === 's') fn = () => act('allow_always');
    else if (key === 'd') fn = () => act('deny');
    else if (key === 'Enter' && !onButton) fn = () => { const cur = drawn[selIndex]; if (cur) ctx.openAgent(cur.id); };
    if (!fn) return;
    ev.preventDefault();
    fn();
  });

  return {
    el,
    update,
    show() {
      shown = true;
      update();
      // Keys must not go to a terminal that was focused before (it is hidden now).
      list.focus({ preventScroll: true });
    },
    hide() { shown = false; },
  };
}
