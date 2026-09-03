import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CODEX_APP_SERVER_COMPATIBILITY,
  CODEX_APP_SERVER_FIXTURE_SET,
  CODEX_APP_SERVER_INCOMING_NOTIFICATION_METHODS,
  CODEX_APP_SERVER_INCOMING_REQUEST_METHODS,
  CODEX_APP_SERVER_OUTGOING_NOTIFICATION_METHODS,
  CODEX_APP_SERVER_OUTGOING_REQUEST_METHODS,
  CODEX_APP_SERVER_SCHEMA_SHA256,
  CODEX_APP_SERVER_TRANSPORT,
  CODEX_APP_SERVER_TRANSPORT_ID,
  CodexAppServerUnsupportedError,
  isCodexAppServerIncomingMethod,
  isCodexAppServerOutgoingMethod,
  resolveCodexTransportMode,
  resolveCodexV2Support,
} from '../src/providers/codex/app-server-support.js';
import type { ProviderStatus } from '@agent-dock/shared';

const status = (version: string | undefined): ProviderStatus => ({
  id: 'codex',
  name: 'Codex',
  installed: true,
  authenticated: 'authenticated',
  version,
  capabilities: { resume: true, cancellation: true, tools: true, usage: true, thinking: true },
});

describe('Codex app-server compatibility selection', () => {
  it('pins the non-experimental 0.147.0 schema bundle', () => {
    expect(CODEX_APP_SERVER_COMPATIBILITY).toMatchObject({
      provider: 'codex',
      providerVersion: '0.147.0',
      transport: CODEX_APP_SERVER_TRANSPORT_ID,
      schemaSha256: 'F72B2CAA3CBFA4298DE9E85C62DDA6DFBAF2266FFEB916FED30615CA69FF8C74',
      fixtureSet: CODEX_APP_SERVER_FIXTURE_SET,
      acceptedWorkBoundary: 'turn-start-write-attempt',
    });
    expect(CODEX_APP_SERVER_SCHEMA_SHA256).toBe(CODEX_APP_SERVER_COMPATIBILITY.schemaSha256);
    expect(Object.isFrozen(CODEX_APP_SERVER_COMPATIBILITY)).toBe(true);
    const schema = readFileSync(
      new URL(
        '../src/providers/codex/app-server-schema/0.147.0/codex_app_server_protocol.schemas.json',
        import.meta.url,
      ),
    );
    // Git may materialize text fixtures with CRLF on Windows. Pin the provider schema content,
    // while treating that checkout-only line-ending representation as equivalent.
    const normalizedSchema = schema.toString('utf8').replaceAll('\r\n', '\n');
    expect(createHash('sha256').update(normalizedSchema).digest('hex').toUpperCase()).toBe(
      CODEX_APP_SERVER_SCHEMA_SHA256,
    );
  });

  it('strictly parses the developer transport override', () => {
    expect(resolveCodexTransportMode(undefined)).toBe('auto');
    expect(resolveCodexTransportMode('auto')).toBe('auto');
    expect(resolveCodexTransportMode('app-server')).toBe('app-server');
    expect(resolveCodexTransportMode('exec')).toBe('exec');
    for (const invalid of ['', ' app-server', 'APP-SERVER', 'app_server', 'legacy']) {
      expect(() => resolveCodexTransportMode(invalid)).toThrow(CodexAppServerUnsupportedError);
    }
  });

  it('uses app-server only for the exact validated auto version', () => {
    const support = resolveCodexV2Support(status('0.147.0'), 'auto');
    expect(support?.transports).toEqual([CODEX_APP_SERVER_TRANSPORT]);
    expect(resolveCodexV2Support(status('0.147.1'), 'auto')).toBeUndefined();
    expect(resolveCodexV2Support(status(undefined), 'auto')).toBeUndefined();
    expect(resolveCodexV2Support(status('0.147.0'), 'exec')).toBeUndefined();
  });

  it('fails visibly when app-server is forced for an unknown version', () => {
    expect(() => resolveCodexV2Support(status('0.148.0'), 'app-server')).toThrow(
      /requires validated codex-cli 0\.147\.0; detected 0\.148\.0/,
    );
  });

  it('advertises only trusted, stable, explicitly allowlisted capabilities', () => {
    const support = resolveCodexV2Support(status('0.147.0'), 'app-server');
    expect(support).toBeDefined();
    for (const record of support!.capabilities) {
      expect(record.scope.transport).toBe(CODEX_APP_SERVER_TRANSPORT_ID);
      expect(record.scope.trustState).toBe('trusted');
      expect(record.prerequisites.trustStates).toEqual(['trusted']);
      expect(record.stability).toBe('stable');
    }
    expect(support!.capabilities.map((record) => record.id)).toContain('content.plans');
    expect(support!.capabilities.map((record) => record.id)).not.toContain('content.thinking');
    expect(support!.capabilities.map((record) => record.id)).not.toContain('model.catalog');
    expect(
      support!.capabilities.every((record) =>
        record.evidence.some(
          (evidence) =>
            evidence.kind === 'fixture' && evidence.reference === CODEX_APP_SERVER_FIXTURE_SET,
        ),
      ),
    ).toBe(true);
    const approvals = support!.capabilities.find((record) => record.id === 'interaction.approval');
    expect(approvals).toMatchObject({ effectsComplete: false });
    expect(approvals?.possibleEffects).toContain('network');
  });

  it('advertises subagent observation with no steer/interrupt/cancel and real fixture evidence', () => {
    const support = resolveCodexV2Support(status('0.147.0'), 'app-server');
    const ids = support!.capabilities.map((record) => record.id);
    expect(ids).toContain('agents.subagents.observe');
    // Codex's own schema has no per-subagent-thread control method (see issue #58), so this slice
    // only ever claims observation -- never a control it cannot actually dispatch.
    expect(ids).not.toContain('agents.subagents.steer');
    expect(ids).not.toContain('agents.subagents.interrupt');
    expect(ids).not.toContain('agents.subagents.cancel');
    const observe = support!.capabilities.find((record) => record.id === 'agents.subagents.observe');
    expect(observe).toMatchObject({ kind: 'observation', owner: 'provider', support: 'supported' });
    expect(
      observe?.evidence.some(
        (evidence) => evidence.kind === 'fixture' && evidence.reference === CODEX_APP_SERVER_FIXTURE_SET,
      ),
    ).toBe(true);
  });

  it('does not advertise native continuation for API-key authentication', () => {
    const support = resolveCodexV2Support(
      { ...status('0.147.0'), authSource: 'api_key' },
      'app-server',
    );
    expect(support?.capabilities.find(({ id }) => id === 'session.resume')).toMatchObject({
      support: 'unsupported',
    });
    expect(support?.capabilities.find(({ id }) => id === 'session.fork')).toMatchObject({
      support: 'unsupported',
    });
  });

  it('uses explicit stable method allowlists and rejects unsafe methods', () => {
    for (const method of [
      ...CODEX_APP_SERVER_OUTGOING_REQUEST_METHODS,
      ...CODEX_APP_SERVER_OUTGOING_NOTIFICATION_METHODS,
    ]) {
      expect(isCodexAppServerOutgoingMethod(method)).toBe(true);
    }
    for (const method of [
      ...CODEX_APP_SERVER_INCOMING_REQUEST_METHODS,
      ...CODEX_APP_SERVER_INCOMING_NOTIFICATION_METHODS,
    ]) {
      expect(isCodexAppServerIncomingMethod(method)).toBe(true);
    }
    for (const unsafe of [
      'account/login/start',
      'account/chatgptAuthTokens/refresh',
      'process/spawn',
      'thread/shellCommand',
      'item/tool/requestUserInput',
      'experimentalFeature/list',
    ]) {
      expect(isCodexAppServerOutgoingMethod(unsafe)).toBe(false);
      expect(isCodexAppServerIncomingMethod(unsafe)).toBe(false);
    }
  });
});
