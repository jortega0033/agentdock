# Release checklist

This is the minimum bar before a Windows build is described anywhere as a release candidate, or
before a public "verified" claim is made about a specific provider version. Two workflows produce
the evidence this checklist asks for; neither runs automatically, and neither publishes anything.

## Generating the evidence

1. **Live provider smoke matrix** (issue #65, `.github/workflows/live-provider-smoke.yml` /
   `pnpm --filter @agent-dock/daemon run smoke:live-providers` with
   `AGENT_DOCK_LIVE_PROVIDER_SMOKE=1`): proves a specific, installed, authenticated provider CLI
   still completes a real session at its exact pinned version. Costs real provider usage; run it
   deliberately, not on every commit. Writes a redacted evidence JSONL.
2. **Release-candidate evidence bundle** (issue #66, `.github/workflows/release-candidate.yml`,
   `workflow_dispatch` only): runs the full quality gate (frozen install, assets, lint, typecheck,
   the full Windows test suite, build, production dependency audit, provider conformance),
   packages the Windows NSIS installer, proves the *real packaged `AgentDock.exe`* starts its
   bundled daemon and shuts down cleanly, silently installs and uninstalls that installer in an
   isolated directory, and aggregates all of it -- plus, optionally, the live-provider matrix's
   evidence -- into one `release-candidate-manifest.json` (schema:
   `scripts/release-candidate/manifest.schema.json`). To include the live-provider matrix's rows,
   download that workflow's evidence artifact and pass its path as this workflow's
   `provider_matrix_evidence_path` input; left empty, the manifest records the matrix as
   unavailable rather than implying anything was verified.

## Reading the manifest

- **`ready`** is `true` only when every entry in `gates` passed -- a strict AND, computed by
  `aggregateGateResults()` in `scripts/release-candidate/manifest.mjs`, never set directly by
  anything upstream. A single failed gate, however minor, makes the whole candidate not ready.
  Never treat a candidate as release-worthy without checking this field yourself; don't infer it
  from "the workflow ran" or "most steps were green."
- **`signingStatus`** is always literally `"unsigned"` -- there is no certificate to sign with in
  this repository (see [packaging.md](packaging.md#unsigned-installer-and-smartscreen)). This is
  informational, not a gate: an unsigned build can still be `ready`, but must never be described as
  signed.
- **`published`** is always `false`. This workflow has no publish step and no write-scoped
  permission to add one accidentally; nothing about this evidence bundle ever ships anywhere on
  its own.
- **`providerMatrix.available`**: `false` means the live-provider matrix simply wasn't run or
  imported for this candidate -- not that every provider failed. Don't read an unavailable matrix
  as a claim about provider support one way or the other.
- **`providerMatrix.rows[].verified`**: `true` only when that row's `resultCode` is exactly
  `"success"`. A skipped or failed row is never verified, even though it's still listed --
  issue #65's live-provider-smoke matrix (once merged, see `docs/providers.md`) and
  `docs/capability-matrix.md` (once #63 merges) are what a public claim about a specific transport
  should actually point at.

## Before calling a build a release candidate

1. Dispatch `release-candidate.yml` against the exact commit you intend to ship.
2. Read the uploaded manifest. If `ready` is `false`, stop -- do not distribute the installer
   artifact from that run, and do not describe it as a candidate anywhere.
3. If you're also claiming a specific provider version works, cross-check
   `providerMatrix.rows` for that exact provider/version/transport with `resultCode: "success"`.
   A stale or missing row means that claim isn't backed by this evidence; go run the live-provider
   matrix for it first (issue #65).
4. Evidence artifacts (the manifest and the installer) are retained for 90 days -- long enough for
   a maintainer to review after the fact, not a substitute for reviewing at dispatch time.

## What a `ready` manifest does not mean

It does not mean the build is signed, published, or endorsed for distribution -- those all remain
explicit, separate, human decisions this workflow deliberately never makes. It does not mean every
provider transport was verified; check `providerMatrix` for that specifically. And it proves the
*packaged Windows build* works -- see [packaging.md's platform matrix](packaging.md#platform-matrix)
for what remains unverified on macOS/Linux.
