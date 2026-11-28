# Status-line fixtures

Real JSON that Claude Code 2.1.332 piped to a `statusLine` command (Windows, a 1M-context account on a
subscription), with ids, paths and usage numbers replaced.

- `startup.json`: the first update, before any reply. `context_window.used_percentage` and `current_usage` are
  `null`, and there is no `rate_limits`.
- `sample.json`: after a reply. `context_window.context_window_size` is 1000000, `used_percentage` 10,
  `rate_limits.five_hour` / `seven_day` carry `used_percentage` and `resets_at` (epoch **seconds**).

Fields Claude adds over time (`prompt_cache`, `thinking`, `effort`, ...) must be ignored, not relied on.
