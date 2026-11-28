---
type: spec
status: draft
tags: [m4, research, indexer, mcp, codegraph, code-index-mcp, cost, latency]
relatedTo: [docs/M4.md]
---

# Indexer trial (M4 track E)

Question: would a code index (an MCP code-index server) make agents in CC-Dashboard cheaper or faster?

**Short answer: faster, not cheaper.** With codegraph, the same three tasks took 53% less wall time and 67% fewer
tool calls, with the same answer quality. Cost stayed flat (+0.6%). The second server (code-index-mcp) was never
used by the model, so it changed nothing. **Recommendation: adopt codegraph as an opt-in Library item. Do not
build our own now. Skip code-index-mcp.**

## Usage estimate (written before any run)

- Runs: 3 tasks × 3 arms (no index, codegraph, code-index-mcp) = **9 runs**. Up to 3 spare runs, only if a run
  breaks for a reason outside the model (a server that does not start). **Hard cap: 12 runs.** No retries for
  bad answers: a bad answer is a result.
- Model: `--model haiku` for every run. Headless, `--max-budget-usd 0.50` per run, 10 minute timeout.
- Expected per run: 5–20 turns. Claude Code's own prompt and tools are about 15–25k tokens and are cached after
  the first turn, so most input is cache reads: about 200k–600k cache-read tokens, 30k–60k cache-write tokens,
  1k–4k uncached input and 1k–4k output tokens.
- Expected cost per run: about $0.01–0.02 if `haiku` resolves to Haiku 5.5 ($0.10 / $0.50 per million), about
  $0.10–0.20 if it resolves to Haiku 4.5 ($1 / $5). **Whole trial: about 9 × 400k ≈ 4M tokens, $0.15 to $2.**

**Actual:** 10 runs used of 12. One run failed at once with a 401 and used 0 tokens (see Setup). The 9 real runs
used **990k tokens and $0.051** (API-equivalent; `haiku` resolved to `claude-haiku-5-5`). Well under the estimate.

## Setup

- **Sample repo:** fastify v5.9.0 (commit `2e45a44`), shallow clone in the session scratchpad, not in the
  worktree. 392 files, 298 JS/TS source files, 31 in `lib/`.
- **Servers** (both need no native build on Windows):
  - **codegraph** `@colbymchenry/codegraph@1.6.5` (npm, MIT). Ships a prebuilt per-platform binary with its own
    runtime, tree-sitter parsing, `node:sqlite` store, file watcher. One MCP tool, `codegraph_explore`, plus long
    server instructions. Index: `codegraph init -y --local-only <repo>`: 319 files, 2,989 symbols, 9,132 edges,
    **12 s, 16 MB** in `<repo>/.codegraph/`.
  - **code-index-mcp** `code-index-mcp==2.17.1` (PyPI, via `uvx`). Python, 42 packages, all wheels. 14 MCP tools
    (`search_code_advanced`, `find_files`, `get_file_summary`, `get_symbol_body`, `build_deep_index`, ...).
- **Install, the way the Library would (the `claude` CLI), local scope for the sample repo only:**
  ```
  cd <scratch>/index-trial/fastify
  claude mcp add --scope local trial-codegraph -e CODEGRAPH_TELEMETRY=0 -- codegraph serve --mcp --no-telemetry --path <repo>
  claude mcp add --scope local trial-codeindex -e UV_SYSTEM_CERTS=1 -- uvx code-index-mcp@2.17.1 --project-path <repo> --indexer-path <scratch>/index-trial/ci-index
  claude mcp list     # both: ✔ Connected
  ```
- **Runs** (`scripts/index-trial/run.js`): `claude -p <task> --model haiku --output-format stream-json --verbose
  --no-session-persistence --setting-sources project,local --strict-mcp-config --mcp-config <arm.json>
  --allowedTools Read Grep Glob [mcp__<server>] --disallowedTools Bash Edit Write NotebookEdit WebFetch WebSearch
  Agent Task --max-budget-usd 0.50`. The `--mcp-config` files hold the same server definitions as the local-scope
  installs. `--strict-mcp-config` keeps the user's own user-scope servers out of every arm (the user already has
  codegraph at user scope). Index arms get one extra sentence: "A code index MCP server is available; use it
  where it helps."
- **Auth:** the first run inherited an `ANTHROPIC_API_KEY` from the parent agent session and got a 401 (0
  tokens). `run.js` now passes an explicit env without that key and without the parent's `CLAUDECODE` /
  `CLAUDE_CODE_*` markers, so each run uses the user's own CLI login.
- **Measured with** `scripts/index-trial/measure.js` (stream-json `result` line: Claude's `total_cost_usd`,
  `duration_ms`, session `usage`; tool calls from `tool_use` blocks). `self-check.js` tests it on synthetic logs.

