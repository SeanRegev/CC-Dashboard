// @ts-check
/**
 * Pure helpers of the usage UI (meter, context gauge, Usage view). No DOM. Owner: track B (M4).
 */
import { formatTokens, contextPercent } from '../logic.js';

/** Percentage at which the meter turns amber / red. */
export const WARN_PCT = 75;
export const DANGER_PCT = 90;

/** @param {number} pct @returns {'low'|'mid'|'high'} */
export function limitLevel(pct) {
  if (pct >= DANGER_PCT) return 'high';
  if (pct >= WARN_PCT) return 'mid';
  return 'low';
}

/** Local "HH:MM". @param {number} ms */
export function clock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "$1.84", "<$0.01" for tiny non-zero amounts. @param {number|undefined} n */
export function formatCost(n) {
  if (!n || !(n > 0)) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

/**
 * Context gauge text: "98k / 1M (10%)". A transcript-source value is an estimate: "~98k / 1M (~10%)".
 * Without a known window: "98k (10%)". The percentage is the one the bar uses (contextPct).
 * @param {any} usage AgentUsage
 * @returns {{pct:number, text:string, title:string, estimate:boolean}}
 */
export function contextInfo(usage) {
  const pct = contextPercent(usage);
  const estimate = !!usage && usage.source === 'transcript';
  const tilde = estimate ? '~' : '';
  const win = usage && usage.contextWindow > 0 ? usage.contextWindow : 0;
  const used = formatTokens(usage && usage.context);
  const text = win ? `${tilde}${used} / ${formatTokens(win)} (${tilde}${pct}%)` : `${tilde}${used} (${tilde}${pct}%)`;
  const title = `Context window ${pct}% full${win ? `: ${formatTokens(usage.context)} of ${formatTokens(win)} tokens` : ''}${estimate ? ' (estimate from the transcript)' : ''}`;
  return { pct, text, title, estimate };
}

/**
 * One limit window as the meter shows it. A window whose reset time has passed is not shown with its old %.
 * @param {{usedPct:number, resetsAt:number}|undefined} win
 * @param {number} now
 * @returns {{pct:number, level:'low'|'mid'|'high', reset:boolean, resetsAt:number}|null}
 */
export function windowView(win, now) {
  if (!win || typeof win.usedPct !== 'number' || !Number.isFinite(win.usedPct)) return null;
  const reset = typeof win.resetsAt === 'number' && win.resetsAt > 0 && win.resetsAt <= now;
  const pct = Math.max(0, Math.min(100, Math.round(win.usedPct)));
  return { pct, level: reset ? 'low' : limitLevel(pct), reset, resetsAt: win.resetsAt };
}

/**
 * The top-bar meter. null when no limits are known.
 * @param {any} usage Usage
 * @param {number} now
 * @param {(agentId:string)=>string|undefined} [nameOf]
 * @returns {{text:string, short:string, shortFive:string, shortWeek:string, level:'low'|'mid'|'high', title:string, five:ReturnType<typeof windowView>, week:ReturnType<typeof windowView>}|null}
 */
export function meterModel(usage, now, nameOf) {
  const lim = usage && usage.limits;
  if (!lim || !lim.updatedAt) return null;
  const five = windowView(lim.fiveHour, now);
  const week = windowView(lim.sevenDay, now);
  if (!five && !week) return null;
  const parts = [];
  if (five) parts.push(five.reset ? '5h reset' : `5h ${five.pct}% · resets ${clock(five.resetsAt)}`);
  if (week) parts.push(week.reset ? 'week reset' : `week ${week.pct}%`);
  const text = parts.join(' / ');
  const levels = ['low', 'mid', 'high'];
  const level = /** @type {'low'|'mid'|'high'} */ (levels[Math.max(levels.indexOf(five ? five.level : 'low'), levels.indexOf(week ? week.level : 'low'))]);
  const who = lim.fromAgentId && nameOf ? nameOf(lim.fromAgentId) : '';
  const title = `Claude usage limits, as of ${clock(lim.updatedAt)}${who ? ` (reported by ${who})` : ''}`;
  const shortFive = five ? (five.reset ? '5h reset' : `5h ${five.pct}%`) : '';
  const shortWeek = week ? (week.reset ? 'wk reset' : `wk ${week.pct}%`) : '';
  const short = [shortFive, shortWeek].filter(Boolean).join(' / ');
  return { text, short, shortFive, shortWeek, level, title, five, week };
}

/**
 * Warning for the New agent dialog, or null.
 * @param {any} usage Usage
 * @param {number} now
 * @returns {string|null}
 */
export function limitWarningText(usage, now) {
  const lim = usage && usage.limits;
  const five = lim && lim.updatedAt ? windowView(lim.fiveHour, now) : null;
  if (!five || five.reset || five.pct < DANGER_PCT) return null;
  return `The 5-hour limit is ${five.pct}% used${five.resetsAt ? ` (resets ${clock(five.resetsAt)})` : ''}. A new agent may be rate limited.`;
}

/**
 * Rows of a totals map, biggest cost first. byDay sorts newest first instead.
 * @param {Record<string, any>|undefined} map
 * @param {{byKey?:boolean, label?:(key:string, t:any)=>string}} [opts]
 * @returns {Array<{key:string, label:string, costUsd:number, inputTokens:number, outputTokens:number}>}
 */
export function totalsRows(map, opts = {}) {
  const rows = Object.entries(map || {}).map(([key, t]) => ({
    key,
    label: opts.label ? opts.label(key, t || {}) : key,
    costUsd: (t && t.costUsd) || 0,
    inputTokens: (t && t.inputTokens) || 0,
    outputTokens: (t && t.outputTokens) || 0,
  }));
  rows.sort(opts.byKey ? (a, b) => (a.key < b.key ? 1 : -1) : (a, b) => b.costUsd - a.costUsd || (a.label < b.label ? -1 : 1));
  return rows;
}

/** @param {Array<{costUsd:number}>} rows */
export function maxCost(rows) {
  return rows.reduce((m, r) => Math.max(m, r.costUsd), 0);
}

/** "2026-11-28" -> "Sat 28 Nov". Falls back to the key. @param {string} key */
export function dayLabel(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]}`;
}
