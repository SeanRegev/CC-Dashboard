// @ts-check
/**
 * Usage pieces shown outside the Usage view (contract v4). Owner: track B (M4).
 * app.js (lead) mounts them; this file decides what they show.
 *
 *   usageMeter(ctx)     top bar: "5h 62% · resets 16:20 / week 31%" (null while no limits are known)
 *   contextGauge(usage) pane footer: the context bar + its text
 *   limitWarning(ctx)   New agent dialog: a warning when the 5-hour limit is at 90% or more (else null)
 *
 * ctx.usage() is the latest Usage (protocol.js), or null before the first usage.get.
 * Wave 0 stubs: the meter and the warning show nothing; the gauge is the 0.3 one.
 */
import { h } from '../dom.js';
import { contextPercent, gaugeLevel } from '../logic.js';

/** @param {import('../context.js').ViewContext} ctx @returns {HTMLElement|null} */
export function usageMeter(ctx) {
  void ctx;
  return null;
}

/** @param {any} usage AgentStatus.usage @returns {HTMLElement} */
export function contextGauge(usage) {
  const pct = contextPercent(usage);
  return h('span', { class: 'foot-item gauge', title: `Context window ${pct}% full` },
    h('span', { class: 'gauge-label' }, 'Context'),
    h('span', { class: `gauge-bar lvl-${gaugeLevel(pct)}` }, h('span', { class: 'gauge-fill', style: { width: `${pct}%` } })),
    h('span', { class: 'gauge-pct' }, `${pct}%`));
}

/** @param {import('../context.js').ViewContext} ctx @returns {HTMLElement|null} */
export function limitWarning(ctx) {
  void ctx;
  return null;
}