## Tasks

1. **Definition and callers.** "Where is `wrapThenable` defined, and which functions call it (outside tests)?"
   Truth: `lib/wrap-thenable.js:12`; called in `handleError` (`lib/error-handler.js:73`) and
   `preHandlerCallbackInner` (`lib/handle-request.js:190`). Score out of 3.
2. **Flow A to B.** "Explain the flow from an incoming HTTP request to the user's route handler; say where
   onRequest, preParsing, preValidation and preHandler run." Truth: `wrapRouting/preRouting` → `router.lookup` →
   `routeHandler` (onRequest) → `runPreParsing` (preParsing) → `handleRequest` (body parse) → `handler`
   (preValidation) → validation → `validationCompleted` (preHandler) → `preHandlerCallbackInner` →
   `context.handler`. Score out of 8 steps.
3. **Find every place.** "Every place in `lib/` and `fastify.js` that reads or writes `kReplySerializerDefault`."
   Truth: 8 sites (`fastify.js:162, 764`, `context.js:71`, `reply.js:433, 525`, `route.js:352, 390`,
   `symbols.js:60`). Score out of 8.

## Raw numbers

One run per cell. Cost is Claude's own `total_cost_usd` (API-equivalent estimate, not a bill).

| Task / arm | Grep | Glob | Read | Index | Calls | Turns | Tokens (in / out / cache W / cache R) | Cost $ | Wall s | Quality |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 none | 3 | 0 | 2 | 0 | 5 | 6 | 8 / 1,444 / 12,705 / 61,812 | 0.0039 | 22.5 | 3/3 |
| T1 codegraph | 0 | 0 | 0 | 1 | **1** | 2 | 4 / 626 / 21,262 / 19,220 | 0.0048 | **4.9** | 3/3 |
| T1 code-index | 3 | 0 | 2 | 0 | 5 | 6 | 8 / 1,502 / 9,805 / 64,688 | 0.0034 | 22.7 | 3/3 |
| T2 none | 7 | 1 | 12 | 0 | 20 | 21 | 18 / 7,908 / 23,650 / 219,966 | 0.0109 | 78.8 | 8/8 |
| T2 codegraph | 3 | 0 | 2 | 2 | **7** | 8 | 12 / 4,280 / 30,335 / 173,946 | 0.0099 | **37.5** | 8/8 |
| T2 code-index | 6 | 0 | 12 | 0 | 19¹ | 20 | 16 / 7,952 / 24,320 / 190,994 | 0.0108 | 66.7 | 8/8 |
| T3 none | 1 | 0 | 0 | 0 | 2¹ | 3 | 4 / 1,220 / 8,152 / 27,285 | 0.0025 | 12.0 | 8/8 |
| T3 codegraph | 1 | 0 | 0 | 0 | 1 | 2 | 4 / 1,159 / 9,229 / 30,068 | 0.0027 | 11.4 | 8/8 |
| T3 code-index | 1 | 0 | 0 | 0 | 1 | 2 | 4 / 1,110 / 8,127 / 27,611 | 0.0025 | 11.2 | 8/8 |

¹ includes one attempted `Bash` call (Bash was disallowed).

Per arm, all three tasks:

| Arm | Calls | Tokens | Cost $ | Wall s | Quality |
|---|---|---|---|---|---|
| none | 27 | 364k | 0.0173 | 113.3 | 19/19 |
| codegraph | 9 (−67%) | 290k (−20%) | 0.0174 (+0.6%) | 53.8 (−53%) | 19/19 |
| code-index-mcp | 25 (−7%) | 336k (−8%) | 0.0167 (−3%) | 100.6 (−11%) | 19/19 |

Fixed prompt cost per turn: the first request was 17.0k tokens with no index, 19.2k with codegraph (+2.2k: its
tool and server instructions), 17.4k with code-index-mcp (+0.4k).

## Findings

1. **codegraph makes lookup and flow tasks about 2× faster.** T1: 1 call instead of 5, 4.9 s instead of 22.5 s.
   T2: 7 calls instead of 20, 37.5 s instead of 78.8 s. It returns source plus call paths in one call, so the model
   needs fewer turns. Answer quality was the same: all arms got every task right.
2. **It does not make them cheaper.** 20% fewer tokens, same cost. The tokens it saves are cheap cache reads.
   What it adds is expensive: +2.2k tokens of instructions on every request, and big tool results that become
   cache writes (cache writes cost 12.5× cache reads). T1 cost 23% more with the index, T2 9% less. The ratio of
   write to read prices is the same for Sonnet and Opus, so the result should hold there too. That is a reasoned
   guess, not a measurement.
3. **On simple text searches an index adds nothing.** T3 (find a symbol name) is one Grep for everyone. The
   codegraph arm also chose Grep.
