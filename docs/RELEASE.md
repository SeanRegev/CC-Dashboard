# Releasing CC-Dashboard

## What CI does

Every push and pull request runs `.github/workflows/ci.yml` on GitHub Actions:

| Job | Runner | Steps |
|---|---|---|
| **Windows - tests + installer** (`test-windows`) | `windows-2022`, Node 22 | `npm ci` (node-pty installs from its prebuilt Windows binaries; nothing is compiled) → `npm test` (unit tests + core tests: the real core runs `tests/fake-claude.js` in ConPTY) → `npm run test:e2e` (Electron app + core) → `npx electron-builder --win nsis portable --publish never` → `node scripts/check-package.js dist/win-unpacked` → upload `dist/*.exe` |
| **Linux - tests + e2e** (`test-linux`) | `ubuntu-latest`, Node 22 | `npm ci` → `npm test` → `xvfb-run -a npm run test:e2e` → `electron-builder --linux dir` + package check (validates the packaging config) → upload `test-results/` (screenshots, core logs) |

`scripts/check-package.js` fails the build if the packaged app is missing files the installed core needs from
disk, if node-pty can't open a terminal when run by the packaged exe as Node (`ELECTRON_RUN_AS_NODE=1`), or if a
hook run the way Claude Code runs it (the shell starts the launcher, which starts the packaged exe on `hook.js`, JSON
on stdin) doesn't reach the core. These fail on a user's machine otherwise, and the unit tests can't see them: they
run hooks with plain `node`, while the installed app runs them with its own GUI-subsystem exe.

Packaging config: `electron-builder.yml`. Icon: `build/icon.svg` → `build/icon.png` + `build/icon.ico`
(regenerate with `npm run icon`, or `npx electron scripts/make-icon.js` where Playwright's Chromium isn't installed).

## Cutting a release

```bash
npm run release -- patch     # 0.1.0 -> 0.1.1; also minor, major, or an exact version (1.0.0, 1.0.0-beta.1)
git push origin main --follow-tags
```

`npm run release` (`scripts/release.js`) refuses unless you're on `main`, the tree is clean and `main` is up to date
with `origin/main`; it runs `npm test`, then `npm version`, which bumps `package.json` + `package-lock.json`,
commits *"Release vX.Y.Z"* and creates the tag `vX.Y.Z`. Add `--push` to push `main` and the tag in one go.

The tag starts `.github/workflows/release.yml` (Windows, `windows-2022`):

1. `node scripts/release.js --check-tag <tag>`: the tag must be `vMAJOR.MINOR.PATCH[-suffix]` and equal the
   `package.json` version, or the run stops before anything slow.
2. `npm ci` → `npm test` → `npm run test:e2e` → `electron-builder --win nsis portable` → `check-package.js`.
3. `SHA256SUMS.txt` for the two exe files.
4. `gh release create`: a GitHub Release titled *CC-Dashboard X.Y.Z* with the installer, the portable exe and the
   checksums. Its notes are an install section (`release.js --notes`) followed by GitHub's generated changelog
   (merged pull requests and contributors since the previous tag). A version with a suffix becomes a **pre-release**.

If the run fails, nothing is published: fix it on `main`, then delete the tag (`git push origin :refs/tags/vX.Y.Z`
and `git tag -d vX.Y.Z`) and release again, or release the next patch version.

The app's version (shown at the bottom of the sidebar, and in the installer's file name) is `package.json`'s.
The release tests (`tests/unit/release.test.js`) pin the workflow's order: no publishing before the tests and the
package check pass.

## Download a test build (any commit)

Every CI run also keeps the installer as a workflow artifact for 30 days:

1. Open the repository on GitHub → **Actions** → **CI**.
2. Click the run for the commit you want (green check).
3. Scroll to **Artifacts** at the bottom of the run page and download **CC-Dashboard-windows** (a zip; artifacts
   are kept 30 days and you must be signed in to GitHub).
4. Unzip it. Inside:
   - `CC-Dashboard-Setup-<version>.exe`: the installer (recommended).
   - `CC-Dashboard-Portable-<version>.exe`: runs without installing.

