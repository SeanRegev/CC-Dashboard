---
type: spec
status: draft
tags: [m4, research, indexer, mcp, cost]
relatedTo: [docs/M4.md]
---

# Indexer trial (M4 track E)

Question: would a code index (an MCP code-index server) make agents in CC-Dashboard cheaper or faster?

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
