// Produces a single self-contained dist/index.js: `tsc` alone can't, because
// packages/shared and packages/agent-runtime intentionally publish TypeScript source (their
// package.json "main" points at src/index.ts, not a built dist/) so dev tools that already
// understand TS — tsx, Vite, Vitest — get live source with no separate build step. A plain
// `node dist/index.js` run of the compiled daemon can't resolve those the same way (Node's ESM
// loader has no TypeScript support), so this bundles the daemon and every workspace/npm
// dependency it imports into one plain-JS file that plain Node can run standalone — which is
// exactly what Electron's packaged-mode sidecar (electron/main.ts) needs.
import { build } from 'esbuild';
import { buildWindowsJobHost } from './build-windows-job-host.mjs';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'bundle',
  banner: {
    // Some bundled CJS dependencies call require() at runtime; under an ESM output there is no
    // ambient `require`, so this is the standard esbuild shim for node+esm bundles.
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});

await buildWindowsJobHost();
