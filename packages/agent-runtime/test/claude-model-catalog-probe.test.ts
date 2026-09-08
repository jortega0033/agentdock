import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ModelInfo, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { probeClaudeModelCatalog } from '../src/providers/claude/sdk/catalog-probe.js';
import {
  type ClaudeAgentSdkFactory,
  type ClaudeAgentSdkQuery,
} from '../src/providers/claude/sdk/index.js';
import { resolveClaudeSdkConfigDir } from '../src/providers/claude/sdk-options.js';

const testConfigRoot = mkdtempSync(join(tmpdir(), 'agent-dock-claude-catalog-probe-test-'));

afterAll(() => rmSync(testConfigRoot, { recursive: true, force: true }));

const auth = { eligible: true, source: 'api_key' } as const;

const MODELS: ModelInfo[] = [
  { value: 'claude-opus-5', displayName: 'Claude Opus 5', description: 'Most capable' },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    description: 'Balanced',
  },
];

function initMessage(model: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: 'session-1',
    cwd: resolve('.'),
    model,
    claude_code_version: '2.1.260',
    permissionMode: 'default',
    apiKeySource: 'ANTHROPIC_API_KEY',
    tools: [],
    mcp_servers: [],
    skills: [],
    plugins: [],
  } as unknown as SDKMessage;
}

class FakeCatalogQuery implements ClaudeAgentSdkQuery {
  readonly close = vi.fn();
  readonly interrupt = vi.fn(async () => undefined);
  consumedPrompt: SDKUserMessage[] = [];

  constructor(
    prompt: string | AsyncIterable<SDKUserMessage>,
    private readonly models: ModelInfo[] | (() => Promise<ModelInfo[]>),
    private readonly firstMessage?: SDKMessage | (() => Promise<SDKMessage>),
  ) {
    if (typeof prompt === 'string') throw new Error('expected streaming input');
    void this.drain(prompt);
  }

  private async drain(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    for await (const message of prompt) this.consumedPrompt.push(message);
  }

  // Instance fields (not prototype methods) so a test can build `{ ...fake, next: undefined }`
  // and only strip the one method it means to -- spreading a class instance never picks up
  // prototype methods, so a prototype `next()` would silently vanish from the spread too.
  supportedModels = async (): Promise<ModelInfo[]> =>
    typeof this.models === 'function' ? this.models() : this.models;

  next = async (): Promise<IteratorResult<SDKMessage, void>> => {
    if (!this.firstMessage) return { value: undefined, done: true };
    const value =
      typeof this.firstMessage === 'function' ? await this.firstMessage() : this.firstMessage;
    return { value, done: false };
  };

  [Symbol.asyncIterator](): AsyncIterator<unknown, void> {
    return { next: async () => ({ value: undefined, done: true }) };
  }
}

function fakeFactory(
  models: ModelInfo[] | (() => Promise<ModelInfo[]>),
  firstMessage?: SDKMessage | (() => Promise<SDKMessage>),
): { factory: ClaudeAgentSdkFactory; query(): FakeCatalogQuery } {
  let queryValue: FakeCatalogQuery | undefined;
  return {
    factory: {
      query: (parameters) => {
        queryValue = new FakeCatalogQuery(parameters.prompt, models, firstMessage);
        return queryValue;
      },
    },
    query: () => {
      if (!queryValue) throw new Error('query not started');
      return queryValue;
    },
  };
}

function probeOptions(overrides: Record<string, unknown> = {}) {
  return {
    executable: resolve('claude-sdk.exe'),
    cwd: resolve('.'),
    env: { ANTHROPIC_API_KEY: 'test-key' },
    auth,
    daemonConfigRoot: testConfigRoot,
    ...overrides,
  };
}

