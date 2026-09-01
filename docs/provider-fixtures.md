# Provider fixture safety

Provider fixtures are checked-in compatibility evidence, so they must be deterministic and safe to
publish. A fixture must never contain a real prompt, workspace path, process environment,
credential, reasoning payload, tool input/result, or other free-form provider text.

## Compatibility contract

Replay fixtures live under `packages/agent-runtime/test/conformance/fixtures/<fixture-set>/` and
conform to `provider-fixture.schema.json`. The replay compatibility manifest pins each covered
provider/version/transport tuple to one exact schema and fixture set, so changing either side alone
fails the replay conformance tests.

Native rich transports use transport-specific evidence instead of that replay-fixture format.
Codex app-server pins a CLI version, generated schema artifact/hash, exact method allowlist, and a
live fake JSON-RPC harness. Claude Agent SDK pins the SDK and embedded executable versions and uses
SDK transport tests plus fixture-set metadata. Those records must not be inferred from legacy JSONL
fixtures.

Legacy fixtures also record sanitized `argv` and `stdin` under `nativeInput`. Contract tests compare
that outbound oracle with the real adapter argument builder and prompt-transport setting; prompt
positions use typed placeholders and never retain prompt text.

Run the credential-free gate on Windows or Linux with:

```console
pnpm test:provider-conformance
```

That focused command covers replay/fake/legacy contract and fixture-safety suites. Run
`pnpm --filter @agent-dock/agent-runtime test` for the complete runtime suite, including the native
Claude SDK and Codex app-server transport tests.

Secret-backed live-provider smoke tests may run separately on a protected schedule, but they are
never required for pull requests and are not compatibility evidence.

## Safe recording workflow

1. Use a synthetic account, synthetic prompt, and disposable workspace containing no private data.
2. Keep raw frames in memory or a pipe. Do not redirect provider output to a file or commit an
   unsanitized capture.
3. Wrap the frames in the fixture's JSON structure, then pipe that JSON directly into the sanitizer:

   ```console
   <fixture-json-producer> | node scripts/provider-fixtures/sanitize-fixture.mjs - path/to/fixture.json
   ```

   The sanitizer does not start Claude, Codex, or any other provider. It reads one JSON value,
   replaces sensitive fields with typed placeholders, scans the result, and atomically replaces the
   destination only after the scan passes.

4. Inspect the resulting diff. Confirm that every retained string is structural metadata such as a
   provider, transport, version, scenario, event type, status, or synthetic identifier.
5. Run the agent-runtime tests before committing.

The sanitizer emits placeholders such as `{ "$fixturePlaceholder": "prompt" }`,
`credential`, `environment`, `reasoning`, `tool_input`, `tool_result`, and `free_text`. It never
retains a fragment, hash, or length derived from the removed value.

The scanner recognizes only the fixed, category-matched `<redacted:category>` tags already used by
synthetic conformance fixtures; arbitrary tags and tags on the wrong field fail closed. New
sanitizer output uses the object form above. Numeric provider usage counters such as `input_tokens`
and `outputTokens` are structural accounting data; a nonnumeric value in those fields remains
credential-sensitive.

## Scanner boundary

`scanFixtureForSecrets()` rejects unredacted sensitive keys and common API-key, bearer/basic-auth,
JWT, private-key, credential-assignment, URL-credential, and user-home-path patterns. Findings report
only a code and JSON path; they never echo the suspect value.

Pattern scanning cannot identify every secret embedded in arbitrary user text. Structural removal
and synthetic recording inputs are therefore mandatory; the scanner is a final fail-closed gate,
not permission to record real work.
