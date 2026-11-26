// @ts-check
/**
 * Session roles in the renderer: an exact copy of protocol.js ROLES (tests/unit/roles.test.js keeps
 * them equal) and the role badge every view uses (👑 Main, 🔧 Worker, ...). Owner: lead.
 */
import { h } from './dom.js';

export const ROLES = Object.freeze([
  Object.freeze({ id: 'main', label: 'Main', emoji: '👑' }),
  Object.freeze({ id: 'worker', label: 'Worker', emoji: '🔧' }),
  Object.freeze({ id: 'reviewer', label: 'Reviewer', emoji: '🔍' }),
  Object.freeze({ id: 'research', label: 'Research', emoji: '🔭' }),
  Object.freeze({ id: 'tests', label: 'Tests', emoji: '🧪' }),
  Object.freeze({ id: 'docs', label: 'Docs', emoji: '📝' }),
  Object.freeze({ id: 'debug', label: 'Debug', emoji: '🐛' }),
  Object.freeze({ id: 'design', label: 'Design', emoji: '🎨' }),
]);

/** The agent's role, falling back to Worker for agents from an older core. @param {any} agent */
export function roleOf(agent) {
  const r = agent && agent.role;
  if (r && typeof r.id === 'string' && typeof r.label === 'string') return r;
  return ROLES[1];
}

/** True for the space's Main session. @param {any} agent */
export const isMain = (agent) => roleOf(agent).id === 'main';

/**
 * The little role tab: "👑 Main". Colour comes from CSS (.role-<id>; custom roles use .role-custom).
 * @param {any} agent @param {{compact?: boolean}} [opts] compact: emoji only (label in the tooltip)
 */
export function roleBadge(agent, opts = {}) {
  const r = roleOf(agent);
  const known = ROLES.some((x) => x.id === r.id);
  return h('span', {
    class: `role-badge role-${known ? r.id : 'custom'}${opts.compact ? ' compact' : ''}`,
    title: `${r.emoji ? `${r.emoji} ` : ''}${r.label}`,
    dataset: { role: r.id },
  },
  r.emoji ? h('span', { class: 'role-emoji', 'aria-hidden': 'true' }, r.emoji) : null,
  opts.compact ? null : h('span', { class: 'role-label' }, r.label));
}
