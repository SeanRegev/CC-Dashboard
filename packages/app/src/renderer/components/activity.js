// @ts-check
/**
 * Activity UI (M3): the drawer with a session's full activity log, the subagent strip of a grid tile and the
 * sidebar badge. Owner: the Activity UI track. Pure helpers live in activity-logic.js.
 *
 * The drawer shows S.activityFor ({agentId, subagentId?}); agentId is an Agent id or "ext:<sessionId>".
 * Filter: null = all lines, '' = the session's own lines, else a subagent id. The log comes from
 * activity.list (newest page, "Load older" with before) and live from ctx.onActivity.
 */
import { h, mount } from '../dom.js';
import { roleBadge } from '../roles.js';
import {
  MAX_LINES, PAGE, typeInfo, subagentTitle, clip, formatDuration, subagentDuration, stateInfo, mergeEntries, filterEntries,
  listParams, initialFilter, describeEntry, atBottom, badgeCount, stripModel, stripKey, windowOf,
} from './activity-logic.js';

/** The drawer's data for the session it shows. @typedef {{agentId: string, filter: string|null, entries: any[], more: boolean, loaded: boolean, error: string, limit: number, following: boolean, unseen: number, pinOld: boolean}} Feed */

/** @param {import('../context.js').ViewContext} ctx @returns {{el: HTMLElement, update: () => void}} */
export function createActivityDrawer(ctx) {
  /** @type {Feed|null} */
  let feed = null;
  /** The S.activityFor object the feed was set up for (a new object = a new request to show something). @type {any} */
  let lastFor = null;
  let loadToken = 0;
  let loadingOlder = false;
  let renderedKey = '';
  let lastConn = '';
  /** @type {HTMLElement|null} */
  let prevFocus = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let timer = null;

  const title = h('span', { class: 'act-name' });
  const badgeSlot = h('span', { class: 'act-badge-slot' });
  const closeBtn = h('button', { class: 'icon-btn small act-close', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close activity', onclick: () => ctx.closeActivity() }, '✕');
  const head = h('div', { class: 'act-head' }, badgeSlot, title, h('span', { class: 'grow' }), closeBtn);
  const list = h('div', { class: 'act-list', role: 'listbox', 'aria-label': 'Session and subagents' });
  const olderBtn = h('button', { class: 'btn small act-older', type: 'button', onclick: () => loadOlder() }, 'Load older');
  const lines = h('div', { class: 'act-lines' });
  const status = h('div', { class: 'act-status' });
  const scroller = h('div', { class: 'act-feed', tabindex: '0', 'aria-label': 'Activity log' }, olderBtn, lines, status);
  const jump = h('button', { class: 'btn small act-jump', type: 'button', hidden: true, onclick: () => scrollToEnd() }, 'Jump to latest');
  const body = h('div', { class: 'act-body' }, scroller, jump);
  const el = h('aside', { class: 'activity-drawer', id: 'activity-drawer', 'aria-label': 'Activity', hidden: true }, head, list, body);

  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !ev.defaultPrevented) { ev.preventDefault(); ev.stopPropagation(); ctx.closeActivity(); }
  });
  scroller.addEventListener('scroll', () => {
    if (!feed) return;
    feed.following = !feed.pinOld && atBottom(scroller); // old lines are never "the end"
    if (feed.following) feed.unseen = 0;
    syncJump();
  });

  /** @param {string} id */
  const lookupIn = (id) => (/** @type {string} */ sid) => ctx.subagents(id).find((s) => s.id === sid) || null;

  function syncJump() {
    if (!feed) return;
    jump.hidden = feed.following;
    jump.textContent = feed.unseen ? `Jump to latest (${feed.unseen} new)` : 'Jump to latest';
  }

  function scrollToEnd() {
    if (feed && feed.pinOld) { // the window shows old lines: fetch the newest page again
      feed = { ...feed, entries: [], more: false, loaded: false, limit: MAX_LINES, following: true, unseen: 0, pinOld: false };
      renderFeed();
      load();
      return;
    }
    scroller.scrollTop = scroller.scrollHeight;
    if (feed) { feed.following = true; feed.unseen = 0; }
    syncJump();
  }

  /** (Re)load the newest page for the current filter. */
  async function load() {
    const f = feed;
    if (!f) return;
    const token = ++loadToken;
    f.error = '';
    try {
      const r = await ctx.client.call('activity.list', { agentId: f.agentId, ...listParams(f.filter), limit: PAGE });
      if (token !== loadToken || feed !== f) return;
      f.entries = mergeEntries(f.entries, (r && r.entries) || [], MAX_LINES * 2);
      f.more = !!(r && r.more);
    } catch (e) {
      if (token !== loadToken || feed !== f) return;
      f.error = `Could not load the log: ${/** @type {any} */ (e).message || e}`;
    }
    f.loaded = true;
    renderFeed();
  }

  async function loadOlder() {
    const f = feed;
    if (!f || loadingOlder || !f.entries.length) return;
    loadingOlder = true;
    olderBtn.disabled = true;
    try {
      const r = await ctx.client.call('activity.list', { agentId: f.agentId, ...listParams(f.filter), before: f.entries[0].seq, limit: PAGE });
      if (feed !== f) return;
      const got = (r && r.entries) || [];
      const before = scroller.scrollHeight;
      f.entries = mergeEntries(f.entries, got);
      f.more = !!(r && r.more);
      // At most MAX_LINES are rendered: past that the window stays on the old end ("Jump to latest" returns).
      const total = filterEntries(f.entries, f.filter).length;
      if (total > f.limit) { f.pinOld = true; f.following = false; }
      renderFeed();
      scroller.scrollTop += scroller.scrollHeight - before; // keep the line the user was reading
      syncJump();
    } catch (e) {
      ctx.toast(`Could not load older lines: ${/** @type {any} */ (e).message || e}`, 'error');
    } finally {
      loadingOlder = false;
      olderBtn.disabled = false;
    }
  }

  /** @param {any} d @param {Feed} f */
  function row(d, f) {
    return h('div', { class: `act-line k-${d.kind}${d.error ? ' is-error' : ''}${d.needs ? ' is-needs' : ''}`, dataset: { seq: String(d.seq), kind: d.kind } },
      h('span', { class: 'act-time' }, d.time),
      f.filter === null ? h('span', { class: 'act-who', title: d.whoTitle }, d.who) : null,
      h('span', { class: 'act-icon', 'aria-hidden': 'true' }, d.icon),
      h('span', { class: 'act-text' },
        d.label ? h('span', { class: 'act-label' }, d.label) : null,
        d.detail ? h('span', { class: 'act-detail', title: d.detail }, d.detail) : null),
      d.dur ? h('span', { class: 'act-dur' }, d.dur) : null);
  }

  /** Describe an entry with its seq kept. @param {any} e @param {Feed} f */
  const describe = (e, f) => ({ ...describeEntry(e, lookupIn(f.agentId)), seq: e.seq });

  /** Rebuild the lines (and scroll to the end when following). */
  function renderFeed() {
    const f = feed;
    if (!f) return;
    const all = filterEntries(f.entries, f.filter);
    const shown = f.pinOld ? all.slice(0, f.limit) : windowOf(all, f.limit);
    const follow = f.following;
    lines.replaceChildren(...shown.map((e) => row(describe(e, f), f)));
    olderBtn.hidden = !f.more;
    status.textContent = f.error || (!f.loaded ? 'Loading…' : shown.length ? '' : 'No activity yet.');
    status.classList.toggle('is-error', !!f.error);
    if (follow) scroller.scrollTop = scroller.scrollHeight;
    syncJump();
  }

  /** Live lines: append the new ones, trim the top, follow the bottom. @param {any[]} incoming */
  function addLive(incoming) {
    const f = feed;
    if (!f) return;
    const fresh = filterEntries(incoming, f.filter);
    const seen = new Set(f.entries.map((e) => e.seq));
    const add = fresh.filter((e) => !seen.has(e.seq));
    f.entries = mergeEntries(f.entries, incoming, MAX_LINES * 2);
    if (!f.loaded || !add.length) return;
    if (f.pinOld) { f.unseen += add.length; syncJump(); return; } // reading old lines: only count the new ones
    const oldTop = lines.firstElementChild;
    const lastSeq = lines.lastElementChild ? Number(/** @type {HTMLElement} */ (lines.lastElementChild).dataset.seq) : -1;
    if (add[0].seq < lastSeq) { renderFeed(); return; } // out of order: rebuild
    const wasFollowing = f.following;
    for (const e of add) lines.append(row(describe(e, f), f));
    // keep the DOM light: at most `limit` lines (+ a little slack, so trimming is not done on every line)
    let removed = 0;
    if (lines.children.length > f.limit + 50) {
      const drop = lines.children.length - f.limit;
      const before = scroller.scrollHeight;
      for (let i = 0; i < drop; i++) lines.firstElementChild && lines.firstElementChild.remove();
      removed = before - scroller.scrollHeight;
      f.more = true; // what was trimmed is on the core
      olderBtn.hidden = false;
    }
    status.textContent = '';
    if (wasFollowing) scroller.scrollTop = scroller.scrollHeight;
    else {
      if (removed && oldTop) scroller.scrollTop = Math.max(0, scroller.scrollTop - removed);
      f.unseen += add.length;
    }
    syncJump();
  }

  ctx.onActivity((agentId, entries) => { if (feed && feed.agentId === agentId) addLive(entries || []); });

  /** @param {string|null} filter */
  function setFilter(filter) {
    if (!feed || feed.filter === filter) return;
    feed = { ...feed, filter, entries: [], more: false, loaded: false, error: '', limit: MAX_LINES, following: true, unseen: 0, pinOld: false };
    renderList();
    renderFeed();
    load();
  }

  /** Name + badge for the session the drawer shows. @param {string} id */
  function headFor(id) {
    const S = ctx.state();
    if (id.startsWith('ext:')) {
      const x = (ctx.external() || []).find((s) => s.id === id);
      return { name: x ? x.name : 'Outside session', badge: h('span', { class: 'role-badge act-outside', title: 'A session CC-Dashboard did not start (view only)' }, h('span', { class: 'role-emoji', 'aria-hidden': 'true' }, '👁'), h('span', { class: 'role-label' }, 'Outside')) };
    }
    const e = S.entries.get(id);
    return { name: e ? e.agent.name : id, badge: e ? roleBadge(e.agent) : null };
  }

  function renderList() {
    const f = feed;
    if (!f) return;
    const subs = ctx.subagents(f.agentId);
    const now = Date.now();
    /** @param {string|null} value @param {HTMLElement[]} kids @param {string} [cls] @param {string} [tip] */
    const item = (value, kids, cls = '', tip = '') => h('button', {
      class: `act-item${cls ? ` ${cls}` : ''}${f.filter === value ? ' on' : ''}`, type: 'button', role: 'option', title: tip || undefined,
      'aria-selected': String(f.filter === value), dataset: { filter: value === null ? 'all' : value === '' ? 'session' : value },
      onclick: () => setFilter(feed && feed.filter === value ? null : value),
    }, ...kids);
    mount(list,
      item(null, [h('span', { class: 'act-item-title' }, 'All activity'), h('span', { class: 'act-item-meta' }, `${subs.length} subagent${subs.length === 1 ? '' : 's'}`)], 'all'),
      item('', [h('span', { class: 'act-item-title' }, 'Session'), h('span', { class: 'act-item-meta' }, 'its own lines')], 'session'),
      ...subs.map((s) => {
        const info = typeInfo(s.type);
        const st = stateInfo(s.state);
        const meta = [`${s.counts ? s.counts.tools : 0} tool${s.counts && s.counts.tools === 1 ? '' : 's'}`, s.counts && s.counts.errors ? `${s.counts.errors} error${s.counts.errors === 1 ? '' : 's'}` : '', subagentDuration(s, now)].filter(Boolean).join(' · ');
        const doing = s.needsYou ? h('span', { class: 'act-needs' }, '◆ needs you')
          : s.state === 'running' && s.tool ? h('span', { class: 'act-doing', title: `${s.tool} ${s.detail || ''}` }, s.tool, s.detail ? ` ${clip(s.detail, 40)}` : '') : null;
        return item(s.id, [
          h('span', { class: `act-state st-${s.state}`, title: st.label, 'aria-label': st.label }, s.state === 'running' ? h('span', { class: 'act-spin' }) : st.glyph),
          h('span', { class: 'act-item-emoji', title: info.label }, info.emoji),
          h('span', { class: 'act-item-title', title: subagentTitle(s) }, subagentTitle(s)),
          h('span', { class: 'act-item-meta', dataset: s.state === 'running' ? { since: String(s.startedAt || 0) } : {} }, meta),
          doing,
        ], `sub st-${s.state}${s.needsYou ? ' needs' : ''}`, `${info.label}${s.summary ? `: ${s.summary}` : ''}`);
      }));
  }

  /** The durations of running subagents tick once a second. */
  function tick() {
    if (!feed) return;
    const subs = ctx.subagents(feed.agentId);
    for (const item of list.querySelectorAll('.act-item.sub.st-running')) {
      const s = subs.find((x) => x.id === /** @type {HTMLElement} */ (item).dataset.filter);
      const meta = item.querySelector('.act-item-meta');
      if (s && meta) meta.textContent = [`${s.counts ? s.counts.tools : 0} tool${s.counts && s.counts.tools === 1 ? '' : 's'}`, s.counts && s.counts.errors ? `${s.counts.errors} errors` : '', formatDuration(Date.now() - (s.startedAt || Date.now()))].filter(Boolean).join(' · ');
    }
  }

  function update() {
    const S = ctx.state();
    const f = S.activityFor;
    if (!f) {
      if (!el.hidden) {
        el.hidden = true;
        lines.replaceChildren(); list.replaceChildren(); // nothing stale when it opens for another session
        document.getElementById('app')?.classList.remove('has-activity');
        if (timer) { clearInterval(timer); timer = null; }
        if (prevFocus && prevFocus.isConnected && el.contains(document.activeElement)) prevFocus.focus();
        prevFocus = null;
      }
      feed = null; lastFor = null; renderedKey = '';
      return;
    }
    const opening = el.hidden;
    if (opening) {
      prevFocus = /** @type {HTMLElement|null} */ (document.activeElement);
      el.hidden = false;
      document.getElementById('app')?.classList.add('has-activity');
      timer = setInterval(tick, 1000);
    }
    if (f !== lastFor) {
      lastFor = f;
      feed = { agentId: f.agentId, filter: initialFilter(f), entries: [], more: false, loaded: false, error: '', limit: MAX_LINES, following: true, unseen: 0, pinOld: false };
      renderedKey = '';
      renderFeed();
      load();
    }
    const cur = /** @type {Feed} */ (feed);
    // the core came back: fetch what was missed (merged by seq, so nothing doubles)
    if (S.conn === 'open' && lastConn && lastConn !== 'open') load();
    lastConn = S.conn;
    const hd = headFor(cur.agentId);
    const key = `${hd.name}|${cur.agentId}|${cur.filter}|${JSON.stringify(ctx.subagents(cur.agentId).map((s) => [s.id, s.title, s.state, s.tool, s.needsYou, s.counts && s.counts.tools, s.endedAt]))}`;
    if (key !== renderedKey) {
      renderedKey = key;
      title.textContent = hd.name;
      title.title = hd.name;
      mount(badgeSlot, hd.badge);
      el.dataset.agent = cur.agentId;
      el.classList.toggle('is-outside', cur.agentId.startsWith('ext:'));
      renderList();
    }
    if (opening) requestAnimationFrame(() => { if (!el.hidden) scroller.focus({ preventScroll: true }); });
  }

  return { el, update };
}

