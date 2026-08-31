# Provider fixture safety

Provider fixtures are checked-in compatibility evidence, so they must be deterministic and safe to
publish. A fixture must never contain a real prompt, workspace path, process environment,
credential, reasoning payload, tool input/result, or other free-form provider text.

## Compatibility contract

Fixtures live under `packages/agent-runtime/test/conformance/fixtures/<fixture-set>/` and conform to
`provider-fixture.schema.json`. The runtime compatibility manifest pins each supported
provider/version/transport tuple to one exact schema set and fixture set. Updating a provider
version therefore requires updated fixtures and manifest metadata in the same change; CI rejects
either side on its own.

Legacy fixtures also record sanitized `argv` and `stdin` under `nativeInput`. Contract tests compare
that outbound oracle with the real adapter argument builder and prompt-transport setting; prompt
positions use typed placeholders and never retain prompt text.

Run the credential-free gate on Windows or Linux with:

```console
pnpm test:provider-conformance
```

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
