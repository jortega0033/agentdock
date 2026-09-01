export const PROVIDER_FIXTURE_SCHEMA_SET = 'agent-dock-provider-fixture-v1' as const;

export const LEGACY_ONE_SHOT_TRANSPORT_ID = 'legacy-one-shot' as const;
export const FAKE_INTERACTIVE_TRANSPORT_ID = 'fake-interactive' as const;
export const CODEX_APP_SERVER_TRANSPORT_ID = 'codex-app-server' as const;

/** SHA-256 of the non-experimental `codex app-server generate-json-schema` bundle. */
export const CODEX_APP_SERVER_SCHEMA_SHA256 =
  'F72B2CAA3CBFA4298DE9E85C62DDA6DFBAF2266FFEB916FED30615CA69FF8C74' as const;
export const CODEX_APP_SERVER_SCHEMA_ARTIFACT =
  'providers/codex/app-server-schema/0.147.0/codex_app_server_protocol.schemas.json' as const;
export const CODEX_APP_SERVER_FIXTURE_SET = 'codex-app-server-0.147.0-v1' as const;

export type ProviderImplementation = 'claude' | 'codex' | 'fake';

export type AcceptedWorkBoundary =
  'first-prompt-byte-to-stdin' | 'process-spawn-attempt' | 'transport-acceptance';

export interface ProviderCompatibilityManifestEntry {
  readonly provider: ProviderImplementation;
  readonly providerVersion: string;
  readonly transport: string;
  readonly schemaSet: typeof PROVIDER_FIXTURE_SCHEMA_SET;
  readonly fixtureSet: string;
  readonly acceptedWorkBoundary: AcceptedWorkBoundary;
}

/** Kept separate because app-server uses a live JSON-RPC fixture rather than replay JSON files. */
export interface CodexAppServerCompatibilityManifestEntry {
  readonly provider: 'codex';
  readonly providerVersion: string;
  readonly transport: typeof CODEX_APP_SERVER_TRANSPORT_ID;
  readonly schemaSha256: typeof CODEX_APP_SERVER_SCHEMA_SHA256;
  readonly schemaArtifact: typeof CODEX_APP_SERVER_SCHEMA_ARTIFACT;
  readonly fixtureSet: typeof CODEX_APP_SERVER_FIXTURE_SET;
  readonly acceptedWorkBoundary: 'turn-start-write-attempt';
}

export const CLAUDE_LEGACY_COMPATIBILITY = Object.freeze({
  provider: 'claude',
  providerVersion: '2.1.228',
  transport: LEGACY_ONE_SHOT_TRANSPORT_ID,
  schemaSet: PROVIDER_FIXTURE_SCHEMA_SET,
  fixtureSet: 'claude-legacy-2.1.228-v1',
  acceptedWorkBoundary: 'first-prompt-byte-to-stdin',
} as const satisfies ProviderCompatibilityManifestEntry);

export const CODEX_LEGACY_COMPATIBILITY = Object.freeze({
  provider: 'codex',
  providerVersion: '0.147.0',
  transport: LEGACY_ONE_SHOT_TRANSPORT_ID,
  schemaSet: PROVIDER_FIXTURE_SCHEMA_SET,
  fixtureSet: 'codex-legacy-0.147.0-v1',
  acceptedWorkBoundary: 'process-spawn-attempt',
} as const satisfies ProviderCompatibilityManifestEntry);

export const CODEX_APP_SERVER_COMPATIBILITY = Object.freeze({
  provider: 'codex',
  providerVersion: '0.147.0',
  transport: CODEX_APP_SERVER_TRANSPORT_ID,
  schemaSha256: CODEX_APP_SERVER_SCHEMA_SHA256,
  schemaArtifact: CODEX_APP_SERVER_SCHEMA_ARTIFACT,
  fixtureSet: CODEX_APP_SERVER_FIXTURE_SET,
  acceptedWorkBoundary: 'turn-start-write-attempt',
} as const satisfies CodexAppServerCompatibilityManifestEntry);

export const FAKE_INTERACTIVE_COMPATIBILITY = Object.freeze({
  provider: 'fake',
  providerVersion: 'fake-interactive-v1',
  transport: FAKE_INTERACTIVE_TRANSPORT_ID,
  schemaSet: PROVIDER_FIXTURE_SCHEMA_SET,
  fixtureSet: 'fake-interactive-v1',
  acceptedWorkBoundary: 'transport-acceptance',
} as const satisfies ProviderCompatibilityManifestEntry);

export const PROVIDER_COMPATIBILITY_MANIFEST = Object.freeze([
  CLAUDE_LEGACY_COMPATIBILITY,
  CODEX_LEGACY_COMPATIBILITY,
  FAKE_INTERACTIVE_COMPATIBILITY,
] as const satisfies readonly ProviderCompatibilityManifestEntry[]);

export function findProviderCompatibility(
  provider: ProviderImplementation,
  providerVersion: string | undefined,
  transport: string,
): ProviderCompatibilityManifestEntry | undefined {
  if (!providerVersion) return undefined;
  return PROVIDER_COMPATIBILITY_MANIFEST.find(
    (entry) =>
      entry.provider === provider &&
      entry.providerVersion === providerVersion &&
      entry.transport === transport,
  );
}
