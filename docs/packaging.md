# Packaging

`apps/desktop/electron-builder.yml` configures [electron-builder](https://www.electron.build/) to
produce a distributable desktop app. Today that means a Windows NSIS installer, see
[Platform matrix](#platform-matrix) below for what's actually been verified versus what's merely
not-yet-attempted.

## Commands

```bash
pnpm build         # compiles every package, the prerequisite for packaging, not packaging itself
pnpm package:win   # pnpm build, then electron-builder --win nsis
pnpm package       # pnpm build, then electron-builder for whatever platform you're on
```

Both `package` commands are non-interactive and safe to run from a clean checkout after `pnpm
install`, with no code signing configured: there's nothing to sign with in this repository (see
[Unsigned installer](#unsigned-installer-and-smartscreen) below).

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
- `apps/daemon/dist/claude-agent-sdk/`: the pinned Windows x64 SDK executable plus its SDK/native
  notices. The build executes `claude.exe --version` and rejects a package/version mismatch before
  staging it.
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

`react`, `react-dom`, `zod`, and `@agent-dock/shared`/`@agent-dock/client` are all fully inlined
into `dist/` and `dist-electron/main.js` at build time (Vite for the renderer, esbuild via
vite-plugin-electron for main), none of them are read from `node_modules` once built. They live in
`package.json`'s `devDependencies`, not `dependencies`, specifically so electron-builder's automatic
production-dependency resolution (which inspects `dependencies` and copies the matching
`node_modules` trees into the package independently of the `files` config) doesn't embed a second,
unused, unbundled copy of each. This was caught by unpacking a real built `app.asar` and finding
`node_modules/@agent-dock/shared` inside it despite an explicit `files` list that excluded
`node_modules` entirely.

## Start Menu and single-instance behavior

The NSIS config (`nsis:` in `electron-builder.yml`) creates a Start Menu shortcut
(`createStartMenuShortcut: true`) but no desktop shortcut by default, and allows the user to change
the install directory (`allowToChangeInstallationDirectory: true`). The installed app takes
`app.requestSingleInstanceLock()`: launching it a second time (Start Menu, desktop, or otherwise)
focuses the existing window rather than opening a second one, which would otherwise spawn a second
daemon and lose the race described in
[daemon.md#single-instance-behavior](daemon.md#single-instance-behavior). This was verified live
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
| **Linux**   | untested     | untested         | untested                                                                    | not implemented                           | n/a       |

Nothing in the code is deliberately Windows-only: path handling uses `node:path` throughout, and
process management already has explicit POSIX branches (see
[SECURITY.md](../SECURITY.md#process-hygiene)), but "should work" and "verified" are different
claims; only Windows has actually been installed and exercised end to end. Adding `mac`/`linux`
targets (`dmg`/`zip`, `AppImage`/`deb`) to `electron-builder.yml` is a reasonable next step but
wasn't attempted here: macOS/Linux packaging are explicitly out of scope for this milestone, same
as signing/notarization.

## Verifying a packaging-sensitive change

If you touched anything under `apps/desktop/electron/` (main process, preload, or
`electron-builder.yml`) or changed native assets, `pnpm build` and `pnpm typecheck` alone won't
catch every packaging-mode failure mode: the three real bugs documented above
(`resolveDaemonEntry`'s asar boundary, the
`devDependencies`-vs-`dependencies` duplication, and the shutdown-path crash in
[architecture.md](architecture.md)) were each only caught by actually running `pnpm package:win` and
launching the result. Run it, then run `pnpm --filter @agent-dock/desktop
test:packaged-daemon-win`; that smoke test executes the packaged SDK binary, checks its exact pinned
version and notices, and proves the daemon still starts. Also inspect the installer, Start Menu,
and window icons before considering the change done.