describe('probeClaudeModelCatalog', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the catalog and marks the resolved default model, without delivering a prompt', async () => {
    const harness = fakeFactory(MODELS, initMessage('claude-sonnet-5'));
    const models = await probeClaudeModelCatalog(probeOptions({ factory: harness.factory }));

    expect(models).toEqual([
      { id: 'claude-opus-5', displayName: 'Claude Opus 5', isDefault: false },
      { id: 'sonnet', displayName: 'Claude Sonnet 5', isDefault: true },
    ]);
    expect(harness.query().consumedPrompt).toHaveLength(0);
    expect(harness.query().close).toHaveBeenCalledOnce();
  });

  it('matches the default model by its own value, not only its resolved alias', async () => {
    const harness = fakeFactory(MODELS, initMessage('claude-opus-5'));
    const models = await probeClaudeModelCatalog(probeOptions({ factory: harness.factory }));
    expect(models.find((model) => model.id === 'claude-opus-5')?.isDefault).toBe(true);
    expect(models.find((model) => model.id === 'sonnet')?.isDefault).toBe(false);
  });

  it('still returns the catalog when the query exposes no default-model signal at all', async () => {
    const harness = fakeFactory(MODELS);
    const models = await probeClaudeModelCatalog(probeOptions({ factory: harness.factory }));
    expect(models.every((model) => model.isDefault === false)).toBe(true);
  });

  it('still returns the catalog when reading the default model fails', async () => {
    const harness = fakeFactory(MODELS, () => Promise.reject(new Error('no init yet')));
    const models = await probeClaudeModelCatalog(probeOptions({ factory: harness.factory }));
    expect(models.every((model) => model.isDefault === false)).toBe(true);
  });

  it('still returns the catalog when the query never implements next()', async () => {
    const bareFactory: ClaudeAgentSdkFactory = {
      query: (parameters) => {
        const fake = new FakeCatalogQuery(parameters.prompt, MODELS);
        return { ...fake, next: undefined } as unknown as ClaudeAgentSdkQuery;
      },
    };
    const models = await probeClaudeModelCatalog(probeOptions({ factory: bareFactory }));
    expect(models.every((model) => model.isDefault === false)).toBe(true);
  });

  it(
    'fails when the query never resolves supportedModels()',
    async () => {
      const harness = fakeFactory(() => new Promise<ModelInfo[]>(() => undefined));
      await expect(
        probeClaudeModelCatalog(probeOptions({ factory: harness.factory })),
      ).rejects.toThrow(/model catalog request timed out/i);
      expect(harness.query().close).toHaveBeenCalledOnce();
    },
    15_000,
  );

  it('fails when the query exposes no model-catalog control call', async () => {
    const bareFactory: ClaudeAgentSdkFactory = {
      query: (parameters) => {
        const fake = new FakeCatalogQuery(parameters.prompt, MODELS);
        return { ...fake, supportedModels: undefined } as unknown as ClaudeAgentSdkQuery;
      },
    };
    await expect(
      probeClaudeModelCatalog(probeOptions({ factory: bareFactory })),
    ).rejects.toThrow(/does not expose a model catalog/i);
  });

  it('creates and always removes its own isolated config directory', async () => {
    const harness = fakeFactory(MODELS);
    let capturedConfigDir: string | undefined;
    const factory: ClaudeAgentSdkFactory = {
      query: (parameters) => {
        capturedConfigDir = (parameters.options?.env as Record<string, string> | undefined)
          ?.CLAUDE_CONFIG_DIR;
        expect(capturedConfigDir).toBeDefined();
        expect(existsSync(capturedConfigDir!)).toBe(true);
        return harness.factory.query(parameters);
      },
    };
    await probeClaudeModelCatalog(probeOptions({ factory }));
    expect(existsSync(capturedConfigDir!)).toBe(false);
  });

  it('removes its config directory even when supportedModels() rejects', async () => {
    let capturedConfigDir: string | undefined;
    const factory: ClaudeAgentSdkFactory = {
      query: (parameters) => {
        capturedConfigDir = (parameters.options?.env as Record<string, string> | undefined)
          ?.CLAUDE_CONFIG_DIR;
        const fake = new FakeCatalogQuery(parameters.prompt, () =>
          Promise.reject(new Error('boom')),
        );
        return fake;
      },
    };
    await expect(probeClaudeModelCatalog(probeOptions({ factory }))).rejects.toThrow('boom');
    expect(existsSync(capturedConfigDir!)).toBe(false);
  });

  it('derives a fresh config directory under the given daemon config root every call', async () => {
    const first = fakeFactory(MODELS);
    const second = fakeFactory(MODELS);
    await probeClaudeModelCatalog(probeOptions({ factory: first.factory }));
    await probeClaudeModelCatalog(probeOptions({ factory: second.factory }));
    expect(
      resolveClaudeSdkConfigDir(testConfigRoot, 'a'.repeat(32)) !==
        resolveClaudeSdkConfigDir(testConfigRoot, 'b'.repeat(32)),
    ).toBe(true);
  });
});