/**
 * The strip under a grid tile's header: chips for running subagents (emoji, title, current tool), "+N" more,
 * "✓ N" done, "✗ N" failed. A chip opens the drawer on that subagent. Re-renders only when it would look different.
 * @param {import('../context.js').ViewContext} ctx @param {HTMLElement} slot @param {string} agentId
 */
export function renderSubagentStrip(ctx, slot, agentId) {
  const subs = ctx.subagents(agentId);
  const key = stripKey(subs);
  if (slot.dataset.key === key) return;
  slot.dataset.key = key;
  const m = stripModel(subs);
  slot.hidden = !subs.length;
  if (!subs.length) { slot.replaceChildren(); return; }
  /** @param {string} cls @param {string} text @param {string} tip @param {string} [sub] */
  const pill = (cls, text, tip, sub) => h('button', {
    class: `sub-pill ${cls}`, type: 'button', title: tip,
    onclick: (/** @type {Event} */ ev) => { ev.stopPropagation(); ctx.openActivity(agentId, sub); },
  }, text);
  mount(slot,
    ...m.chips.map((s) => {
      const info = typeInfo(s.type);
      return h('button', {
        class: `sub-chip${s.needsYou ? ' needs' : ''}`, type: 'button', dataset: { sub: s.id },
        title: `${info.label}: ${subagentTitle(s)}${s.tool ? ` — ${s.tool} ${s.detail || ''}` : ''}${s.needsYou ? ' (needs you)' : ''}`,
        onclick: (/** @type {Event} */ ev) => { ev.stopPropagation(); ctx.openActivity(agentId, s.id); },
      },
      h('span', { class: 'sub-emoji', 'aria-hidden': 'true' }, info.emoji),
      h('span', { class: 'sub-title' }, subagentTitle(s)),
      s.needsYou ? h('span', { class: 'sub-tool' }, '◆ needs you') : s.tool ? h('span', { class: 'sub-tool' }, s.tool) : null);
    }),
    m.more ? pill('more', `+${m.more}`, `${m.more} more running`) : null,
    m.done ? pill('done', `✓ ${m.done}`, `${m.done} finished`) : null,
    m.failed ? pill('failed', `✗ ${m.failed}`, `${m.failed} failed`) : null);
}

/**
 * Small "N running" badge for a sidebar card; null when no subagent runs. Opens the drawer.
 * @param {import('../context.js').ViewContext} ctx @param {string} agentId @param {any} status
 */
export function subagentBadge(ctx, agentId, status) {
  const n = badgeCount(ctx.subagents(agentId), status);
  if (!n) return null;
  return h('button', {
    class: 'sub-badge', type: 'button', title: `${n} subagent${n === 1 ? '' : 's'} running — open the activity log`,
    onclick: (/** @type {Event} */ ev) => { ev.stopPropagation(); ctx.openActivity(agentId); },
  }, `${n} running`);
}
