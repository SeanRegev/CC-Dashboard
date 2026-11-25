// @ts-check
/** Left sidebar: quick-switch button, spaces with counts, agents of the current space. */
import { h, mount, icon, kbd } from '../dom.js';
import { sortAgents, spaceCounts, describeActivity, cardTime, stateLabel } from '../logic.js';

/**
 * @param {HTMLElement} root
 * @param {{
 *   spaces: any[], entries: any[], currentSpace: string|null, visible: Set<string>, openTabs: Set<string>,
 *   conn: string, version: string, mod: string,
 * }} s
 * @param {{
 *   selectSpace: (id:string) => void, addSpace: () => void, openAgent: (id:string) => void,
 *   newAgent: () => void, quickSwitch: () => void,
 * }} act
 */
export function renderSidebar(root, s, act) {
  const counts = spaceCounts(s.entries);
  const space = s.spaces.find((x) => x.id === s.currentSpace) || null;
  const agents = sortAgents(s.entries.filter((e) => e.agent.spaceId === s.currentSpace));
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

  const cards = agents.map((e) => {
    const st = e.status ? e.status.state : 'stopped';
    const id = e.agent.id;
    return h('li', null, h('button', {
      class: `agent-card st-${st}${s.visible.has(id) ? ' visible' : ''}${s.openTabs.has(id) ? ' open' : ''}`,
      dataset: { agent: id, state: st },
      title: `${e.agent.name} · ${stateLabel(st)}`,
      onclick: () => act.openAgent(id),
    },
    h('span', { class: 'card-row' },
      h('span', { class: `dot st-${st}`, 'aria-label': stateLabel(st) }),
      h('span', { class: 'agent-name' }, e.agent.name),
      st === 'needs_you' ? h('span', { class: 'needs-badge' }, '◆ needs you') : null,
      h('span', { class: 'card-time' }, cardTime(e.status))),
    h('span', { class: 'card-activity' }, describeActivity(e.status))));
  });

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
        space ? h('span', { class: 'sb-sub' }, `${agents.length} in ${space.name}`) : null),
      h('button', { class: 'new-agent', id: 'new-agent', onclick: act.newAgent, disabled: !s.spaces.length },
        icon('plus'), h('span', null, 'New agent'), kbd(s.mod, 'T')),
      agents.length
        ? h('ul', { class: 'agent-list' }, cards)
        : h('div', { class: 'sb-hint' }, space ? 'No agents in this space yet.' : 'Pick a space to see its agents.'),
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
