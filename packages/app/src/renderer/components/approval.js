// @ts-check
/**
 * Allow / Always / Deny for an agent waiting on a permission prompt (status.prompt, protocol v2).
 * Owner: the Approvals track (M2). Placed on sidebar agent cards (compact), the pane header, the
 * Inbox and (Layouts) grid tiles and board cards.
 *
 * Safety rules (see protocol.js agents.approve):
 *  - every answer sends promptId = the prompt the user is looking at, and a choice by kind
 *    ('allow' | 'allow_always'); never a raw key. The core refuses if the screen changed;
 *  - on prompt_changed: tell the user, and let the new status render;
 *  - no status.prompt (a prompt the core can't read): only "Open", never a guess;
 *  - one answer in flight per agent (no double press).
 */
import { h, icon } from '../dom.js';

/** agentId → promptId of the answer in flight. Module-level: buttons are rebuilt on every render. */
const inFlight = new Map();

/**
 * status.prompt if it is usable: an id and options that each have a key, a label and a known kind.
 * @param {any} status @returns {null|{id:string, tool:string, detail:string, question:string, options:Array<{key:string, label:string, kind:string}>}}
 */
export function readablePrompt(status) {
  const p = status && status.state === 'needs_you' && status.permission ? status.prompt : null;
  if (!p || typeof p.id !== 'string' || !p.id || !Array.isArray(p.options)) return null;
  const kinds = ['allow', 'allow_always', 'allow_other', 'deny'];
  if (!p.options.every((/** @type {any} */ o) => o && typeof o.key === 'string' && typeof o.label === 'string' && kinds.includes(o.kind))) return null;
  return p;
}

/** The single option of a kind, or null. @param {any} prompt @param {string} kind */
export function optionOf(prompt, kind) {
  const list = prompt ? prompt.options.filter((/** @type {any} */ o) => o.kind === kind) : [];
  return list.length === 1 ? list[0] : null;
}

/** "mcp__github__create_issue" → "github · create_issue"; others unchanged. @param {string} tool */
export function toolLabel(tool) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(tool || ''));
  return m ? `${m[1]} · ${m[2]}` : String(tool || 'Tool');
}

/** Is an answer for this agent on its way to the core? @param {string} id */
export const answering = (id) => inFlight.has(id);

/**
 * Answer the prompt the user saw. Resolves true when the core accepted it.
 * @param {import('../context.js').ViewContext} ctx @param {string} id
 * @param {{id: string}} prompt  the prompt as rendered (its id is what the user agreed to)
 * @param {'allow'|'allow_always'|'deny'} choice
 */
export async function answerPrompt(ctx, id, prompt, choice) {
  if (inFlight.has(id) || !prompt || !prompt.id) return false;
  inFlight.set(id, prompt.id);
  ctx.render();
  try {
    if (choice === 'deny') await ctx.client.call('agents.deny', { id, promptId: prompt.id });
    else await ctx.client.call('agents.approve', { id, promptId: prompt.id, choice });
    return true;
  } catch (e) {
    const err = /** @type {any} */ (e);
    if (err && err.code === 'prompt_changed') ctx.toast('The prompt changed: check it again');
    else if (err && err.code === 'no_permission_pending') ctx.toast('It is not waiting for that any more');
    else ctx.toast(`Could not answer: ${err && err.message ? err.message : err}`, 'error');
    return false;
  } finally {
    inFlight.delete(id);
    ctx.render();
  }
}

/**
 * @param {import('../context.js').ViewContext} ctx
 * @param {{agent:any, status:any, running:boolean}} entry
 * @param {{compact?: boolean, showWhat?: boolean}} [opts]  compact: sidebar cards and tiles;
 *   showWhat: false hides the tool + detail line (the Inbox shows it itself)
 * @returns {HTMLElement|null}
 */
export function approvalButtons(ctx, entry, opts = {}) {
  const st = entry && entry.status;
  if (!st || st.state !== 'needs_you' || !st.permission) return null;
  const id = entry.agent.id;
  const compact = !!opts.compact;
  const p = readablePrompt(st);
  // Clicks here must not reach the sidebar card (a div acting as a button) and open the agent.
  const box = h('div', {
    class: `approval${compact ? ' compact' : ''}${p ? '' : ' unreadable'}`,
    dataset: { agent: id, prompt: p ? p.id : '' },
    onclick: (/** @type {Event} */ ev) => ev.stopPropagation(),
  });
  if (!p) {
    box.append(
      h('span', { class: 'appr-what muted', title: 'CC-Dashboard could not read this prompt. Answer it in the terminal.' }, 'Answer in the terminal'),
      h('button', { class: 'btn small appr-open', title: 'Open the terminal to answer', onclick: () => ctx.openAgent(id) }, icon('terminal'), 'Open'));
    return box;
  }
  const allow = optionOf(p, 'allow');
  const always = optionOf(p, 'allow_always');
  const deny = optionOf(p, 'deny') || p.options.find((/** @type {any} */ o) => o.kind === 'deny');
  const busy = inFlight.has(id);
  const what = `${toolLabel(p.tool)}${p.detail ? ` · ${p.detail}` : ''}`;
  if (opts.showWhat !== false) {
    box.append(h('span', { class: 'appr-what', title: `${p.tool}: ${p.detail}\n${p.question}` },
      h('span', { class: 'appr-tool' }, toolLabel(p.tool)), p.detail ? h('code', { class: 'appr-detail' }, p.detail) : null));
  }
  const buttons = [
    allow ? h('button', {
      class: 'btn small appr-btn appr-allow', disabled: busy, dataset: { choice: 'allow' },
      title: `"${allow.label}": ${what}`,
      onclick: () => answerPrompt(ctx, id, p, 'allow'),
    }, 'Allow') : null,
    always ? h('button', {
      class: 'btn small appr-btn appr-always', disabled: busy, dataset: { choice: 'allow_always' },
      title: always.label,
      onclick: () => answerPrompt(ctx, id, p, 'allow_always'),
    }, 'Always') : null,
    h('button', {
      class: 'btn small appr-btn appr-deny', disabled: busy, dataset: { choice: 'deny' },
      title: `Esc${deny ? `: ${deny.label}` : ''}`,
      onclick: () => answerPrompt(ctx, id, p, 'deny'),
    }, 'Deny'),
  ];
  for (const b of buttons) if (b) box.append(b); // (DOM append() would print a null as "null")
  return box;
}

/** Last needs-you count sent to the main process (taskbar badge, window flash). */
let attentionSent = -1;

/**
 * Tell the main process how many agents need you, when that number changes.
 * Called from app.js renderChrome on every render.
 * @param {import('../context.js').ViewContext} ctx @returns {number}
 */
export function updateAttention(ctx) {
  let n = 0;
  for (const e of ctx.state().entries.values()) if (e.status && e.status.state === 'needs_you') n++;
  if (n !== attentionSent && ctx.bridge && typeof ctx.bridge.setAttention === 'function') {
    attentionSent = n;
    try { Promise.resolve(ctx.bridge.setAttention(n)).catch(() => {}); } catch { /* no main process (browser dev) */ }
  }
  return n;
}
