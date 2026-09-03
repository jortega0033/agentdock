# Packaging

`apps/desktop/electron-builder.yml` configures [electron-builder](https://www.electron.build/) to
produce a distributable desktop app. Today that means a Windows NSIS installer, see
[Platform matrix](#platform-matrix) below for what's actually been verified versus what's merely
not-yet-attempted.

## Commands

```bash
pnpm build         # compiles every package, the prerequisite for packaging, not packaging itself
pnpm package:win   # pnpm build, then electron-builder --win nsis
pnpm package       # pnpm build, then electron-builder's current-platform defaults (unverified outside Windows)
```

On Windows, both package commands are non-interactive and run from a clean checkout after `pnpm
install`, with no code signing configured: there's nothing to sign with in this repository (see
[Unsigned installer](#unsigned-installer-and-smartscreen) below). Only `package:win` has a configured,
CI-verified target; the generic command is not a supported macOS/Linux release pipeline.

## What `pnpm build` produces (the prerequisite step)

- `packages/shared/dist/`, `packages/agent-runtime/dist/`: compiled library output (plain `tsc`)
- `apps/daemon/dist/index.js`: the daemon bundled by **esbuild** into one self-contained file,
  every dependency inlined (including the two packages above and `fastify`/`zod`), required so it
  can run under plain `node`, with no workspace resolution or `tsx`, once packaged. `tsc` alone
  can't produce this: `packages/shared` and `packages/agent-runtime` intentionally publish
  TypeScript source (their `package.json` `main` points at `src/index.ts`, not a built `dist/`) so
  `tsx`/Vite/Vitest get live source with no separate build step in dev, but that means a plain
  `node dist/index.js` with no loader can't resolve them through a bare package specifier. This
  was an actual bug, not a theoretical risk: caught by running the packaged-mode code path
  (`node dist/index.js`) and hitting `ERR_MODULE_NOT_FOUND`, see
  `apps/daemon/scripts/build.mjs` for the fix.
- On Windows, `apps/daemon/dist/claude-agent-sdk/`: the pinned Windows x64 SDK executable plus its
  SDK/native notices. The build executes `claude.exe --version` and rejects a package/version
  mismatch before staging it. Non-Windows builds skip this platform asset.
- `apps/desktop/dist/`: the Vite production build of the React renderer
- `apps/desktop/dist-electron/main.js`, `preload.js`: the Electron main process and preload
  script, each bundled to a single file (`main.js` inlines `@agent-dock/client`,
  `@agent-dock/shared`, and `zod`; `preload.js` is forced to CommonJS since Electron's sandboxed
  preload loader doesn't support ESM)

None of this is an installer yet: `electron .` against `apps/desktop` at this point runs the app
unpacked, useful for a quick check without a full package step.

## Output layout

```
dist-packages/
  win-unpacked/                       the unpacked app (AgentDock.exe + resources/)
  AgentDock-Setup-<version>.exe       the NSIS installer
```

`directories.output: ../../dist-packages` in `electron-builder.yml` deliberately keeps installer
output at the repo root, out of both `apps/desktop/dist/` (Vite) and `dist-electron/` (esbuild via
vite-plugin-electron), installer output never mixes with plain build artifacts. `dist-packages/` is
gitignored.

## Runtime layout once packaged

```
AgentDock.exe                    (Electron; renderer + main process live in resources/app.asar)
resources/
  app.asar                       renderer (dist/) + main + preload, no node_modules needed,
                                  everything is bundled at build time (see above)
  assets/app-icons/png/
    icon-256.png                 runtime window icon used outside packaged metadata surfaces
  daemon/
    index.js                     the daemon's own esbuild bundle, unmodified from apps/daemon/dist/
    agent-dock-job-host.exe      daemon-owned Windows Job Object process-tree host
    claude-agent-sdk/
      claude.exe                 pinned SDK executable, a real file outside app.asar
      NOTICE.txt                 version, terms, auth, and branding release notice
      LICENSE.*.md               upstream SDK/native notices
```

## Native application identity

The default AgentDock identity lives under `apps/desktop/assets/`. Electron Builder reads
`assets/app-icons/agent-dock.ico` for `AgentDock.exe`, the NSIS installer and uninstaller, and the
Start Menu shortcut. The runtime `BrowserWindow` resolves the committed 256-pixel PNG in
development and from `process.resourcesPath` after packaging.

The corresponding ICNS and full PNG size ladder are committed for platform tooling and future
targets, but macOS packaging is not yet configured or verified. See [assets.md](assets.md) for the
source SVGs, exact inventory, regeneration, validation, and fork rebranding steps.

## The daemon ships outside `app.asar`

`extraResources: [{ from: ../daemon/dist, to: daemon }]` in `electron-builder.yml` puts the daemon
bundle, Job Object host, and Claude Agent SDK executable _outside_ the asar archive entirely. They
are spawned as real OS processes rather than imported code. Asar is a virtual filesystem
Electron's own `fs` module knows how to read, but handing a path inside it to a freshly spawned
process is exactly the kind of "happens to work by accident" behavior this project avoids.

## `resolveDaemonEntry()`

`apps/desktop/electron/resolve-daemon-entry.ts` is a pure function (no Electron import, fully
unit-testable, see `apps/desktop/test/resolve-daemon-entry.test.ts`) with three cases, in priority
order:

1. **Dev server** (`VITE_DEV_SERVER_URL` set): always run `apps/daemon/src/index.ts` live through
   `tsx`, even if a stale `dist/` build exists from an earlier `pnpm build`.
2. **Packaged** (`app.isPackaged`): `process.resourcesPath/daemon/index.js`, never source, never
   `tsx`, since neither exists in a packaged build.
3. **Unpacked production build** (`pnpm build` ran but the app isn't packaged, e.g. `electron .`
   directly): prefer the daemon's own `dist/index.js` next to its source; fall back to `tsx` +
   source only if that build hasn't been run yet.

Tests assert packaged mode never falls through to the `tsx`/source path, since neither exists in a
real packaged build: that fallback silently working in dev but silently failing once packaged is
exactly the class of bug this function's test coverage exists to catch.

## What electron-builder treats as a runtime dependency

`react`, `react-dom`, and the `@agent-dock/shared`/`@agent-dock/client` workspace packages are fully
inlined into `dist/` and `dist-electron/main.js` at build time (Vite for the renderer, esbuild via
vite-plugin-electron for main). `zod` arrives transitively through `@agent-dock/shared` and is
bundled with it. The desktop package has no runtime `dependencies`; its direct runtime inputs live
in `devDependencies`, specifically so electron-builder's automatic production-dependency resolution
(which inspects `dependencies` and copies matching `node_modules` trees independently of the
`files` config) does not embed a second, unused, unbundled copy. This was caught by unpacking a real
built `app.asar` and finding `node_modules/@agent-dock/shared` inside it despite an explicit `files`
list that excluded `node_modules` entirely.

## Current dependency-audit exception

With the committed lockfile, `pnpm audit` currently exits nonzero for two high-severity advisories in
the `electron-builder` development-tool chain: `builder-util-runtime@9.2.10`
([GHSA-p2f4-r6v6-j797](https://github.com/advisories/GHSA-p2f4-r6v6-j797)) and
`app-builder-lib@25.1.8`
([GHSA-7g7r-gx96-252g](https://github.com/advisories/GHSA-7g7r-gx96-252g)). Both dependency paths run
through the `electron-builder` devDependency; this project's `files` list and bundled-output model do
not copy that tool chain into the installed application. This is a narrow, visible exception, not a
blanket audit waiver: compare future output, treat any new production/runtime path as a blocker, and
rerun the full packaging checks when upgrading `electron-builder`. `pnpm audit --prod` currently
reports no known vulnerabilities -- and, as of issue #61, is a required CI gate on every push and PR
(`.github/workflows/ci.yml`), so a new production-reachable advisory fails the build rather than
depending on someone remembering to check.

**Exception ownership and re-review (issue #61):** this exception is not open-ended. Re-verify it
(rerun `pnpm audit`, confirm the same two advisories on the same dev-tool-only paths, and that
`pnpm audit --prod` is still clean) at every `electron-builder` upgrade and at least once per
quarter regardless, whichever comes first; treat a stale re-review (no check recorded in the last
90 days) as a release blocker for the next release candidate. Whoever dispatches
`release-candidate.yml` for a given release is this exception's reviewer of record for that
release -- the workflow's own generated manifest already records `documentedExceptions` verbatim,
so a stale or newly-inapplicable exception string shows up in that release's own evidence bundle,
not just in this doc.

## Start Menu and single-instance behavior

The NSIS config (`nsis:` in `electron-builder.yml`) creates a Start Menu shortcut
(`createStartMenuShortcut: true`) but no desktop shortcut by default, and allows the user to change
the install directory (`allowToChangeInstallationDirectory: true`). The installed app takes
`app.requestSingleInstanceLock()`: launching it a second time (Start Menu, desktop, or otherwise)
focuses the existing window rather than opening a second one, which would otherwise spawn a second
daemon and lose the race described in
[daemon.md#duplicate-start-behavior](daemon.md#duplicate-start-behavior). This was verified live
against a real installed build: launching the packaged `.exe` a second time while the first was
running left the process count and the daemon's port unchanged.

## Unsigned installer and SmartScreen

The NSIS installer and the packaged `AgentDock.exe` are unsigned: electron-builder's log shows
signing steps being skipped for lack of a certificate. **Expect Windows SmartScreen to warn on
first run** ("Windows protected your PC" / unknown publisher), that's expected behavior for an
unsigned OSS boilerplate build, not a packaging bug. Code signing was explicitly out of scope for
this milestone; see [troubleshooting.md](troubleshooting.md) if you need to click through it for
local testing.

## Platform matrix

|             | source / dev | production build | packaged app                                                                | installer                                 | uninstall |
| ----------- | ------------ | ---------------- | --------------------------------------------------------------------------- | ----------------------------------------- | --------- |
| **Windows** | verified     | verified         | verified (installed, launched, closed, relaunched, second-instance-blocked) | verified (NSIS, silent install/uninstall) | verified  |
| **macOS**   | untested     | untested         | untested                                                                    | not implemented                           | n/a       |
| **Linux**   | untested     | CI-verified      | untested                                                                    | not implemented                           | n/a       |

The core runtime uses `node:path` and has explicit POSIX process-group branches (see
[SECURITY.md](../SECURITY.md#process-hygiene)), and Linux CI verifies the production build. The
shipped packaging/native assets are deliberately Windows x64-specific today: NSIS, the Job Object
host, and the pinned Claude SDK executable. Only Windows has been installed and exercised end to
end. Adding `mac`/`linux` targets and native assets (`dmg`/`zip`, `AppImage`/`deb`) was not attempted;
macOS/Linux packaging, signing, and notarization remain out of scope.

### Supported Windows versions (issue #61)

The packaged installer and app are only built, tested, and supported on **Windows 10 21H2 or
later, and Windows 11, x64 only**. This is the actual scope of what's verified above, not an
aspiration:

- **x64 only.** There is no `arm64` electron-builder target configured, and the pinned Claude
  Agent SDK executable and Job Object host are both x64 binaries. Running the x64 installer under
  Windows on Arm's x64 emulation is unverified, not something this project tests against.
- **Windows 10 21H2+ or Windows 11.** Earlier Windows 10 feature updates are not tested and may be
  missing OS APIs electron-builder's NSIS output or Electron itself now expect. There's no code
  path that specifically detects or blocks an older build; it's simply outside what's verified.
- A release described anywhere as "supported" or "verified" means this exact matrix -- see
  [SECURITY.md's Supported versions](../SECURITY.md#supported-versions) for how this maps to
  vulnerability-reporting scope.

## Verifying a packaging-sensitive change

If you touched anything under `apps/desktop/electron/` (main process, preload, or
`electron-builder.yml`) or changed native assets, `pnpm build` and `pnpm typecheck` alone won't
catch every packaging-mode failure mode: the three real bugs documented above
(`resolveDaemonEntry`'s asar boundary, the
`devDependencies`-vs-`dependencies` duplication, and the shutdown-path crash in
[architecture.md](architecture.md)) were each only caught by actually running `pnpm package:win` and
launching the result. Run it, then run `pnpm --filter @agent-dock/desktop
test:packaged-daemon-win`; that smoke test executes the packaged SDK binary, checks its exact pinned
version and notices, starts the packaged daemon, verifies PATH-based Codex detection/app-server
launch, and exercises the packaged Job Object host. Also inspect the installer, Start Menu, and
window icons before considering the change done.
