// @ts-check
/**
 * Grid view. Owner: the Layouts track (M2). Every agent of the selected space as a tile with its live
 * terminal: two columns, tile height = half the visible area, so four tiles fill the screen and the rest
 * scrolls. Only tiles in or near the viewport (one row above and below) hold a live terminal; the others
 * show a plain-text snapshot of the last output.
 *
 * Terminal handoff with the Terminals view: a tile moves the agent's TerminalView element into its own
 * host while it is live (ctx.terminal) and takes it out again when it lets go (ctx.releaseTerminal). While
 * the grid is shown app.js layoutPanes() does not run (workspace is hidden); when Terminals is shown again
 * layoutPanes() moves the element of every pane agent back. The grid also lets go of everything on hide().
 */
import { h, mount, icon } from '../dom.js';
import { gridOrder, describeActivity, cardTime, stateLabel, contextPercent, gaugeLevel, tailLines } from '../logic.js';
import { roleBadge, roleOf } from '../roles.js';
import { approvalButtons } from '../components/approval.js';
import { attachAgentMenu } from '../components/agent-menu.js';
import { renderSubagentStrip } from '../components/activity.js';

const SNAPSHOT_LINES = 60;

/**
 * @typedef {Object} Tile
 * @property {string} id
 * @property {HTMLElement} root
 * @property {HTMLElement} dot
 * @property {HTMLElement} badgeSlot
 * @property {string} badgeKey
 * @property {HTMLElement} name
 * @property {HTMLElement} activity
 * @property {HTMLElement} time
 * @property {HTMLElement} approvalSlot
 * @property {HTMLElement} subsSlot       M3 Activity UI: the subagent strip under the header
 * @property {string} approvalKey
 * @property {HTMLButtonElement} runBtn
 * @property {HTMLElement} host
 * @property {HTMLElement} snap
 * @property {HTMLElement} footState
 * @property {HTMLElement} gaugeFill
 * @property {HTMLElement} gaugeBar
 * @property {HTMLElement} gaugePct
 * @property {boolean} near
 * @property {import('../terminal.js').TerminalView|null} live
 * @property {string} snapshot
 * @property {ResizeObserver} ro
 */

