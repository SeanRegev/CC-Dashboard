// @ts-check
'use strict';
/**
 * Mock `usage.get` / `usage.changed` (contract v4) for the dev mock core (screenshots, e2e).
 * Owner: lead (M4 wave 0); the UI track may add seed data, keeping the shapes in protocol.js.
 *
 * Seed (opts.usage):
 *   'normal'  (default) 5h 62% resets in 2h10m, week 31%; reported by fix-flaky-tests
 *   'high'    5h 93% (≥ 90: red, and the New agent dialog warns), week 78%
 *   'none'    no limits seen yet (limits.updatedAt 0), e.g. an API-key account
 * byAgent / bySpace / byDay: made-up API-equivalent costs and tokens for the seeded agents, the last 7 days.
 * Without MOCK_STATIC the 5-hour % creeps up by 1 every few ticks and usage.changed is sent.
 */

/** Fake per-agent cost and tokens, stable per name. @param {string} name */
function agentTotals(name) {
  const h = [...name].reduce((x, ch) => (x * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const input = 20_000 + (h % 400_000);
  const output = 2_000 + (h % 30_000);
  return { costUsd: Math.round((input * 3 + output * 15) / 1e4) / 100, inputTokens: input, outputTokens: output };
}

/** Local "YYYY-MM-DD". @param {number} ms */
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * @param {{broadcast:(e:string,d:any)=>void, state:any, usage?: 'normal'|'high'|'none', now?: number}} ctx
 */
function usageMethods(ctx) {
  const now = ctx.now || Date.now();
  const kind = ctx.usage || 'normal';
  /** @type {any} */
  const usage = { limits: { updatedAt: 0 }, byAgent: {}, bySpace: {}, byDay: {}, updatedAt: now };
  if (kind !== 'none') {
    const high = kind === 'high';
    usage.limits = {
      fiveHour: { usedPct: high ? 93 : 62, resetsAt: now + (2 * 60 + 10) * 60e3 },
      sevenDay: { usedPct: high ? 78 : 31, resetsAt: now + 3 * 86400e3 + 5 * 3600e3 },
      updatedAt: now - 40e3,
      fromAgentId: 'fix-flaky-tests',
    };
  }
  const add = (/** @type {any} */ into, /** @type {any} */ t) => {
    into.costUsd = Math.round(((into.costUsd || 0) + t.costUsd) * 100) / 100;
    into.inputTokens = (into.inputTokens || 0) + t.inputTokens;
    into.outputTokens = (into.outputTokens || 0) + t.outputTokens;
    return into;
  };
  for (const e of ctx.state.agents.values()) {
    const t = agentTotals(e.agent.name);
    usage.byAgent[e.agent.id] = { ...t, name: e.agent.name, spaceId: e.agent.spaceId };
    usage.bySpace[e.agent.spaceId] = add(usage.bySpace[e.agent.spaceId] || {}, t);
  }
  // A removed agent still shows in the totals, under the name it had.
  usage.byAgent['old-migration'] = { costUsd: 1.84, inputTokens: 512_000, outputTokens: 21_400, name: 'old-migration', spaceId: 'storefront' };
  if (usage.bySpace.storefront) add(usage.bySpace.storefront, usage.byAgent['old-migration']);
  for (let i = 6; i >= 0; i--) {
    const f = [0.4, 1.1, 0.2, 0, 2.3, 1.7, 0.9][6 - i];
    if (!f) continue;
    usage.byDay[dayKey(now - i * 86400e3)] = { costUsd: Math.round(f * 3.1 * 100) / 100, inputTokens: Math.round(f * 900_000), outputTokens: Math.round(f * 38_000) };
  }

  const methods = {
    'usage.get': () => JSON.parse(JSON.stringify(usage)),
  };

  let tick = 0;
  function step() {
    tick++;
    if (!usage.limits.fiveHour || tick % 3) return;
    usage.limits.fiveHour.usedPct = Math.min(100, usage.limits.fiveHour.usedPct + 1);
    usage.limits.updatedAt = Date.now();
    usage.updatedAt = Date.now();
    ctx.broadcast('usage.changed', { usage: methods['usage.get']() });
  }

  /** Replace the limits (tests). @param {any} limits */
  function setLimits(limits) {
    usage.limits = { ...limits };
    usage.updatedAt = Date.now();
    ctx.broadcast('usage.changed', { usage: methods['usage.get']() });
  }

  return { methods, step, usage, setLimits };
}

module.exports = { usageMethods, agentTotals, dayKey };
