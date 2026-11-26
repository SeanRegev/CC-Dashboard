// @ts-check
'use strict';
/**
 * Mock `subagents.*`, `activity.*` and `external.*` (contract v3) for the dev mock core (screenshots, e2e).
 * Owner: lead (M3 groundwork); the UI tracks may add seed data, keeping the shapes in protocol.js.
 *
 * Seed:
 *   refactor-auth    2 subagents: "Find token call sites" (Explore, done), "Update middleware tests" (general, background, running)
 *   fix-flaky-tests  3 subagents: "Map checkout fixtures" (Explore, running), "Plan the retry fix" (Plan, done),
 *                    "Reproduce the flake 20x" (general, failed)
 *   landing-copy     1 subagent:  "Check headline lengths" (general, running)
 *   outside sessions ext:…-vscode (cc-dashboard, working, VS Code, 1 subagent), ext:…-cli (cc-dashboard, idle, cli),
 *                    ext:…-notes (a folder that is no space, idle)
 * Without MOCK_STATIC, running subagents and the working outside session log a new tool every tick.
 */

const SUBAGENT_SEED = /** @type {Record<string, Array<[string, string, string, boolean, string, string]>>} */ ({
  // [id, title, type, background, state, summary]
  'refactor-auth': [
    ['a1f0c2e9d1b7a0001', 'Find token call sites', 'Explore', false, 'done', 'Found 14 call sites of verifyToken in 6 files: src/middleware/auth.js, src/routes/*.js.'],
    ['a1f0c2e9d1b7a0002', 'Update middleware tests', 'general-purpose', true, 'running', ''],
  ],
  'fix-flaky-tests': [
    ['b2e1d3f0c2a8b0001', 'Map checkout fixtures', 'Explore', false, 'running', ''],
    ['b2e1d3f0c2a8b0002', 'Plan the retry fix', 'Plan', false, 'done', 'Plan: wait for the cart total instead of a fixed 200 ms sleep; seed the clock.'],
    ['b2e1d3f0c2a8b0003', 'Reproduce the flake 20x', 'general-purpose', true, 'failed', 'npm test exited 1 on run 4 of 20 (cart.spec.js:88).'],
  ],
  'landing-copy': [
    ['c3a2e4b1d3f9c0001', 'Check headline lengths', 'general-purpose', true, 'running', ''],
  ],
});

/** Tool lines a running subagent cycles through, by type. */
const TOOLS = /** @type {Record<string, Array<[string, string]>>} */ ({
  Explore: [['Grep', 'verifyToken'], ['Read', 'src/middleware/auth.js'], ['Glob', 'tests/**/*.spec.js'], ['Read', 'tests/checkout/cart.spec.js']],
  Plan: [['Read', 'docs/ARCHITECTURE.md'], ['Grep', 'setTimeout']],
  'general-purpose': [['Edit', 'tests/middleware/auth.test.js'], ['Bash', 'npm test -- auth'], ['Read', 'src/token-service.js'], ['Bash', 'npm test -- --repeat 20']],
});

/**
 * @param {{broadcast:(e:string,d:any)=>void, fail:(c:string,m:string)=>Error, ERRORS:any, state:any,
 *          setStatus:(id:string, patch:any)=>void, base:string,
 *          createAgent:(spec:{spaceId:string, name:string, cwd:string, sessionId:string, prompt?:string}) => any,
 *          addSpace:(path:string, name:string) => any, static?: boolean}} ctx
 */
