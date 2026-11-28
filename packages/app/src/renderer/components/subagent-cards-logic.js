// @ts-check
/**
 * Pure helpers of the subagent cards (M4 track C): ordering, folding finished ones, labels. No DOM.
 * Unit-tested in tests/unit/subagent-cards-logic.test.js.
 */
import { typeInfo, subagentTitle, stateInfo, formatDuration, subagentDuration, clip } from './activity-logic.js';
import { modelLabel } from '../logic.js';

/**
 * Split a session's subagents: `active` (running, needs-you first, then oldest first), `failed` (failed or stopped,
 * newest first; they stay visible) and `done` (finished fine; folded into "✓ N done").
 * @param {any[]} subs
 */
export function splitSubagents(subs) {
  const list = subs || [];
  const active = list.filter((s) => s.state === 'running')
    .sort((a, b) => (b.needsYou ? 1 : 0) - (a.needsYou ? 1 : 0) || (a.startedAt || 0) - (b.startedAt || 0));
  const failed = list.filter((s) => s.state === 'failed' || s.state === 'stopped').sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
  const done = list.filter((s) => s.state === 'done').sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
  return { active, failed, done };
}

/** The model to show: "Haiku 4.5", or '' when the subagent has none (the UI leaves it out). @param {{model?: string}} s */
export function subModelLabel(s) { return s && s.model ? modelLabel(s.model) : ''; }

/** What a running subagent is doing: "needs you", or its tool and detail. @param {any} s */
export function subDoing(s) {
  if (s.needsYou) return 'needs you';
  if (s.state === 'running' && s.tool) return s.detail ? `${s.tool} ${clip(s.detail, 28)}` : s.tool;
  return '';
}

/** The time on a card: running → since it started (ticks), finished → how long it took. @param {any} s @param {number} [now] */
export function subElapsed(s, now = Date.now()) {
  if (!s || !s.startedAt) return '';
  if (s.state === 'running') return formatDuration(Math.max(0, now - s.startedAt));
  return subagentDuration(s, now);
}

/** The accessible name of a card: everything the card shows, in a sentence. @param {any} s @param {number} [now] */
export function cardLabel(s, now = Date.now()) {
  const info = typeInfo(s.type);
  const parts = [`${info.label} subagent: ${subagentTitle(s)}`, stateInfo(s.state).label];
  const model = subModelLabel(s);
  if (model) parts.push(`model ${model}`);
  const doing = subDoing(s);
  if (doing) parts.push(s.needsYou ? 'needs you' : `using ${doing}`);
  const t = subElapsed(s, now);
  if (t) parts.push(t);
  return parts.join(', ');
}

/** A key that changes when the cards would look different (time excluded: it ticks on its own). @param {any[]} subs */
export function cardsKey(subs) {
  return (subs || []).map((s) => [s.id, s.title, s.type, s.model || '', s.state, s.tool || '', s.detail || '', s.needsYou ? 1 : 0, s.endedAt || 0].join('|')).join('~');
}

/** A summary line: "2 running · 1 needs you · ✓ 3 done · ✗ 1 failed". @param {any[]} subs */
export function summaryLine(subs) {
  const { active, failed, done } = splitSubagents(subs);
  const needs = active.filter((s) => s.needsYou).length;
  return [active.length ? `${active.length} running` : '', needs ? `${needs} needs you` : '', done.length ? `✓ ${done.length} done` : '', failed.length ? `✗ ${failed.length} failed` : ''].filter(Boolean).join(' · ');
}
