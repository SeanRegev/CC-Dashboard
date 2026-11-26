// @ts-check
/** Left sidebar: quick-switch button, spaces with counts, agents of the current space. */
import { h, mount, icon, kbd } from '../dom.js';
import { sortAgents, spaceCounts, describeActivity, cardTime, stateLabel, groupBySpace } from '../logic.js';
import { roleBadge } from '../roles.js';
import { approvalButtons } from '../components/approval.js';
import { attachAgentMenu } from '../components/agent-menu.js';
import { subagentBadge } from '../components/activity.js';

const ALL_KEY = 'cc.sidebar.allSpaces';
/** "All spaces" mode of the Agents list: a per-viewer convenience, kept in localStorage. */
let allSpaces = (() => { try { return localStorage.getItem(ALL_KEY) === '1'; } catch { return false; } })();
/** @param {boolean} on */
function setAllSpaces(on) { allSpaces = on; try { localStorage.setItem(ALL_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ } }

/**
 * @param {HTMLElement} root
 * @param {{
 *   spaces: any[], entries: any[], currentSpace: string|null, visible: Set<string>, openTabs: Set<string>,
 *   conn: string, version: string, mod: string, view?: string,
 * }} s
 * @param {{
 *   selectSpace: (id:string) => void, addSpace: () => void, openAgent: (id:string) => void,
 *   newAgent: () => void, quickSwitch: () => void,
 * }} act
 * @param {import('../context.js').ViewContext} [ctx]  for shared components (approval buttons)
 */
export function renderSidebar(root, s, act, ctx) {
  const counts = spaceCounts(s.entries);
  const space = s.spaces.find((x) => x.id === s.currentSpace) || null;
  const agents = sortAgents(s.entries.filter((e) => e.agent.spaceId === s.currentSpace));
  const groups = allSpaces ? groupBySpace(s.entries, s.spaces) : [];
  const shownCount = allSpaces ? s.entries.length : agents.length;
  const scrollTop = root.querySelector('.agent-list')?.scrollTop || 0;

  const spaceItems = s.spaces.map((sp) => {
    const c = counts[sp.id] || { total: 0, needs: 0, working: 0 };
    return h('li', null, h('button', {
      class: `space${sp.id === s.currentSpace ? ' active' : ''}`,
      title: sp.path,
      dataset: { space: sp.id },
      onclick: () => act.selectSpace(sp.id),
    },
    h('span', { class: 'space-icon', style: { '--hue': String(hueFor(sp.id)) } }, (sp.name || '?').slice(0, 1).toUpperCase()),
    h('span', { class: 'space-name' }, sp.name),
    c.needs ? h('span', { class: 'space-needs', title: `${c.needs} need${c.needs === 1 ? 's' : ''} you` }, `◆ ${c.needs}`) : null,
    h('span', { class: 'space-count', title: `${c.total} agent${c.total === 1 ? '' : 's'}` }, String(c.total))));
  });

  /** @param {any} e */
  const card = (e) => {
    const st = e.status ? e.status.state : 'stopped';
    const id = e.agent.id;
    // A div acting as a button, not a <button>: it holds real buttons (Allow / Deny), and buttons can't nest.
    const el = h('div', {
      class: `agent-card st-${st}${s.visible.has(id) ? ' visible' : ''}${s.openTabs.has(id) ? ' open' : ''}`,
      role: 'button', tabindex: '0',
      dataset: { agent: id, state: st },
      title: `${e.agent.name} · ${stateLabel(st)}`,
      onclick: (/** @type {MouseEvent} */ ev) => { if (!(/** @type {HTMLElement} */ (ev.target)).closest('button')) act.openAgent(id); },
      onkeydown: (/** @type {KeyboardEvent} */ ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === ev.currentTarget) { ev.preventDefault(); act.openAgent(id); } },
    },
    // line 1: the name gets all the room it needs
    h('span', { class: 'card-row' },
      h('span', { class: `dot st-${st}`, 'aria-label': stateLabel(st) }),
      h('span', { class: 'agent-name' }, e.agent.name),
      h('span', { class: 'card-time' }, cardTime(e.status))),
    // line 2: role tab, needs badge, activity
    h('span', { class: 'card-meta' },
      roleBadge(e.agent),
      st === 'needs_you' ? h('span', { class: 'needs-badge' }, '◆ needs you') : null,
      ctx ? subagentBadge(ctx, id, e.status) : null, // M3 Activity UI
      h('span', { class: 'card-activity', title: describeActivity(e.status) }, describeActivity(e.status))),
    ctx ? approvalButtons(ctx, e, { compact: true }) : null);
    if (ctx) attachAgentMenu(el, ctx, id);
    return h('li', null, el);
  };
  const cards = agents.map(card);
  const groupedItems = groups.map((g) => h('li', { class: 'agent-group', dataset: { space: g.space.id } },
    h('div', { class: 'group-head' }, h('span', { class: 'group-name' }, g.space.name), h('span', { class: 'group-count' }, String(g.entries.length))),
    h('ul', { class: 'agent-group-list' }, g.entries.map(card))));

  const connLabel = s.conn === 'open' ? 'Core connected' : s.conn === 'connecting' ? 'Connecting to core…' : 'Core offline';

  mount(root,
    h('button', { class: 'jump', onclick: act.quickSwitch, title: 'Jump to an agent' },
      icon('search'), h('span', { class: 'jump-label' }, 'Jump to agent…'), kbd(s.mod, 'K')),

    h('section', { class: 'sb-section sb-spaces' },
      h('div', { class: 'sb-head' },
        h('span', { class: 'sb-title' }, 'Spaces'),
        h('button', { class: 'sb-head-btn', id: 'add-space', title: 'Add a project folder', onclick: act.addSpace }, icon('plus'), 'Add space')),
      s.spaces.length
        ? h('ul', { class: 'space-list' }, spaceItems)
        : h('button', { class: 'sb-empty', onclick: act.addSpace }, icon('folder'), h('span', null, 'Add a project folder to start')),
    ),

    h('section', { class: 'sb-section sb-agents' },
      h('div', { class: 'sb-head' },
        h('span', { class: 'sb-title' }, 'Agents'),
        h('span', { class: 'sb-sub' }, allSpaces ? `${shownCount} in ${s.spaces.length} space${s.spaces.length === 1 ? '' : 's'}` : space ? `${agents.length} in ${space.name}` : '')),

      h('div', { class: 'seg-mini', role: 'group', 'aria-label': 'Which agents to list' },
          h('button', { class: allSpaces ? '' : 'on', type: 'button', id: 'agents-this-space', 'aria-pressed': String(!allSpaces), title: 'Agents of the selected space', onclick: () => { setAllSpaces(false); ctx ? ctx.render() : null; } }, 'This space'),
          h('button', { class: allSpaces ? 'on' : '', type: 'button', id: 'agents-all-spaces', 'aria-pressed': String(allSpaces), title: 'Every agent, grouped by space, needs-you first', onclick: () => { setAllSpaces(true); ctx ? ctx.render() : null; } }, 'All spaces')),
      h('button', { class: 'new-agent', id: 'new-agent', onclick: act.newAgent, disabled: !s.spaces.length },
        icon('plus'), h('span', null, 'New agent'), kbd(s.mod, 'T')),
      allSpaces && groups.length
        ? h('ul', { class: 'agent-list grouped' }, groupedItems)
        : !allSpaces && agents.length
        ? h('ul', { class: 'agent-list' }, cards)
        : h('div', { class: 'sb-hint' }, allSpaces ? 'No agents yet.' : space ? 'No agents in this space yet.' : s.spaces.length ? 'Pick a space to see its agents.' : 'No spaces yet.'),
    ),

    h('footer', { class: 'sb-foot' },
      h('span', { class: `conn-dot conn-${s.conn}` }),
      h('span', { class: 'sb-foot-label' }, connLabel),
      s.version && s.conn === 'open' ? h('span', { class: 'sb-foot-ver' }, `v${s.version.replace(/^v/, '')}`) : null),
  );
  const list = root.querySelector('.agent-list');
  if (list) list.scrollTop = scrollTop;
}

/** Stable hue per space id for its initial badge. @param {string} id */
export function hueFor(id) {
  let x = 0;
  for (const ch of id) x = (x * 33 + ch.charCodeAt(0)) % 360;
  return x;
}