## Before you install

- **Windows 10 or 11, 64-bit.**
- **Claude Code installed natively on Windows and signed in.** Open PowerShell and run `claude`. It must start and
  be logged in. CC-Dashboard starts that same `claude` for every agent; it does not install or sign in to Claude
  for you. (Claude Code inside WSL only is not enough: `claude` must work in a normal PowerShell window.)

## Install

1. Run `CC-Dashboard-Setup-<version>.exe`.
2. The app is not code-signed yet, so Windows SmartScreen shows **"Windows protected your PC"**.
   Click **More info** → **Run anyway**. (The portable exe shows the same warning.)
3. Choose per-user or all-users, pick an install folder if you want, and finish. You get a desktop shortcut and a
   Start-menu entry, **CC-Dashboard**.
4. Uninstall from **Settings → Apps → Installed apps → CC-Dashboard**. Your data in `%USERPROFILE%\.cc-dashboard`
   (spaces, agents) is kept.

## Building locally

- `npm test`: unit + core tests (system Node).
- `npm run test:e2e`: e2e tests (needs a display; on Linux run `xvfb-run -a npm run test:e2e`).
- `npm run dist:win` (on Windows) or `npm run dist:dir` (unpacked app for the current OS), then
  `node scripts/check-package.js`.
- node-pty (1.1+) is a Node-API addon, so packaging does **not** rebuild it (`npmRebuild: false`): the binary
  that `npm install` put in place works in Node and in Electron alike, and `npm test` keeps working after a build.
- Building the Windows installer on Linux is not supported; CI builds it on Windows.

## Notes for the core and app code (packaging rules)

The installed layout is (`<install>` = the chosen folder, e.g. `%LOCALAPPDATA%\Programs\CC-Dashboard`):

```
<install>\CC-Dashboard.exe
<install>\resources\app.asar                      main process + renderer (read-only archive)
<install>\resources\app.asar.unpacked\packages\core\...      the core, on disk
<install>\resources\app.asar.unpacked\packages\shared\...    the contract, on disk
<install>\resources\app.asar.unpacked\node_modules\node-pty\...  (.node files, winpty-agent.exe, winpty.dll)
<install>\resources\app.asar.unpacked\node_modules\ws\...
```

- **Starting the core (main process):** when `app.isPackaged`, run
  `process.execPath` with env `ELECTRON_RUN_AS_NODE=1` and the script
  `path.join(process.resourcesPath, 'app.asar.unpacked', 'packages', 'core', 'src', 'index.js')`.
  In development (`!app.isPackaged`) use the repo path `packages/core/src/index.js`. Never point the core at a path
  inside `app.asar`.
- **Inside the core, build file paths from `__dirname`** (e.g. `path.join(__dirname, 'hook.js')`). Because the core
  runs from `app.asar.unpacked`, those paths are real files that `claude` and its hook commands can use.
  If code inside `app.asar` (the main process) needs such a path, translate it with
  `p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)`.
- **Hook commands** run by `claude` (through `cmd.exe` on Windows) must not assume `node` is on the user's PATH.
  In the installed app the only Node is the app's own exe, so the command must run `process.execPath` (quoted, the
  path has spaces in many installs) with `ELECTRON_RUN_AS_NODE=1` set for that command only, and quote the
  `hook.js` path. Do not set `ELECTRON_RUN_AS_NODE` in the environment of `claude` itself: anything Electron-based it
  launches (e.g. VS Code) would break.
- **New runtime dependency of the core?** Add it to `dependencies` (not `devDependencies`) and add
  `node_modules/<name>/**` (plus its own runtime deps) to `asarUnpack` in `electron-builder.yml`.
  `tests/unit/release-config.test.js` fails until you do.
- `CC_CLAUDE` is a command line, not a path: tests set `node <repo>/tests/fake-claude.js`; parse it with quotes in
  mind (paths may contain spaces).
- The app should honour `CC_DISABLE_GPU=1` (`app.disableHardwareAcceleration()`) and `CC_HOME`; e2e tests set both.
- Give the sidebar `data-testid="sidebar"`; the e2e smoke test reads agent names from it.
