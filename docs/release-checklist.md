# Release checklist

This is the minimum bar before a Windows build is described anywhere as a release candidate, or
before a public "verified" claim is made about a specific provider version. Three workflows are
involved: two only ever produce evidence and never run automatically or publish anything
(`live-provider-smoke.yml`, `release-candidate.yml`); the third, `release-publish.yml` (issue
#61), is the one place that actually creates a GitHub Release, and it too only runs on explicit
`workflow_dispatch` -- never on push, PR, or a schedule.

## Generating the evidence

1. **Live provider smoke matrix** (issue #65, `.github/workflows/live-provider-smoke.yml`):
   proves a specific, installed, authenticated provider CLI still completes a real session at its
   exact pinned version (confirm `packages/agent-runtime/src/providers/compatibility-manifest.ts`,
   and for the Claude Agent SDK `providers/claude/sdk-version.ts`, name the exact version you're
   claiming support for first). Costs real provider usage; run it deliberately, not on every
   commit:
   ```bash
   AGENT_DOCK_LIVE_PROVIDER_SMOKE=1 pnpm --filter @agent-dock/daemon run smoke:live-providers
   ```
   Writes a redacted evidence JSONL to `apps/daemon/live-provider-smoke-evidence.jsonl`. Every row
   you rely on must have `resultCode: "success"` -- a `skipped_*` row means that transport wasn't
   actually exercised (no binary, no auth, or a version mismatch), and is not evidence of anything.
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
  `"success"`. A skipped or failed row is never verified, even though it's still listed -- issue
  #65's live-provider-smoke matrix (see [providers.md](providers.md#live-provider-smoke-matrix))
  and [capability-matrix.md](capability-matrix.md) are what a public claim about a specific
  transport should actually point at.
- **`sbom.available`** (issue #61): `false` means no software bill of materials was generated for
  this run -- treat that candidate as missing required release evidence, not as "no dependencies."
  When `true`, `sbom.sha256` is the real hash of the CycloneDX file this run actually produced
  (`anchore/sbom-action`, a genuine `syft` scan of the pnpm workspace's committed lockfile), not a
  claim from the workflow's own say-so.
- **`provenance.available`** (issue #61): `false` means no build-provenance attestation exists for
  this run's installer. When `true`, `provenance.attestationUrl` points at a real SLSA-style
  attestation (`actions/attest-build-provenance`) you can independently verify with
  `gh attestation verify <installer-path> --owner jortega0033`.

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

## Publishing a release

`release-publish.yml` (issue #61) is the one workflow that actually creates a GitHub Release. It
is `workflow_dispatch`-only and gated by the `release` GitHub Environment (see
[Recommended environment protection for `release`](#recommended-environment-protection-for-release)
below) -- it never runs on push, on a pull request, or on a schedule, and a fork can never reach a
run of it.

To publish:

1. Dispatch `release-candidate.yml` (see above) and let it finish. Note its run ID from the run's
   URL (`.../actions/runs/<run id>`).
2. Read that run's manifest yourself first, per [Before calling a build a release
   candidate](#before-calling-a-build-a-release-candidate). Don't rely on `release-publish.yml` to
   be the first thing that checks `ready` -- it re-checks, but you should already know the answer.
3. Dispatch `release-publish.yml` with three inputs:
   - `release_candidate_run_id`: the run ID from step 1. This is what ties a publish to one
     specific, already-reviewed evidence bundle -- never "whatever ran most recently."
   - `tag`: the git tag for this release (e.g. `v0.2.0`). Must not already exist.
   - `draft`: `true` (default) creates the release as a draft for a human to review and publish by
     hand; `false` publishes it immediately. Prefer `true` unless you have a specific reason not
     to.
4. The workflow re-verifies the downloaded manifest's `ready` and `dirty` fields itself, and
   re-hashes the downloaded installer against the manifest's recorded checksum, before creating
   anything -- a stale or tampered evidence bundle fails the run rather than getting published.
5. The created release always says "Unsigned Windows build" in its notes and attaches the
   installer, the manifest, and a `SHA256SUMS.txt`. It also attaches the SBOM -- but only if the
   candidate's evidence bundle actually has one: `sbom.cdx.json` generation is best-effort
   (`continue-on-error`) in `release-candidate.yml`, so a candidate can still be `ready` with
   `sbom.available: false`. `release-publish.yml` checks for the file itself rather than assuming
   it exists, and posts a workflow warning (not a failure) when it's missing. It is never signed --
   see [signingStatus](#reading-the-manifest) above and
   [packaging.md](packaging.md#unsigned-installer-and-smartscreen).

## Recommended environment protection for `release`

`release-publish.yml` targets a GitHub Environment named `release`
(Settings -> Environments in this repository). This workflow does not, and cannot, configure that
environment's protection rules itself -- they're a one-time, manual setup step for this repo's
admin:

- **Required reviewers**: at least one maintainer other than whoever dispatched the run must
  approve before the job starts. This is the actual human gate behind "the workflow only creates a
  draft" -- without it, dispatch alone is enough to create a release.
- **Deployment branches**: restrict to `main` (or a `release/*` pattern if this repo later adopts
  release branches), so a publish can't be dispatched against an arbitrary branch or an old, already
  superseded commit.
- Leave environment secrets empty. This workflow only needs `github.token` (already scoped by the
  job's own `permissions:` block) and does not read any environment-specific secret.

Until these are configured, `release-publish.yml` still requires write access to dispatch and still
re-verifies the manifest before publishing -- but the extra human-approval gate the environment is
meant to add is not yet in effect. Configure it before the first real publish.

## Rollback

A `release-publish.yml` run with `draft: true` (the default) hasn't published anything public yet
-- delete the draft release from the repository's Releases page, or with
`gh release delete <tag> --yes`, and nothing further is needed.

If a run was dispatched with `draft: false`, or a draft was already published by hand, and it needs
to be undone:

1. `gh release delete <tag> --yes` removes the release and its attached assets. This does not
   delete the git tag by default; add `--cleanup-tag` if the tag itself was also wrong (e.g. points
   at the wrong commit) and nothing else depends on it existing.
2. If the tag is otherwise fine and only the release metadata was wrong, prefer editing the
   existing release (`gh release edit <tag> ...`) or re-running `gh release delete` followed by a
   fresh `release-publish.yml` dispatch against the same tag, over force-pushing or re-tagging.
3. Tell anyone who may have already seen the release (announcements, linked issues/PRs) that it was
   pulled and why -- a deleted release can still have been downloaded before removal, so treat this
   as "stop distributing it further," not "it never happened."

## What a `ready` manifest does not mean

It does not mean the build is signed, published, or endorsed for distribution -- those all remain
explicit, separate, human decisions this workflow deliberately never makes. It does not mean every
provider transport was verified; check `providerMatrix` for that specifically. And it proves the
*packaged Windows build* works -- see [packaging.md's platform matrix](packaging.md#platform-matrix)
for what remains unverified on macOS/Linux.

A `providerMatrix` row's `verified: true` proves one thing: this repo's daemon, talking to that
exact provider CLI version, completed one real session with real content and no protocol
violation, on the OS that smoke run used. It is not a claim about every prompt, every auth source,
every OS, or every edge case a real user might hit -- see that row's own `authSourceCategory` and
the live-provider-smoke evidence's `os` field before generalizing beyond what it actually covers.
If you're publishing a release that changes what a public doc says a transport can do, update that
doc in the same change -- see [CONTRIBUTING.md](../CONTRIBUTING.md#before-opening-a-pr).