4. **A server the model does not pick is worth nothing.** Haiku never called code-index-mcp, in all three tasks,
   even though the prompt said an index was there. It has 14 generic tools and no strong instructions; Grep looked
   good enough. codegraph's server instructions tell the model to call it first, and it did.
5. **Operational problems seen:**
   - codegraph **left a background daemon** for the sample repo running after the sessions ended. It held the
     database open, and `codegraph uninit` failed with EPERM until the process was stopped by hand.
   - codegraph sends **telemetry by default**. It needs `--no-telemetry` or `CODEGRAPH_TELEMETRY=0`.
   - codegraph writes a 16 MB `.codegraph/` folder into the repo (git-ignored with `--local-only`).
   - code-index-mcp wrote a shallow index to `%TEMP%\code_indexer\` even though `--indexer-path` was set.
   - `uvx` failed TLS on this machine (`invalid peer certificate: UnknownIssuer`) until `UV_SYSTEM_CERTS=1` was
     set. Python tools add one more thing that can break on a user's machine.
6. **Limits of this trial.** One run per cell, so expect noise. One JS repo of ~300 files. Haiku 5.5 only. The
   user's global CLAUDE.md was still loaded in every arm (it was not turned off by `--setting-sources`), and it
   mentions codegraph and another code-map tool. That may make the model more willing to use an index. The
   index arms were told an index exists. Subagents and Bash were turned off to compare the plain tool loop.

## Recommendation: adopt (opt-in), do not build, skip code-index-mcp

- **Adopt codegraph 1.6.5 as an opt-in Library item**, per space, never on by default. It helps where waiting
  matters: the user watches an agent explore code. It does not save money, so the Library text should say
  "faster code questions", not "cheaper".
  - Install per space at local scope (or, better, see the next point), always with `--no-telemetry`, pinned
    version, index built with `init -y --local-only`.
  - Removing it must also stop its daemon and delete `.codegraph/`.
- **Better than editing Claude's config:** the core already starts every agent with `--settings`. It could also
  pass `--mcp-config <CC_HOME>/spaces/<id>/mcp.json` for spaces that turned the index on. Then nothing is written
  to `~/.claude.json`, and removing it is deleting one file.
- **Contract gap (not changed):** `protocol.js` has `library.pluginAction` but no method for a standalone MCP
  server (only MCP servers bundled in plugins are listed). Adopting needs something like
  `library.mcpAction { spaceId, name, action: 'add'|'remove' }` and a field on the space. That is the lead's call.
- **Do not build our own now.** The gain is speed, not cost, and codegraph already gives it. A home-built server
  would be weeks of work to match it. Build only if codegraph becomes a problem (licence, telemetry,
  maintenance, Windows breakage).
- **Skip code-index-mcp.** The model did not use it, and it brings Python and TLS trouble.
- **Next measurement, if wanted:** the same tasks on Sonnet, 3 runs per cell, on a larger repo (2,000+ files),
  where Grep and Read get more expensive and an index should gain more.

### If we build later (sketch only)

- **Shape:** one local MCP server process per space, started by the core, stdio, plain Node, no new runtime
  dependencies except a WebAssembly tree-sitter (`web-tree-sitter` + `.wasm` grammars, no native build).
- **Deterministic first, no embeddings:** tools `symbols(query)`, `outline(file)`, `imports(file)`,
  `references(symbol)`, `callers(symbol)`. Results small and line-numbered, so they stay cheap as cache writes.
- **Store:** a JSON or `node:sqlite` file in `<CC_HOME>/index/<spaceId>/`, never inside the repo.
- **Incremental:** `fs.watch` on the space folder (with a polling fallback), re-parse only changed files, a full
  rebuild on branch switch.
- **Managed from the Library:** on/off per space, index size and age, "rebuild", injected with `--mcp-config`.
- **Short server instructions** (well under codegraph's 2.2k tokens), since they are paid on every request.
- **Effort:** about 2–3 weeks for one engineer for JS/TS/Python, plus tests with fixture repos.

## Clean-up (done)

- `claude mcp remove --scope local trial-codegraph` and `claude mcp remove --scope local trial-codeindex` (run in
  the sample repo). `claude mcp list` shows no `trial-*` server. The user-scope `codegraph` entry was never touched.
- Stopped the leftover codegraph daemon for the sample repo, then `codegraph uninit --force <repo>`: `.codegraph/`
  is gone.
- `uv cache clean code-index-mcp` (79 files); deleted `<scratch>/index-trial/ci-index` and
  `%TEMP%\code_indexer\` (created by this trial, holding only the sample repo's shallow index).
- The sample repo, the MCP config files and the raw run logs stay in the session scratchpad
  (`.../scratchpad/index-trial/`), outside every worktree.
- No product code, tests or settings files were changed.
