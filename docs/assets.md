# Asset system

AgentDock ships a complete default identity for the desktop app, installer, documentation, and
repository sharing cards. The canonical name is **AgentDock**; package and repository identifiers
remain `agent-dock`.

## Identity

The AgentDock badge combines three ideas:

- the central chevron is both an agent launch path and an abstract letter A;
- the lower plate is the dock where provider sessions connect;
- the graphite hexagonal badge represents the protected local runtime boundary.

The mark uses a monochrome graphite-to-silver palette so it stays provider-neutral and remains
legible beside any provider. Light- and dark-background variants share the same geometry and adjust
rim contrast; fixed lockups pair the badge with the AgentDock wordmark. Product surfaces may still
use cobalt and mint as interface accents. No provider logo is part of the AgentDock identity.

## Source-of-truth files

```text
apps/desktop/assets/
  brand/
    agent-dock-app-icon.svg
    agent-dock-mark.svg
    agent-dock-mark-light.svg
    agent-dock-mark-dark.svg
    agent-dock-lockup-horizontal-light.svg
    agent-dock-lockup-horizontal-dark.svg
    agent-dock-lockup-stacked-light.svg
    agent-dock-lockup-stacked-dark.svg
  illustrations/
    empty-prompt.svg
    empty-events.svg
    empty-session.svg
    no-providers.svg
    empty-working-directory.svg
    provider-unavailable.svg
    runtime-unavailable.svg
```

`agent-dock-app-icon.svg` is the canonical native icon source. It uses same-document gradients,
clipping, and explicit vector shadow shapes that render consistently in browsers and CairoSVG; it
does not depend on unsupported SVG filters. The lockups and illustrations are hand-authored SVGs
committed as source, not exported from an opaque design file.

## Generated app icons

`scripts/assets/generate_assets.py` rasterizes the canonical SVG into:

- PNG icons at 16, 24, 32, 44, 48, 64, 128, 256, 512, and 1024 pixels;
- `agent-dock.ico`, with Windows frames from 16 through 256 pixels;
- `agent-dock.icns`, retained for a future macOS packaging target.

Electron Builder uses the ICO for the executable and NSIS installer. The packaged app also ships
`icon-256.png`, which Electron uses for the runtime window icon where supported.

## Documentation and social images

```text
docs/images/
  architecture/runtime-flow.svg
  artwork/agent-dock-runtime.png
  screenshots/
    desktop-ready.png
    desktop-dark.png
    session-running.png
    session-completed.png
    daemon-unavailable.png
  social/
    readme-hero.webp              1440 × 900
    github-social-preview.png     1280 × 640
    open-graph.png                1200 × 630
    portfolio-project.png         1440 × 900
    asset-system-preview.png      1600 × 1040
    icon-size-preview.png         1180 × 430
```

The screenshots come from the real renderer through a development-only capture bridge. It accepts
`?asset-capture=1`, an optional `mode=ready|running|completed|unavailable`, and optional
`theme=dark`. `apps/desktop/vite.capture.config.ts` starts only the renderer, so no live daemon or
provider account is required for stable fixture states.

The abstract runtime artwork was generated specifically for AgentDock with OpenAI's built-in image
generator. Prompt brief: _a premium, text-free 3D concept of three terminal modules docking into a
protected local AI runtime; deep graphite/navy grid, aqua/violet/amber signals, visual weight on the
right and negative space on the left; no people, robots, provider logos, cloud motif, or watermark._
The committed PNG is the reviewed source used by the scripted social-image compositor.

## Regenerate and validate

Use Python 3.11 or newer in an isolated environment:

```bash
python -m venv .venv-assets
.venv-assets/Scripts/python -m pip install -r scripts/assets/requirements.txt
.venv-assets/Scripts/python scripts/assets/generate_assets.py
.venv-assets/Scripts/python scripts/assets/generate_public_assets.py
.venv-assets/Scripts/python scripts/assets/validate_assets.py
```

On POSIX systems, use `.venv-assets/bin/python` instead. The generators perform no network access.
Validation checks exact inventories, dimensions, color modes, ICO/ICNS representations, unsafe SVG
features, embedded metadata, and accidental local paths or secret-like strings in source and
metadata bytes. CI also rerenders every native icon representation and compares its decoded RGBA
pixels exactly with the committed files. PNG compression streams can differ between platform zlib
builds even when every decoded pixel is identical, so container-byte equality is not used as a
cross-platform visual check. Visible raster text still requires human review.

The root aliases `pnpm assets:generate` and `pnpm assets:validate` use the active `python`
interpreter; activate the environment first if preferred.

The compositor uses Segoe UI on Windows and DejaVu Sans as its POSIX fallback; lockup SVGs use a
system UI font stack. Text rasterization can vary slightly between operating systems. Regenerate
release assets on the verified Windows toolchain when byte-identical outputs matter.

## Capture a new renderer state

```bash
pnpm --filter @agent-dock/desktop exec vite --config vite.capture.config.ts
```

Open a capture URL such as:

```text
http://127.0.0.1:4173/?asset-capture=1&mode=completed
```

Use a 1248 × 900 viewport and capture the visible page from the top. Confirm the complete brand
header, runtime-status badge, and session timeline are visible, replace the matching file in
`docs/images/screenshots/`, then run the public asset generator and validator. The generator pads
captures no larger than 1440 × 900 to RGB at the exact target size; it cannot recover content
clipped during capture.

## Rebrand a fork

1. Replace the eight SVG source files while preserving their filenames and view boxes.
2. Replace the seven state illustrations if their visual language changes.
3. Regenerate icons and public assets.
4. Change `appId`, `productName`, executable, and shortcut names in
   `apps/desktop/electron-builder.yml`.
5. Update the renderer name and metadata, then run `pnpm build`, `pnpm test`, and the target package
   command.
6. Upload `docs/images/social/github-social-preview.png` in the repository's social-preview
   settings; committing the file does not configure the hosting platform automatically.