/** @param {import('../context.js').ViewContext} ctx @returns {import('../context.js').View} */
export function createGridView(ctx) {
  /** @type {Map<string, Tile>} */
  const tiles = new Map();
  /** @type {string[]} */
  let order = [];
  let shown = false;
  /** @type {string|null} */
  let expandedId = null;
  /** @type {string|null} */
  let focusedId = null;
  let savedScroll = 0;

  const title = h('span', { class: 'grid-title' });
  const count = h('span', { class: 'grid-count' });
  const backBtn = h('button', { class: 'btn small', id: 'grid-back', type: 'button', title: 'Back to the grid (Esc, when the terminal is not focused)', onclick: () => collapse() }, '← Back to grid');
  const newBtn = h('button', { class: 'btn small', type: 'button', id: 'grid-new', onclick: () => ctx.newAgent(ctx.state().currentSpace || undefined) }, icon('plus'), 'New agent');
  const bar = h('div', { class: 'grid-bar' }, title, count, h('span', { class: 'grow' }), backBtn, newBtn);
  const tilesEl = h('div', { class: 'grid-tiles' });
  const scroll = h('div', { class: 'grid-scroll', tabindex: '-1' }, tilesEl);
  const empty = h('div', { class: 'grid-empty', hidden: true },
    h('div', { class: 'empty-icon' }, icon('terminal')),
    h('div', { class: 'empty-title' }, 'No agents in this space'),
    h('div', { class: 'empty-sub' }, 'Start one and it shows up here, next to the others.'),
    h('div', { class: 'empty-actions' }, h('button', { class: 'btn primary', id: 'grid-empty-new', type: 'button', onclick: () => ctx.newAgent(ctx.state().currentSpace || undefined) }, icon('plus'), 'New agent')));
  const el = h('section', { class: 'view view-grid', dataset: { view: 'grid' } }, bar, scroll, empty);

  // ---- live terminals: only tiles in or near the viewport ----
  const io = new IntersectionObserver((records) => {
    for (const r of records) {
      const t = tiles.get(/** @type {HTMLElement} */ (r.target).dataset.agent || '');
      if (!t) continue;
      t.near = r.isIntersecting;
      syncLive(t);
    }
  }, { root: scroll, rootMargin: '50% 0px 50% 0px', threshold: 0 }); // 50% of the viewport = one tile row

  /** @param {Tile} t */
  function syncLive(t) {
    const want = shown && t.near;
    if (want && t.live && t.live.disposed) { t.live = null; }
    if (want && !t.live) goLive(t);
    else if (!want && t.live) goSnapshot(t);
  }

  /** @param {Tile} t */
  function goLive(t) {
    if (!ctx.state().entries.has(t.id)) return;
    const v = ctx.terminal(t.id);
    t.live = v;
    t.host.replaceChildren(v.el);
    t.root.dataset.live = 'true';
    t.snap.hidden = true;
    requestAnimationFrame(() => v.fit(true));
  }

  /** Read the buffer, then let go of the terminal. @param {Tile} t */
  function goSnapshot(t) {
    const v = t.live;
    t.live = null;
    t.root.dataset.live = 'false';
    if (v && !v.disposed) {
      const text = snapshotOf(v);
      if (text) t.snapshot = text;
      if (v.el.parentElement === t.host) v.el.remove();
      ctx.releaseTerminal(t.id);
    }
    t.host.replaceChildren(t.snap);
    t.snap.textContent = t.snapshot || 'Scroll here to load the terminal…';
    t.snap.classList.toggle('placeholder', !t.snapshot);
    t.snap.hidden = false;
  }

  /** The last lines of the terminal buffer as plain text. @param {import('../terminal.js').TerminalView} v */
  function snapshotOf(v) {
    try {
      const buf = v.term.buffer.active;
      const lines = [];
      for (let i = Math.max(0, buf.length - 200); i < buf.length; i++) {
        const line = buf.getLine(i);
        lines.push(line ? line.translateToString(true) : '');
      }
      return tailLines(lines, SNAPSHOT_LINES).join('\n');
    } catch { return ''; }
  }

  // ---- tiles ----
  /** @param {string} id @returns {Tile} */
  function makeTile(id) {
    const dot = h('span', { class: 'dot' });
    const badgeSlot = h('span', { class: 'tile-badge' });
    const name = h('span', { class: 'tile-name' });
    const activity = h('span', { class: 'tile-activity' });
    const time = h('span', { class: 'tile-time' });
    const approvalSlot = h('span', { class: 'tile-approval' });
    const runBtn = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn ghost small tile-run', type: 'button' }));
    runBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const e = ctx.state().entries.get(id);
      if (!e) return;
      ctx.rpc(isRunning(e) ? 'agents.stop' : 'agents.resume', { id });
    });
    const expandBtn = h('button', { class: 'icon-btn small tile-expand', type: 'button', title: 'Expand (Enter or double-click)', 'aria-label': 'Expand tile', onclick: (/** @type {Event} */ ev) => { ev.stopPropagation(); toggleExpand(id); } }, '⤢');
    const head = h('div', { class: 'tile-head' }, dot, badgeSlot, name, activity, time, approvalSlot, runBtn, expandBtn);
    const subsSlot = h('div', { class: 'tile-subs', hidden: true }); // M3 Activity UI
    const host = h('div', { class: 'tile-term' });
    const snap = h('pre', { class: 'tile-snap placeholder' });
    host.append(snap);
    const footState = h('span', { class: 'tile-state' });
    const gaugeFill = h('span', { class: 'gauge-fill' });
    const gaugeBar = h('span', { class: 'gauge-bar' }, gaugeFill);
    const gaugePct = h('span', { class: 'gauge-pct' });
    const foot = h('div', { class: 'tile-foot' }, footState, h('span', { class: 'grow' }), h('span', { class: 'tile-ctx', title: 'Context window' }, h('span', { class: 'tile-ctx-label' }, 'Context'), gaugeBar, gaugePct));
    const root = h('article', { class: 'tile', tabindex: '0', dataset: { agent: id, live: 'false' } }, head, subsSlot, host, foot);
    /** @type {Tile} */
    const t = { id, root, dot, badgeSlot, badgeKey: '', name, activity, time, approvalSlot, subsSlot, approvalKey: '\0', runBtn, host, snap, footState, gaugeFill, gaugeBar, gaugePct, near: false, live: null, snapshot: '', ro: new ResizeObserver(() => { if (t.live) t.live.fit(); }) };
    t.ro.observe(host);
    root.addEventListener('click', (ev) => {
      if (/** @type {HTMLElement} */ (ev.target).closest('button, a, input')) return;
      focusTile(id);
    });
    root.addEventListener('dblclick', (ev) => {
      if (/** @type {HTMLElement} */ (ev.target).closest('button, a, input')) return;
      toggleExpand(id);
    });
    root.addEventListener('focusin', () => { if (focusedId !== id) { focusedId = id; markFocus(); } });
    root.addEventListener('keydown', (ev) => {
      if (ev.target === root && ev.key === 'Enter') { ev.preventDefault(); toggleExpand(id); }
    });
    attachAgentMenu(root, ctx, id);
    io.observe(root);
    return t;
  }

  /** @param {{status?:any, running:boolean}} e */
  function isRunning(e) {
    const st = e.status ? e.status.state : 'stopped';
    return e.running && !['stopped', 'exited'].includes(st);
  }

  /** @param {Tile} t @param {{agent:any, status:any, running:boolean}} e */
  function fillTile(t, e) {
    const st = e.status ? e.status.state : 'stopped';
    t.root.className = `tile st-${st}${expandedId === t.id ? ' expanded' : ''}${focusedId === t.id ? ' focused' : ''}${roleOf(e.agent).id === 'main' ? ' is-main' : ''}`;
    t.dot.className = `dot st-${st}`;
    const r = roleOf(e.agent);
    const bkey = `${r.id}|${r.label}|${r.emoji}`;
    if (bkey !== t.badgeKey) { t.badgeKey = bkey; mount(t.badgeSlot, roleBadge(e.agent)); }
    t.name.textContent = e.agent.name;
    t.name.title = `${e.agent.name} · ${ctx.spaceName(e.agent.spaceId)}`;
    const act = describeActivity(e.status);
    t.activity.textContent = act;
    t.activity.title = act;
    t.time.textContent = cardTime(e.status);
    const akey = `${st}|${(e.status && e.status.prompt && e.status.prompt.id) || ''}`;
    if (akey !== t.approvalKey) {
      t.approvalKey = akey;
      const b = approvalButtons(ctx, e, { compact: true });
      mount(t.approvalSlot, b);
    }
    const running = isRunning(e);
    t.runBtn.textContent = running ? 'Stop' : 'Resume';
    t.runBtn.className = `btn small tile-run ${running ? 'ghost' : 'primary'}`;
    t.runBtn.title = running ? 'Stop the Claude process (the chat is kept)' : 'Resume this session';
    t.footState.textContent = stateLabel(st);
    const pct = contextPercent(e.status && e.status.usage);
    t.gaugeFill.style.width = `${pct}%`;
    t.gaugeBar.className = `gauge-bar lvl-${gaugeLevel(pct)}`;
    t.gaugePct.textContent = `${pct}%`;
    renderSubagentStrip(ctx, t.subsSlot, t.id); // M3 Activity UI
  }

  function markFocus() {
    for (const t of tiles.values()) t.root.classList.toggle('focused', t.id === focusedId);
  }

  /** @param {string} id */
  function focusTile(id) {
    const t = tiles.get(id);
    if (!t) return;
    focusedId = id;
    markFocus();
    if (t.live) t.live.focus(); else t.root.focus();
  }

  /** @param {string} id */
  function toggleExpand(id) { if (expandedId === id) collapse(); else expand(id); }

  /** @param {string} id */
  function expand(id) {
    if (!tiles.has(id)) return;
    if (!expandedId) savedScroll = scroll.scrollTop;
    expandedId = id;
    applyExpanded();
    // the tile is alone now: make sure it is live, then give it the keyboard
    const t = /** @type {Tile} */ (tiles.get(id));
    t.near = true;
    syncLive(t);
    requestAnimationFrame(() => { requestAnimationFrame(() => focusTile(id)); });
  }

  function collapse() {
    if (!expandedId) return;
    const id = expandedId;
    expandedId = null;
    applyExpanded();
    scroll.scrollTop = savedScroll;
    const t = tiles.get(id);
    requestAnimationFrame(() => { if (t && t.live) t.live.fit(true); if (t) t.root.focus(); });
  }

  function applyExpanded() {
    tilesEl.classList.toggle('has-expanded', !!expandedId);
    bar.classList.toggle('is-expanded', !!expandedId);
    for (const t of tiles.values()) t.root.classList.toggle('expanded', t.id === expandedId);
    backBtn.hidden = !expandedId;
    // everything else is display:none while expanded: IntersectionObserver reports them as gone
    // and they let go of their terminals; the expanded one is refitted to the whole view.
    requestAnimationFrame(() => { const t = expandedId && tiles.get(expandedId); if (t && t.live) t.live.fit(true); });
  }

  // Esc leaves the expanded tile, unless the terminal has the focus (Esc then belongs to Claude Code).
  el.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !expandedId || ev.defaultPrevented) return;
    if (/** @type {HTMLElement} */ (ev.target).closest('.term-slot')) return;
    ev.preventDefault();
    collapse();
  });

  // ---- view contract ----
  function update() {
    const S = ctx.state();
    const space = S.spaces.find((/** @type {any} */ s) => s.id === S.currentSpace) || null;
    const list = gridOrder(/** @type {any[]} */ ([...S.entries.values()].filter((e) => e.agent.spaceId === S.currentSpace)));
    const ids = list.map((e) => e.agent.id);
    if (expandedId && !ids.includes(expandedId)) { expandedId = null; applyExpanded(); }
    if (focusedId && !ids.includes(focusedId)) focusedId = null;

    // drop tiles of agents that are gone or in another space
    for (const [id, t] of tiles) {
      if (ids.includes(id)) continue;
      io.unobserve(t.root);
      t.ro.disconnect();
      if (t.live) { if (t.live.el.parentElement === t.host) t.live.el.remove(); ctx.releaseTerminal(id); t.live = null; }
      t.root.remove();
      tiles.delete(id);
    }
    for (const e of list) {
      let t = tiles.get(e.agent.id);
      if (!t) { t = makeTile(e.agent.id); tiles.set(e.agent.id, t); }
      fillTile(t, e);
      if (t.live && t.live.disposed) { t.live = null; syncLive(t); }
    }
    if (ids.join('\0') !== order.join('\0')) {
      order = ids;
      // Move only what is out of place; a node that is moved loses the keyboard focus, so give it back.
      const active = /** @type {HTMLElement|null} */ (document.activeElement);
      const keep = active && tilesEl.contains(active) ? active : null;
      ids.forEach((id, i) => {
        const node = /** @type {Tile} */ (tiles.get(id)).root;
        if (tilesEl.children[i] !== node) tilesEl.insertBefore(node, tilesEl.children[i] || null);
      });
      if (keep && keep.isConnected && document.activeElement !== keep) keep.focus({ preventScroll: true });
    }
    title.textContent = space ? space.name : 'No space';
    count.textContent = ids.length ? `${ids.length} agent${ids.length === 1 ? '' : 's'}` : '';
    const none = !ids.length;
    empty.hidden = !none;
    scroll.hidden = none;
    el.classList.toggle('is-empty', none);
    newBtn.disabled = !S.spaces.length;
    backBtn.hidden = !expandedId;
  }

  function show() {
    shown = true;
    update();
    // observe again: a hidden view reported every tile as out of view
    for (const t of tiles.values()) { io.unobserve(t.root); io.observe(t.root); }
  }

  function hide() {
    shown = false;
    for (const t of tiles.values()) if (t.live) goSnapshot(t);
  }

  return { el, update, show, hide };
}
