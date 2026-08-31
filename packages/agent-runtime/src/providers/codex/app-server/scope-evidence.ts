import { createHash } from 'node:crypto';
import {
  ProviderTransportStartupError,
  type ProviderContinuationEvidence,
} from '../../../types.js';
import { CodexAppServerProtocolError, safeDisplay } from './errors.js';

type JsonObject = Record<string, unknown>;

export interface CodexAppServerModel {
  id: string;
  displayName: string;
  isDefault: boolean;
}

export interface CodexAccountScope {
  authSource: 'chatgpt' | 'api_key';
  fingerprint?: string;
}

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodexAppServerProtocolError('frame_invalid', `Invalid ${label}`);
  }
  return value as JsonObject;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 64 * 1024) {
    throw new CodexAppServerProtocolError('frame_invalid', `Invalid ${label}`);
  }
  return value;
}

function hasUnsafeDisplayCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return (
      codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || /\p{Cf}/u.test(character)
    );
  });
}

export function parseCodexAccountScope(result: unknown): CodexAccountScope {
  const response = asObject(result, 'account/read response');
  if (typeof response.requiresOpenaiAuth !== 'boolean') {
    throw new CodexAppServerProtocolError('frame_invalid', 'Invalid account/read response');
  }
  if (response.account === null || response.account === undefined) {
    throw new ProviderTransportStartupError(
      'codex_auth_scope_changed',
      'not_delivered',
      'Codex app-server has no authenticated account',
    );
  }
  const account = asObject(response.account, 'account');
  if (account.type === 'apiKey') return { authSource: 'api_key' };
  if (account.type !== 'chatgpt' || (account.email !== null && typeof account.email !== 'string')) {
    throw new ProviderTransportStartupError(
      'codex_auth_scope_changed',
      'not_delivered',
      'Codex app-server authentication source is unsupported',
    );
  }
  if (account.email === null) return { authSource: 'chatgpt' };
  const normalized = account.email.trim().normalize('NFKC').toLowerCase();
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized) > 512 ||
    hasUnsafeDisplayCharacters(normalized)
  ) {
    return { authSource: 'chatgpt' };
  }
  return {
    authSource: 'chatgpt',
    fingerprint: createHash('sha256').update(normalized, 'utf8').digest('hex'),
  };
}

export function parseCodexModelCatalog(result: unknown): readonly CodexAppServerModel[] {
  const response = asObject(result, 'model/list response');
  if (!Array.isArray(response.data) || response.data.length > 1_024) {
    throw new CodexAppServerProtocolError('frame_invalid', 'Invalid Codex model catalog');
  }
  const models = response.data.map((rawModel) => {
    const model = asObject(rawModel, 'model');
    const id = asString(model.id ?? model.model, 'model id');
    if (Buffer.byteLength(id) > 256 || hasUnsafeDisplayCharacters(id)) {
      throw new CodexAppServerProtocolError('frame_invalid', 'Invalid model id');
    }
    return Object.freeze({
      id,
      displayName: safeDisplay(model.displayName, 256, 'Codex model'),
      isDefault: model.isDefault === true,
    });
  });
  return Object.freeze(models);
}

export function resolveCodexSelectedModel(
  catalog: readonly CodexAppServerModel[],
  pinnedModel?: string,
): string {
  if (pinnedModel) {
    if (!catalog.some(({ id }) => id === pinnedModel)) {
      throw new ProviderTransportStartupError(
        'codex_model_unavailable',
        'not_delivered',
        'Pinned Codex model is unavailable',
      );
    }
    return pinnedModel;
  }
  const defaults = catalog.filter(({ isDefault }) => isDefault);
  if (defaults.length !== 1) {
    throw new ProviderTransportStartupError(
      'codex_model_unverified',
      'not_delivered',
      'Codex default model could not be determined exactly',
    );
  }
  return defaults[0]!.id;
}

export function toCodexContinuationEvidence(
  account: CodexAccountScope,
  selectedModel: string,
): ProviderContinuationEvidence | undefined {
  return account.fingerprint
    ? Object.freeze({ accountFingerprint: account.fingerprint, selectedModel })
    : undefined;
}