function activityMethods(ctx) {
  const now = Date.now();
  /** @type {Map<string, any[]>} agentId → Subagent[] */
  const subagents = new Map();
  /** @type {Map<string, any[]>} agentId → ActivityEntry[] */
  const logs = new Map();

  /** @param {string} agentId @param {any} e */
  function push(agentId, e) {
    const log = logs.get(agentId) || [];
    logs.set(agentId, log);
    const entry = { seq: (log.length ? log[log.length - 1].seq : 0) + 1, at: Date.now(), subagentId: '', ...e };
    log.push(entry);
    if (log.length > 5000) log.splice(0, log.length - 5000);
    return entry;
  }

  /** Seed a believable log: the session's own lines with each subagent's lines in between. @param {string} agentId */
  function seedLog(agentId, prompt, subs, t0) {
    const log = [];
    let seq = 0;
    let t = t0;
    const add = (/** @type {any} */ e) => { t += 4000 + (seq % 5) * 1500; log.push({ seq: ++seq, at: t, subagentId: '', ...e }); };
    add({ kind: 'session_start', text: 'startup' });
    add({ kind: 'prompt', text: prompt });
    add({ kind: 'tool', tool: 'Read', detail: 'package.json' });
    add({ kind: 'tool_done', tool: 'Read', detail: 'package.json', ms: 12 });
    for (const s of subs) {
      add({ kind: 'tool', tool: 'Agent', detail: s.title });
      add({ kind: 'subagent_start', subagentId: s.id, text: s.title, type: s.type });
      const tools = TOOLS[s.type] || TOOLS['general-purpose'];
      const n = s.state === 'running' ? 3 : 4;
      for (let i = 0; i < n; i++) {
        const [tool, detail] = tools[i % tools.length];
        add({ kind: 'tool', subagentId: s.id, tool, detail });
        const failed = s.state === 'failed' && i === n - 1;
        add({ kind: failed ? 'tool_error' : 'tool_done', subagentId: s.id, tool, detail, ms: tool === 'Bash' ? 4200 + i * 300 : 20 + i * 7 });
      }
      if (s.state !== 'running') add({ kind: 'subagent_end', subagentId: s.id, text: s.summary || '' });
      s.counts = { tools: n, errors: s.state === 'failed' ? 1 : 0 };
      s.startedAt = log.find((x) => x.kind === 'subagent_start' && x.subagentId === s.id).at;
      s.updatedAt = t;
      if (s.state !== 'running') s.endedAt = t;
      else { const [tool, detail] = tools[(n) % tools.length]; s.tool = tool; s.detail = detail; add({ kind: 'tool', subagentId: s.id, tool, detail }); }
    }
    return log;
  }

  for (const [agentId, defs] of Object.entries(SUBAGENT_SEED)) {
    const e = ctx.state.agents.get(agentId);
    if (!e) continue;
    const subs = defs.map(([id, title, type, background, state, summary]) => ({
      id, agentId, title, type, state, background, counts: { tools: 0, errors: 0 }, summary: summary || undefined, startedAt: 0, updatedAt: 0,
    }));
    subagents.set(agentId, subs);
    logs.set(agentId, seedLog(agentId, e.agent.prompt || e.status.lastPrompt || 'Work on it', subs, now - 30 * 60e3));
    e.status.subagents = { running: subs.filter((s) => s.state === 'running').length, total: subs.length };
  }
  // The other agents get a short log of their own.
  for (const e of ctx.state.agents.values()) {
    if (logs.has(e.agent.id)) continue;
    const log = seedLog(e.agent.id, e.agent.prompt || e.status.lastPrompt || 'Work on it', [], now - 20 * 60e3);
    if (e.status.state === 'working' && e.status.tool) log.push({ seq: log.length + 1, at: now - 5e3, subagentId: '', kind: 'tool', tool: e.status.tool, detail: e.status.detail || '' });
    logs.set(e.agent.id, log);
  }
  // A subagent's permission prompt: refactor-auth's prompt is for "Update middleware tests".
  const ra = ctx.state.agents.get('refactor-auth');
  if (ra && ra.status.permission) {
    ra.status.askedBy = 'a1f0c2e9d1b7a0002';
    const s = (subagents.get('refactor-auth') || [])[1];
    if (s) { s.needsYou = true; s.tool = 'Bash'; s.detail = 'npm install jsonwebtoken@9'; }
  }

  // ---- outside sessions ----
  const ccSpace = ctx.state.spaces.find((/** @type {any} */ s) => s.id === 'cc-dashboard');
  const pathJoin = (/** @type {string} */ a, /** @type {string} */ b) => (a.endsWith('/') || a.endsWith('\\') ? a + b : `${a}${a.includes('\\') ? '\\' : '/'}${b}`);
  /** @type {any[]} */
  let external = [];
  if (ccSpace) {
    external.push(
      { id: 'ext:5f0c8a10-1111-4c1e-9a0b-00000000vsc0', sessionId: '5f0c8a10-1111-4c1e-9a0b-00000000vsc0', pid: 41200, cwd: ccSpace.path, spaceId: ccSpace.id,
        name: 'review PR comments', state: 'working', tool: 'Read', detail: 'src/core/server.js', lastPrompt: 'Go through the open review comments and fix them',
        entrypoint: 'vscode', version: '2.1.332', startedAt: now - 50 * 60e3, updatedAt: now - 15e3, subagents: { running: 1, total: 1 } },
      { id: 'ext:6a1d9b21-2222-4d2f-8b1c-00000000cli0', sessionId: '6a1d9b21-2222-4d2f-8b1c-00000000cli0', pid: 41388, cwd: ccSpace.path, spaceId: ccSpace.id,
        name: 'quick question', state: 'idle', lastPrompt: 'What does fixRoles do?', entrypoint: 'cli', version: '2.1.332',
        startedAt: now - 2 * 3600e3, updatedAt: now - 40 * 60e3, subagents: { running: 0, total: 0 } },
    );
  }
  const notesPath = pathJoin(ctx.base, 'notes');
  external.push({ id: 'ext:7b2eac32-3333-4e30-9c2d-00000000note', sessionId: '7b2eac32-3333-4e30-9c2d-00000000note', pid: 41502, cwd: notesPath,
    name: 'notes', state: 'idle', lastPrompt: 'Summarise this week', entrypoint: 'cli', version: '2.1.330',
    startedAt: now - 5 * 3600e3, updatedAt: now - 3 * 3600e3, subagents: { running: 0, total: 0 } });
  for (const x of external) {
    const subs = x.subagents.total ? [{ id: 'd4b3f5c2e4a0d0001', agentId: x.id, title: 'Collect review threads', type: 'Explore', state: 'running', background: false,
      counts: { tools: 0, errors: 0 }, startedAt: 0, updatedAt: 0 }] : [];
    subagents.set(x.id, subs);
    logs.set(x.id, seedLog(x.id, x.lastPrompt, subs, x.startedAt));
  }

  const subsOf = (/** @type {string} */ agentId) => subagents.get(agentId) || [];
  /** @param {any} p */
  function needKnown(p) {
    const id = p && p.agentId;
    if (typeof id !== 'string' || !id) throw ctx.fail(ctx.ERRORS.NOT_FOUND, `no agent ${id}`); // like the real core's getAgent
    if (id.startsWith('ext:') ? !external.some((x) => x.id === id) : !ctx.state.agents.has(id)) throw ctx.fail(ctx.ERRORS.NOT_FOUND, `no agent ${id}`);
    return id;
  }

  const methods = {
    'subagents.list': (/** @type {any} */ p) => subsOf(needKnown(p)).map((s) => ({ ...s })),
    'activity.list': (/** @type {any} */ p) => {
      const id = needKnown(p);
      let log = logs.get(id) || [];
      if (typeof p.subagentId === 'string') log = log.filter((e) => e.subagentId === p.subagentId);
      if (typeof p.before === 'number') log = log.filter((e) => e.seq < p.before);
      const limit = Math.max(1, Math.min(1000, Number(p.limit) || 200));
      return { entries: log.slice(-limit), more: log.length > limit };
    },
    'external.list': () => external.map((x) => ({ ...x })),
    'external.takeOver': (/** @type {any} */ p) => {
      const x = external.find((s) => s.id === (p && p.id));
      if (!x) throw ctx.fail(ctx.ERRORS.NOT_FOUND, `no outside session ${p && p.id}`);
      if (x.state === 'working' && !p.force) throw ctx.fail(ctx.ERRORS.STILL_WORKING, `${x.name} is still working`);
      let spaceId = p.spaceId || x.spaceId;
      if (!spaceId) spaceId = ctx.addSpace(x.cwd, x.name).id;
      const agent = ctx.createAgent({ spaceId, name: p.name || x.name, cwd: x.cwd, sessionId: x.sessionId, prompt: x.lastPrompt });
      // The log moves with the session.
      logs.set(agent.id, logs.get(x.id) || []);
      subagents.set(agent.id, subsOf(x.id).map((s) => ({ ...s, agentId: agent.id, state: s.state === 'running' ? 'stopped' : s.state })));
      logs.delete(x.id);
      subagents.delete(x.id);
      external = external.filter((s) => s !== x);
      ctx.broadcast('external.changed', { sessions: methods['external.list']() });
      return agent;
    },
  };

  /** One tick of mock life: every running subagent (and the working outside session) does something. */
  let tick = 0;
  function step() {
    tick++;
    for (const [agentId, subs] of subagents) {
      const out = [];
      for (const s of subs) {
        if (s.state !== 'running' || s.needsYou) continue;
        const tools = TOOLS[s.type] || TOOLS['general-purpose'];
        const [tool, detail] = tools[(tick + s.title.length) % tools.length];
        if (s.tool) out.push(push(agentId, { kind: 'tool_done', subagentId: s.id, tool: s.tool, detail: s.detail, ms: s.tool === 'Bash' ? 3800 : 25 }));
        out.push(push(agentId, { kind: 'tool', subagentId: s.id, tool, detail }));
        Object.assign(s, { tool, detail, updatedAt: Date.now(), counts: { ...s.counts, tools: s.counts.tools + 1 } });
        ctx.broadcast('subagent.updated', { agentId, subagent: { ...s } });
      }
      if (out.length) ctx.broadcast('activity', { agentId, entries: out });
    }
    const w = external.find((x) => x.state === 'working');
    if (w) {
      const [tool, detail] = TOOLS.Explore[tick % TOOLS.Explore.length];
      Object.assign(w, { tool, detail, updatedAt: Date.now() });
      ctx.broadcast('external.changed', { sessions: methods['external.list']() });
    }
  }

  return { methods, step, subagents, logs, external: () => external, push };
}

module.exports = { activityMethods };
