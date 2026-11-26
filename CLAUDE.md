# CC-Dashboard: working rules

Read `docs/ARCHITECTURE.md` first (and `docs/M2.md` for milestone 2: who owns which files). The contract between the core and the app is `packages/shared/protocol.js`.

- Plain JavaScript, `// @ts-check` + JSDoc. CommonJS in `packages/core` and the Electron main process; ES modules in the renderer. No bundler, no TypeScript build.
- Windows is the first target. Never hard-code `/` paths, `bash`, `/tmp` or POSIX-only calls; use `path`, `os.tmpdir()`, `process.platform` checks. Spawning `claude` must work with `claude.exe` / `claude.cmd`.
- Do not change `packages/shared/protocol.js` on your own. If the contract is missing something, write it down in your final report and work around it.
- Tests use Node's built-in runner (`node --test`). Use `tests/fake-claude.js` via `CC_CLAUDE`, and `CC_HOME=<temp dir>` so tests never touch real files. Never call the real Claude in tests.
- Every new behaviour gets a test. `npm test` must pass before you finish.
- Keep commits small, with clear messages. Do not push; the lead merges.
