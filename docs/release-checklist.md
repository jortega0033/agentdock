# Release checklist

This is the minimum bar before a release (or `main`) is described anywhere as having verified
provider support at a specific version. It exists because issue #65 found that deterministic tests
run entirely against fixtures/fakes: they prove the wire protocol and this repo's own logic are
correct, but they cannot prove a specific installed provider CLI, at a specific version, still
completes a real session the way the fixtures assume it does.

## Before claiming a version is verified

1. Confirm `packages/agent-runtime/src/providers/compatibility-manifest.ts` (and, for the Claude
   Agent SDK, `providers/claude/sdk-version.ts`) names the exact provider version you're about to
   claim support for. If you bumped a pin, this step is what makes the bump real rather than
   aspirational.
2. Run the live provider smoke matrix against that exact version, with real, authenticated
   installs of both CLIs:
   ```bash
   AGENT_DOCK_LIVE_PROVIDER_SMOKE=1 pnpm --filter @agent-dock/daemon run smoke:live-providers
   ```
   This never runs by default -- see [providers.md](providers.md) and
   `.github/workflows/live-provider-smoke.yml`. It costs real provider usage; do not run it on
   every commit.
3. Read `apps/daemon/live-provider-smoke-evidence.jsonl`. Every row you're relying on must have
   `resultCode: "success"`. A `skipped_*` row means that transport wasn't actually exercised (no
   binary, no auth, or a version mismatch) -- it is not evidence of anything, and must not be read
   as one. A `failed_*` row is a real regression: do not release until it's understood.
4. Cross-check the evidence rows against [capability-matrix.md](capability-matrix.md) (once it
   exists on this branch -- see #63) or the equivalent capability claims in `providers.md`: a
   public "verified" claim must map to a specific evidence row, not the other way around. Don't let
   an old evidence file justify a new claim after the code changed underneath it.
5. If you're publishing a release that changes what a public doc says a transport can do, update
   that doc in the same change -- see [CONTRIBUTING.md](../CONTRIBUTING.md#before-opening-a-pr).

## What "verified" does not mean

A `success` row proves one thing: this repo's daemon, talking to that exact provider CLI version,
completed one real session with real content and no protocol violation, on the OS the smoke run
used. It is not a claim about every prompt, every auth source, every OS, or every edge case a real
user might hit -- see the smoke matrix's own recorded `authSourceCategory` and `os` fields before
generalizing beyond what a row actually covers.
