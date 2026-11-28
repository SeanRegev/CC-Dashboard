// @ts-check
/**
 * Usage pieces shown outside the Usage view (contract v4). Owner: track B (M4).
 * app.js (lead) mounts them; this file decides what they show.
 *
 *   usageMeter(ctx)     top bar: "5h 62% · resets 16:20 / week 31%" (null while no limits are known)
 *   contextGauge(usage) pane footer: the context bar + its text ("98k / 1M (10%)")
 *   limitWarning(ctx)   New agent dialog: a warning when the 5-hour limit is at 90% or more (else null)
 *
 * ctx.usage() is the latest Usage (protocol.js), or null before the first usage.get.
 */
import { h } from '../dom.js';
import { gaugeLevel } from '../logic.js';
import { contextInfo, meterModel, limitWarningText } from './usage-logic.js';

/** @param {import('../context.js').ViewContext} ctx @returns {(id:string)=>string|undefined} */
function nameLookup(ctx) {
  return (id) => {
    const e = ctx.state().entries.get(id);
    return e ? e.agent.name : undefined;
  };
}

/** @param {import('../context.js').ViewContext} ctx @returns {HTMLElement|null} */
export function usageMeter(ctx) {
  const m = meterModel(ctx.usage(), Date.now(), nameLookup(ctx));
  if (!m) return null;
  return h('span', { class: `usage-meter lvl-${m.level}`, id: 'usage-meter', title: m.title, 'aria-label': `${m.title}: ${m.text}` },
    h('span', { class: 'um-full' }, m.text),
    h('span', { class: 'um-short' }, m.shortFive || m.shortWeek, m.shortFive && m.shortWeek ? h('span', { class: 'um-wk' }, ` / ${m.shortWeek}`) : null));
}

/**
 * Context gauge pieces shared by the pane footer, grid tiles and board cards.
 * @param {any} usage AgentUsage
 * @returns {{pct:number, text:string, title:string, level:string, estimate:boolean}}
 */
export function gaugeData(usage) {
  const c = contextInfo(usage);
  return { ...c, level: gaugeLevel(c.pct) };
}

/** @param {any} usage AgentUsage @returns {HTMLElement} */
export function contextGauge(usage) {
  const g = gaugeData(usage);
  return h('span', { class: 'foot-item gauge', title: g.title },
    h('span', { class: 'gauge-label' }, 'Context'),
    h('span', { class: `gauge-bar lvl-${g.level}` }, h('span', { class: 'gauge-fill', style: { width: `${g.pct}%` } })),
    h('span', { class: 'gauge-pct gauge-text' }, g.text));
}

/** @param {import('../context.js').ViewContext} ctx @returns {HTMLElement|null} */
export function limitWarning(ctx) {
  const text = limitWarningText(ctx.usage(), Date.now());
  if (!text) return null;
  return h('div', { class: 'limit-warning', role: 'alert' }, h('span', { class: 'limit-warning-mark', 'aria-hidden': 'true' }, '!'), h('span', { class: 'limit-warning-text' }, text));
}
