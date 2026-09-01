import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { AgentCommandV2, AgentEventV2 } from '@agent-dock/shared';
import {
  ProviderCommandRejectedError,
  ProviderTransportStartupError,
  type AcceptedWorkState,
  type InteractiveProviderTransport,
  type ProviderInteractionResolution,
  type ProviderDeliveryState,
  type ProviderContinuationEvidence,
  type ProviderRuntimeMetadata,
  type StartInteractiveSessionOptions,
} from '../../../types.js';
import {
  CODEX_APP_SERVER_FIXTURE_SET,
  CODEX_APP_SERVER_SCHEMA_SHA256,
  CODEX_APP_SERVER_TRANSPORT_ID,
} from '../app-server-support.js';
import { FailableChannel } from './channel.js';
import { deferred } from './deferred.js';
import { CodexAppServerProtocolError, safeDisplay } from './errors.js';
import { ManagedAppServerProcess } from './managed-process.js';
import { CodexAppServerNormalizer } from './normalizer.js';
import { CodexAppServerRpc, type IncomingRequestResponder } from './rpc.js';
import {
  parseCodexAccountScope,
  parseCodexModelCatalog,
  resolveCodexSelectedModel,
  toCodexContinuationEvidence,
  type CodexAppServerModel,
} from './scope-evidence.js';

type JsonObject = Record<string, unknown>;
type NativeQuestionValue = string | number | boolean | null;

export type CodexAppServerSandbox = 'read-only' | 'workspace-write';
export type CodexAppServerApprovalPolicy = 'untrusted' | 'on-request' | 'never';

export type CodexAppServerContinuation =
  { kind: 'resume'; threadId: string } | { kind: 'fork'; threadId: string; lastTurnId?: string };

export interface CodexAppServerTransportOptions extends Omit<
  StartInteractiveSessionOptions,
  'continuation'
> {
  /** Canonical executable returned by provider detection. Never interpreted by a shell. */
  executable: string;
  /** Test/embedding prefix only; `app-server --stdio` is always appended. */
  executableArgs?: readonly string[];
  continuation?: CodexAppServerContinuation;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandbox;
  clientVersion?: string;
  requestedTransportMode?: 'auto' | 'app-server';
  /** Test/embedding seam; production always uses the host platform. */
  processPlatform?: NodeJS.Platform;
  /** Test/development override for the packaged Windows Job Object host. */
  windowsJobHostPath?: string;
}

export type { CodexAppServerModel } from './scope-evidence.js';

export interface CodexAppServerModelProviderCapabilities {
  imageGeneration: boolean;
  namespaceTools: boolean;
  webSearch: boolean;
}

type PendingInteraction =
  | {
      kind: 'approval';
      nativeKind: 'command' | 'file' | 'permissions' | 'mcp_url';
      requestId: string;
      turnId: string;
      responder: IncomingRequestResponder;
      grantedPermissions?: JsonObject;
      nativeItemId?: string;
      nativeApprovalKey: string;
      nativeRequestKey: string;
    }
  | {
      kind: 'question';
      nativeKind: 'tool_question' | 'mcp_form';
      requestId: string;
      turnId: string;
      responder: IncomingRequestResponder;
      questionIds: Map<string, string>;
      optionValues: Map<string, Map<string, NativeQuestionValue>>;
      freeTextQuestionIds: Set<string>;
      nativeItemId?: string;
      nativeRequestKey: string;
    };

const MAX_PENDING_INTERACTIONS = 32;
const INTERACTION_TIMEOUT_MS = 300_000;
// Content blocks are capped at 256 KiB by the normalizer. Leave room for the validated envelope.
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_BUFFERED_EVENT_BYTES = 16 * 1024 * 1024;

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

function exactApprovalText(value: unknown, maximumBytes: number, label: string): string {
  const text = asString(value, label);
  if (Buffer.byteLength(text) > maximumBytes || hasUnsafeDisplayCharacters(text)) {
    throw new CodexAppServerProtocolError(
      'interaction_invalid',
      `${label} cannot be represented losslessly`,
    );
  }
  return text;
}

function exactEventBytes(event: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(event);
  } catch {
    throw new CodexAppServerProtocolError('frame_invalid', 'Codex event is not serializable');
  }
  return Buffer.byteLength(serialized, 'utf8');
}

function canonicalExistingPath(value: unknown, label: string): string {
  try {
    return realpathSync.native(asString(value, label));
  } catch {
    throw new CodexAppServerProtocolError('state_invalid', `Invalid ${label}`);
  }
}

function pathEscapes(base: string, target: string): boolean {
  const pathFromBase = relative(base, target);
  return (
    pathFromBase === '..' ||
    pathFromBase.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(pathFromBase)
  );
}

function lexicalProviderPath(
  value: unknown,
  label: string,
  lexicalWorkspace: string,
  allowRelative: boolean,
): string {
  const raw = asString(value, label);
  // Never let a provider-controlled UNC or Win32 device path reach realpath: doing so can trigger
  // remote SMB authentication or device I/O before containment is checked.
  if (raw.replaceAll('/', '\\').startsWith('\\\\')) {
    throw new CodexAppServerProtocolError('state_invalid', `Invalid ${label}`);
  }
  if (!allowRelative && !isAbsolute(raw)) {
    throw new CodexAppServerProtocolError('state_invalid', `Invalid ${label}`);
  }
  const lexical = resolve(lexicalWorkspace, raw);
  if (pathEscapes(lexicalWorkspace, lexical)) {
    throw new CodexAppServerProtocolError(
      'state_invalid',
      `${label} escaped the trusted workspace`,
    );
  }
  return lexical;
}

function canonicalProviderPath(
  value: unknown,
  label: string,
  lexicalWorkspace: string,
  allowRelative = false,
): string {
  const lexical = lexicalProviderPath(value, label, lexicalWorkspace, allowRelative);
  try {
    return realpathSync.native(lexical);
  } catch {
    throw new CodexAppServerProtocolError('state_invalid', `Invalid ${label}`);
  }
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function validateEffectiveSandbox(
  value: unknown,
  expected: CodexAppServerSandbox,
  canonicalCwd: string,
): void {
  const sandbox = asObject(value, 'thread sandbox');
  const expectedType = expected === 'workspace-write' ? 'workspaceWrite' : 'readOnly';
  if (sandbox.type !== expectedType) {
    throw new CodexAppServerProtocolError('state_invalid', 'Codex effective sandbox changed');
  }
  const allowedKeys =
    expected === 'workspace-write'
      ? ['type', 'networkAccess', 'writableRoots', 'excludeSlashTmp', 'excludeTmpdirEnvVar']
      : ['type', 'networkAccess'];
  assertOnlyKeys(sandbox, allowedKeys, 'thread sandbox');
  if (sandbox.networkAccess !== undefined && sandbox.networkAccess !== false) {
    throw new CodexAppServerProtocolError(
      'state_invalid',
      'Codex effective sandbox enabled network access',
    );
  }
  if (expected === 'read-only') return;
  for (const field of ['excludeSlashTmp', 'excludeTmpdirEnvVar'] as const) {
    if (sandbox[field] !== undefined && typeof sandbox[field] !== 'boolean') {
      throw new CodexAppServerProtocolError('state_invalid', 'Invalid Codex sandbox policy');
    }
  }
  const roots = sandbox.writableRoots ?? [];
  if (!Array.isArray(roots) || roots.length > 64) {
    throw new CodexAppServerProtocolError('state_invalid', 'Invalid Codex writable roots');
  }
  for (const rawRoot of roots) {
    const root = canonicalProviderPath(rawRoot, 'Codex writable root', resolve(canonicalCwd));
    if (pathEscapes(canonicalCwd, root)) {
      throw new CodexAppServerProtocolError(
        'state_invalid',
        'Codex writable root escaped the trusted workspace',
      );
    }
  }
}

function nativeThreadId(
  result: unknown,
  expected: {
    cwd: string;
    model: string;
    approvalPolicy: CodexAppServerApprovalPolicy;
    sandbox: CodexAppServerSandbox;
  },
): string {
  const response = asObject(result, 'thread response');
  const thread = asObject(response.thread, 'thread');
  const id = exactApprovalText(thread.id, 1_024, 'thread id');
  const lexicalCwd = resolve(asString(expected.cwd, 'requested thread cwd'));
  const canonicalCwd = canonicalExistingPath(expected.cwd, 'requested thread cwd');
  const effectiveLexical = lexicalProviderPath(
    response.cwd,
    'effective thread cwd',
    lexicalCwd,
    false,
  );
  const capturedLexical = lexicalProviderPath(thread.cwd, 'captured thread cwd', lexicalCwd, false);
  if (
    !sameCanonicalPath(effectiveLexical, lexicalCwd) ||
    !sameCanonicalPath(capturedLexical, lexicalCwd)
  ) {
    throw new CodexAppServerProtocolError('state_invalid', 'Codex effective thread scope changed');
  }
  const effectiveCwd = canonicalProviderPath(response.cwd, 'effective thread cwd', lexicalCwd);
  const capturedCwd = canonicalProviderPath(thread.cwd, 'captured thread cwd', lexicalCwd);
  if (
    !sameCanonicalPath(effectiveCwd, canonicalCwd) ||
    !sameCanonicalPath(capturedCwd, canonicalCwd) ||
    response.model !== expected.model ||
    response.approvalPolicy !== expected.approvalPolicy ||
    response.approvalsReviewer !== 'user'
  ) {
    throw new CodexAppServerProtocolError('state_invalid', 'Codex effective thread scope changed');
  }
  validateEffectiveSandbox(response.sandbox, expected.sandbox, canonicalCwd);
  return id;
}

function nativeTurnId(result: unknown): string {
  const response = asObject(result, 'turn response');
  return asString(asObject(response.turn, 'turn').id, 'turn id');
}

function textInput(
  command: Extract<AgentCommandV2, { type: 'input.follow_up' | 'input.steer' }>,
): JsonObject[] {
  const text: string[] = [];
  for (const block of command.content) {
    if (block.type !== 'text') {
      throw new CodexAppServerProtocolError(
        'forbidden_method',
        'Codex app-server transport negotiated text-only input',
      );
    }
    text.push(block.text);
  }
  return [{ type: 'text', text: text.join('\n'), text_elements: [] }];
}

function targetFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function rpcIdKey(id: string | number): string {
  return typeof id === 'number' ? `number:${id}` : `string:${id}`;
}

function approvalCorrelationKey(params: JsonObject, requestId: string | number): string {
  if (params.approvalId === undefined || params.approvalId === null) return rpcIdKey(requestId);
  return `approval:${exactApprovalText(params.approvalId, 512, 'approval id')}`;
}

function exactNetworkTarget(value: unknown): string {
  const context = asObject(value, 'network approval context');
  const protocol = context.protocol;
  if (!['http', 'https', 'socks5Tcp', 'socks5Udp'].includes(String(protocol))) {
    throw new CodexAppServerProtocolError('interaction_invalid', 'Invalid network protocol');
  }
  const host = exactApprovalText(context.host, 4 * 1024, 'network host');
  if (/[/?#@]/.test(host) || host.trim() !== host || !URL.canParse(`${protocol}://${host}`)) {
    throw new CodexAppServerProtocolError('interaction_invalid', 'Invalid network target');
  }
  return `${protocol}://${host}`;
}

function hasUnsafeDisplayCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return (
      codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || /\p{Cf}/u.test(character)
    );
  });
}

function exactMcpUrl(value: unknown): { authorizationTarget: string; safeTarget: string } {
  const target = exactApprovalText(value, 512, 'MCP URL');
  if (hasUnsafeDisplayCharacters(target)) {
    throw new CodexAppServerProtocolError('interaction_invalid', 'Invalid MCP URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new CodexAppServerProtocolError('interaction_invalid', 'Invalid MCP URL');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new CodexAppServerProtocolError('interaction_invalid', 'Unsafe MCP URL');
  }
  const authorizationTarget = parsed.href;
  if (Buffer.byteLength(authorizationTarget) > 512) {
    throw new CodexAppServerProtocolError('interaction_invalid', 'MCP URL is too long');
  }
  // Paths and queries may embed credentials. Persist only the origin while binding the approval
  // fingerprint to the exact canonical URL kept in provider-owned memory.
  return { authorizationTarget, safeTarget: parsed.origin };
}

function assertOnlyKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new CodexAppServerProtocolError('interaction_invalid', `Unsupported ${label} field`);
  }
}

function exactPermissionText(value: unknown, label: string): string {
  const text = exactApprovalText(value, 512, label);
  if (hasUnsafeDisplayCharacters(text)) {
    throw new CodexAppServerProtocolError('interaction_invalid', `Invalid ${label}`);
  }
  return text;
}

function validatedFileSystemPath(value: unknown): JsonObject {
  const path = asObject(value, 'filesystem permission path');
  const type = asString(path.type, 'filesystem permission path type');
  if (type === 'path') {
    assertOnlyKeys(path, ['type', 'path'], 'filesystem path');
    return { type, path: exactPermissionText(path.path, 'filesystem permission path') };
  }
  if (type === 'glob_pattern') {
    assertOnlyKeys(path, ['type', 'pattern'], 'filesystem path');
    return { type, pattern: exactPermissionText(path.pattern, 'filesystem permission pattern') };
  }
  if (type !== 'special') {
    throw new CodexAppServerProtocolError(
      'interaction_invalid',
      'Unsupported filesystem path type',
    );
  }
  assertOnlyKeys(path, ['type', 'value'], 'filesystem path');
  const special = asObject(path.value, 'filesystem special path');
  const kind = asString(special.kind, 'filesystem special path kind');
  if (['root', 'minimal', 'tmpdir', 'slash_tmp'].includes(kind)) {
    assertOnlyKeys(special, ['kind'], 'filesystem special path');
    return { type, value: { kind } };
  }
  if (kind === 'project_roots') {
    assertOnlyKeys(special, ['kind', 'subpath'], 'filesystem special path');
    const subpath = special.subpath;
    if (subpath !== undefined && subpath !== null && typeof subpath !== 'string') {
      throw new CodexAppServerProtocolError(
        'interaction_invalid',
        'Invalid filesystem special path',
      );
    }
    return {
      type,
      value: {
        kind,
        ...(typeof subpath === 'string'
          ? { subpath: exactPermissionText(subpath, 'filesystem subpath') }
          : {}),
      },
    };
  }
  if (kind === 'unknown') {
    assertOnlyKeys(special, ['kind', 'path', 'subpath'], 'filesystem special path');
    const subpath = special.subpath;
    if (subpath !== undefined && subpath !== null && typeof subpath !== 'string') {
      throw new CodexAppServerProtocolError(
        'interaction_invalid',
        'Invalid filesystem special path',
      );
    }
    return {
      type,
      value: {
        kind,
        path: exactPermissionText(special.path, 'filesystem special path'),
        ...(typeof subpath === 'string'
          ? { subpath: exactPermissionText(subpath, 'filesystem subpath') }
          : {}),
      },
    };
  }
  throw new CodexAppServerProtocolError(
    'interaction_invalid',
    'Unsupported filesystem special path',
  );
}

function validatedPermissionProfile(value: unknown): {
  grant: JsonObject;
  target: string;
  hasNetwork: boolean;
  hasFilesystem: boolean;
} {
  const permissions = asObject(value, 'permissions');
  assertOnlyKeys(permissions, ['network', 'fileSystem'], 'permissions');
  const grant: JsonObject = {};
  if (permissions.network !== undefined && permissions.network !== null) {
    const network = asObject(permissions.network, 'network permissions');
    assertOnlyKeys(network, ['enabled'], 'network permissions');
    if (network.enabled !== true) {
      throw new CodexAppServerProtocolError(
        'interaction_invalid',
        'Unsupported network permissions',
      );
    }
    grant.network = { enabled: true };
  }
  if (permissions.fileSystem !== undefined && permissions.fileSystem !== null) {
    const fileSystem = asObject(permissions.fileSystem, 'filesystem permissions');
    assertOnlyKeys(
      fileSystem,
      ['entries', 'globScanMaxDepth', 'read', 'write'],
      'filesystem permissions',
    );
    const fileGrant: JsonObject = {};
    for (const field of ['read', 'write'] as const) {
      const values = fileSystem[field];
      if (values === undefined || values === null) continue;
      if (!Array.isArray(values) || values.length > 64) {
        throw new CodexAppServerProtocolError(
          'interaction_invalid',
          'Invalid filesystem permission paths',
        );
      }
      fileGrant[field] = values.map((entry) =>
        exactPermissionText(entry, 'filesystem permission path'),
      );
    }
    if (fileSystem.entries !== undefined && fileSystem.entries !== null) {
      if (!Array.isArray(fileSystem.entries) || fileSystem.entries.length > 64) {
        throw new CodexAppServerProtocolError(
          'interaction_invalid',
          'Invalid filesystem permission entries',
        );
      }
      fileGrant.entries = fileSystem.entries.map((rawEntry) => {
        const entry = asObject(rawEntry, 'filesystem permission entry');
        assertOnlyKeys(entry, ['access', 'path'], 'filesystem permission entry');
        if (!['read', 'write', 'deny'].includes(String(entry.access))) {
          throw new CodexAppServerProtocolError(
            'interaction_invalid',
            'Invalid filesystem permission access',
          );
        }
        return { access: entry.access, path: validatedFileSystemPath(entry.path) };
      });
    }
    if (fileSystem.globScanMaxDepth !== undefined && fileSystem.globScanMaxDepth !== null) {
      if (
        typeof fileSystem.globScanMaxDepth !== 'number' ||
        !Number.isSafeInteger(fileSystem.globScanMaxDepth) ||
        fileSystem.globScanMaxDepth < 1
      ) {
        throw new CodexAppServerProtocolError(
          'interaction_invalid',
          'Invalid filesystem glob depth',
        );
      }
      fileGrant.globScanMaxDepth = fileSystem.globScanMaxDepth;
    }
    if (Object.keys(fileGrant).length === 0) {
      throw new CodexAppServerProtocolError('interaction_invalid', 'Empty filesystem permissions');
    }
    grant.fileSystem = fileGrant;
  }
  if (Object.keys(grant).length === 0) {
    throw new CodexAppServerProtocolError('interaction_invalid', 'Empty permissions request');
  }
  const target = `permissions:${JSON.stringify(grant)}`;
  if (Buffer.byteLength(target) > 512) {
    throw new CodexAppServerProtocolError(
      'interaction_invalid',
      'Permissions cannot be represented losslessly',
    );
  }
  return {
    grant,
    target,
    hasNetwork: grant.network !== undefined,
    hasFilesystem: grant.fileSystem !== undefined,
  };
}

function deadline(): string {
  return new Date(Date.now() + INTERACTION_TIMEOUT_MS).toISOString();
}

/**
 * Native Codex app-server transport. This is intentionally not exported from package index until
 * the provider adapter has selected a pinned compatible CLI and supplied trusted-workspace proof.
 */
export class CodexAppServerTransport implements InteractiveProviderTransport {
  private readonly eventChannel = new FailableChannel<unknown>(
    5_000,
    MAX_BUFFERED_EVENT_BYTES,
    exactEventBytes,
  );
  private readonly acceptedDeferred = deferred<AcceptedWorkState>();
  private readonly process: ManagedAppServerProcess;
  private readonly rpc: CodexAppServerRpc;
  private readonly normalizer: CodexAppServerNormalizer;
  private readonly interactions = new Map<string, PendingInteraction>();
  private deliveryState: 'not_delivered' | 'ambiguous' | 'delivered' = 'not_delivered';
  private closing = false;
  private failed = false;
  private failure: Error | undefined;
  private modelCatalogValue: readonly CodexAppServerModel[] = Object.freeze([]);
  private continuationEvidenceValue: Readonly<ProviderContinuationEvidence> | undefined;
  private modelProviderCapabilitiesValue: Readonly<CodexAppServerModelProviderCapabilities> =
    Object.freeze({ imageGeneration: false, namespaceTools: false, webSearch: false });
  readonly events = this.eventChannel[Symbol.asyncIterator]();
  readonly stderr: AsyncGenerator<unknown, void, void>;
  readonly accepted = this.acceptedDeferred.promise;
  readonly started: Promise<void>;
  readonly runtimeMetadata: Readonly<ProviderRuntimeMetadata>;

  constructor(private readonly options: CodexAppServerTransportOptions) {
    this.normalizer = new CodexAppServerNormalizer((event) => this.emit(event));
    this.rpc = new CodexAppServerRpc({
      write: (frame) => this.process.write(frame),
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (request) => this.handleServerRequest(request),
      onFatal: (error) => this.fail(error),
    });
    this.process = new ManagedAppServerProcess({
      executable: options.executable,
      executableArgs: options.executableArgs,
      cwd: options.cwd,
      env: options.env,
      platform: options.processPlatform,
      windowsJobHostPath: options.windowsJobHostPath,
      onStdout: (chunk) => this.rpc.acceptStdout(chunk),
      onStdoutEnd: () => this.rpc.endStdout(),
      onFailure: (error) => this.rpc.fail(error),
    });
    this.stderr = this.process.stderr;
    this.runtimeMetadata = Object.freeze({
      ...(options.providerStatus?.version ? { cliVersion: options.providerStatus.version } : {}),
      schemaVersion: CODEX_APP_SERVER_SCHEMA_SHA256,
      fixtureSet: CODEX_APP_SERVER_FIXTURE_SET,
      requestedTransportMode: options.requestedTransportMode ?? 'app-server',
    });
    this.started = Promise.resolve()
      .then(() => this.start())
      .catch(async (error: unknown) => {
        if (!this.acceptedDeferred.settled) {
          this.acceptedDeferred.resolve(
            this.deliveryState === 'not_delivered' ? 'not_accepted' : 'unknown',
          );
        }
        this.eventChannel.fail(error);
        await this.process.forceClose().catch(() => undefined);
        if (error instanceof ProviderTransportStartupError) throw error;
        throw new ProviderTransportStartupError(
          error instanceof CodexAppServerProtocolError
            ? error.code
            : 'codex_app_server_startup_failed',
          this.deliveryState === 'not_delivered'
            ? 'not_delivered'
            : this.deliveryState === 'ambiguous'
              ? 'ambiguous'
              : 'delivered',
          error instanceof Error ? error.message : 'Codex app-server startup failed',
        );
      });
  }

  get providerSessionId(): string | undefined {
    return this.normalizer.providerThreadId;
  }

  get continuationEvidence(): Readonly<ProviderContinuationEvidence> | undefined {
    return this.continuationEvidenceValue;
  }

  get workDeliveryState(): ProviderDeliveryState {
    return this.deliveryState === 'not_delivered'
      ? 'not_delivered'
      : this.deliveryState === 'ambiguous'
        ? 'ambiguous'
        : 'delivered';
  }

  get reaped(): boolean {
    return this.process.reaped;
  }

  get modelCatalog(): readonly CodexAppServerModel[] {
    return this.modelCatalogValue;
  }

  get modelProviderCapabilities(): Readonly<CodexAppServerModelProviderCapabilities> {
    return this.modelProviderCapabilitiesValue;
  }

  async send(command: AgentCommandV2): Promise<void> {
    this.assertOpen();
    if (command.type === 'input.follow_up') {
      this.normalizer.expectTurn(command.turnId);
      await this.options.beforeWorkDelivery?.();
      const result = await this.rpc.request('turn/start', {
        threadId: this.requireThreadId(),
        input: textInput(command),
      });
      this.normalizer.bindTurnResponse(nativeTurnId(result));
      return;
    }
    if (command.type === 'input.steer') {
      const active = this.requireActiveTurn(command.turnId);
      const result = asObject(
        await this.rpc.request('turn/steer', {
          threadId: this.requireThreadId(),
          expectedTurnId: active.nativeId,
          input: textInput(command),
        }),
        'turn/steer response',
      );
      if (asString(result.turnId, 'steered turn id') !== active.nativeId) {
        throw new CodexAppServerProtocolError(
          'state_invalid',
          'Codex steer response belongs to another turn',
        );
      }
      return;
    }
    if (command.type === 'session.interrupt') {
      await this.interrupt();
      return;
    }
    if (command.type === 'approval.respond') {
      const interaction = this.takeInteraction(command.requestId, command.turnId, 'approval');
      await this.respondApproval(interaction, command.decision);
      return;
    }
    const interaction = this.requireInteraction(command.requestId, command.turnId, 'question');
    if (
      command.answers.length !== interaction.questionIds.size ||
      new Set(command.answers.map((answer) => answer.questionId)).size !== command.answers.length
    ) {
      throw new ProviderCommandRejectedError(
        'Question response must answer each native question exactly once',
      );
    }
    const answers: Record<string, { answers: NativeQuestionValue[] }> = {};
    for (const answer of command.answers) {
      const nativeId = interaction.questionIds.get(answer.questionId);
      if (!nativeId) {
        throw new ProviderCommandRejectedError('Question answer did not match the native request');
      }
      const optionValues = interaction.optionValues.get(answer.questionId);
      let values: NativeQuestionValue[];
      if (Array.isArray(answer.value)) {
        if (!optionValues || answer.value.length === 0) {
          throw new ProviderCommandRejectedError(
            'Question option response did not match the native request',
          );
        }
        values = answer.value.map((optionId) => {
          if (!optionValues.has(optionId)) {
            throw new ProviderCommandRejectedError(
              'Question option response did not match the native request',
            );
          }
          return optionValues.get(optionId) as NativeQuestionValue;
        });
      } else {
        if (!interaction.freeTextQuestionIds.has(answer.questionId)) {
          throw new ProviderCommandRejectedError(
            'Free-text response is not allowed for this native question',
          );
        }
        values = [answer.value];
      }
      answers[nativeId] = { answers: values };
    }
    // Validation above is retryable. Claim the interaction only after every opaque identifier and
    // answer shape has been proven to belong to this exact native request.
    this.interactions.delete(command.requestId);
    if (interaction.nativeKind === 'tool_question') {
      await interaction.responder.respond({ answers });
    } else {
      const content = Object.fromEntries(
        Object.entries(answers).map(([key, value]) => [
          key,
          value.answers.length === 1 ? value.answers[0] : value.answers,
        ]),
      );
      await interaction.responder.respond({ action: 'accept', content, _meta: null });
    }
  }

  async resolveInteraction(resolution: ProviderInteractionResolution): Promise<void> {
    this.assertOpen();
    const interaction = this.takeInteraction(
      resolution.requestId,
      resolution.turnId,
      resolution.kind,
    );
    if (interaction.kind === 'approval') {
      await this.respondApproval(interaction, 'deny', true);
    } else if (interaction.nativeKind === 'tool_question') {
      await interaction.responder.respond({ answers: {} });
    } else {
      await interaction.responder.respond({ action: 'cancel', content: null, _meta: null });
    }
  }

  async interrupt(): Promise<void> {
    this.assertOpen();
    const active = this.normalizer.activeTurn;
    if (!active) {
      throw new CodexAppServerProtocolError('state_invalid', 'No active Codex turn to interrupt');
    }
    await this.rpc.request('turn/interrupt', {
      threadId: this.requireThreadId(),
      turnId: active.nativeId,
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.rpc.shutdown();
    this.interactions.clear();
    if (!this.acceptedDeferred.settled) {
      this.acceptedDeferred.resolve(
        this.deliveryState === 'not_delivered' ? 'not_accepted' : 'unknown',
      );
    }
    await this.process.close();
    this.eventChannel.close();
  }

  async forceClose(): Promise<void> {
    this.closing = true;
    this.rpc.shutdown();
    this.interactions.clear();
    if (!this.acceptedDeferred.settled) this.acceptedDeferred.resolve('unknown');
    await this.process.forceClose();
    this.eventChannel.close();
  }

  private async start(): Promise<void> {
    await this.process.ready;
    await this.rpc.request('initialize', {
      clientInfo: {
        name: 'agent_dock',
        title: 'Agent Dock',
        version: this.options.clientVersion ?? '0.1.0',
      },
      capabilities: null,
    });
    await this.rpc.notify('initialized');
    const account = parseCodexAccountScope(
      await this.rpc.request('account/read', { refreshToken: false }),
    );
    const detectedAuthSource = this.options.providerStatus?.authSource;
    if (
      !detectedAuthSource ||
      detectedAuthSource === 'unknown' ||
      account.authSource !== detectedAuthSource ||
      (this.options.providerStatus?.accountFingerprint !== undefined &&
        account.fingerprint !== this.options.providerStatus.accountFingerprint)
    ) {
      throw new ProviderTransportStartupError(
        'codex_auth_scope_changed',
        'not_delivered',
        'Codex authentication source or account changed before app-server startup',
      );
    }
    this.modelCatalogValue = parseCodexModelCatalog(
      await this.rpc.request('model/list', { limit: 1_024, includeHidden: false }),
    );
    const selectedModel = resolveCodexSelectedModel(this.modelCatalogValue, this.options.model);
    this.continuationEvidenceValue = toCodexContinuationEvidence(account, selectedModel);
    if (this.options.expectedContinuationEvidence) {
      const expected = this.options.expectedContinuationEvidence;
      if (
        !this.continuationEvidenceValue ||
        this.continuationEvidenceValue.accountFingerprint !== expected.accountFingerprint ||
        this.continuationEvidenceValue.selectedModel !== expected.selectedModel
      ) {
        throw new ProviderTransportStartupError(
          'codex_continuation_scope_changed',
          'not_delivered',
          'Codex continuation account or model no longer matches its daemon binding',
        );
      }
    }
    const selectedContinuation = this.options.selection.enabled.some(
      ({ id }) => id === 'session.resume' || id === 'session.fork',
    );
    if (selectedContinuation && !this.continuationEvidenceValue) {
      throw new ProviderTransportStartupError(
        'codex_continuation_scope_unverified',
        'not_delivered',
        'Codex continuation identity could not be verified',
      );
    }
    this.modelProviderCapabilitiesValue = this.parseModelProviderCapabilities(
      await this.rpc.request('modelProvider/capabilities/read', {}),
    );
    await this.options.beforeProviderThreadStart?.(this.continuationEvidenceValue);
    const continuation =
      this.options.continuation ??
      (this.options.resumeProviderSessionId
        ? { kind: 'resume' as const, threadId: this.options.resumeProviderSessionId }
        : undefined);
    let threadResult: unknown;
    const common = {
      cwd: this.options.cwd,
      approvalPolicy: this.options.approvalPolicy ?? 'on-request',
      approvalsReviewer: 'user',
      sandbox: this.options.sandbox ?? 'workspace-write',
      model: selectedModel,
    };
    if (continuation?.kind === 'resume') {
      threadResult = await this.threadRequest('thread/resume', {
        threadId: continuation.threadId,
        ...common,
      });
    } else if (continuation?.kind === 'fork') {
      threadResult = await this.threadRequest('thread/fork', {
        threadId: continuation.threadId,
        ...(continuation.lastTurnId ? { lastTurnId: continuation.lastTurnId } : {}),
        ...common,
      });
    } else {
      threadResult = await this.threadRequest('thread/start', common);
    }
    const providerThreadId = nativeThreadId(threadResult, {
      cwd: common.cwd,
      model: common.model,
      approvalPolicy: common.approvalPolicy,
      sandbox: common.sandbox,
    });
    if (continuation?.kind === 'resume' && providerThreadId !== continuation.threadId) {
      throw new CodexAppServerProtocolError(
        'state_invalid',
        'Codex resume response belongs to another thread',
      );
    }
    if (continuation?.kind === 'fork' && providerThreadId === continuation.threadId) {
      throw new CodexAppServerProtocolError(
        'state_invalid',
        'Codex fork response reused the source thread',
      );
    }
    this.normalizer.startSession(
      providerThreadId,
      this.options.transport.id || CODEX_APP_SERVER_TRANSPORT_ID,
      this.options.selection,
    );
    this.normalizer.expectTurn(this.options.turnId);
    await this.options.beforeWorkDelivery?.();
    const turnResult = await this.rpc.request(
      'turn/start',
      {
        threadId: providerThreadId,
        input: [{ type: 'text', text: this.options.prompt, text_elements: [] }],
      },
      () => {
        this.deliveryState = 'ambiguous';
      },
      () => {
        this.deliveryState = 'delivered';
        this.acceptedDeferred.resolve('accepted');
      },
    );
    this.normalizer.bindTurnResponse(nativeTurnId(turnResult));
  }

  private async handleServerRequest(request: IncomingRequestResponder): Promise<void> {
    this.assertOpen();
    if (this.interactions.size >= MAX_PENDING_INTERACTIONS) {
      await request.reject(-32000, 'Too many pending interactions');
      throw new CodexAppServerProtocolError(
        'interaction_invalid',
        'Codex app-server exceeded the interaction limit',
      );
    }
    const params = asObject(request.params, `${request.method} request`);
    if (request.method === 'mcpServer/elicitation/request') {
      try {
        const correlation = this.correlateMcpElicitation(params);
        if (!correlation) {
          await request.respond({ action: 'cancel', content: null, _meta: null });
          return;
        }
        await this.handleMcpElicitation(request, params, correlation.turnId);
      } catch (error) {
        if (error instanceof CodexAppServerProtocolError) {
          await request.respond({ action: 'cancel', content: null, _meta: null });
          return;
        }
        throw error;
      }
      return;
    }
    const correlation = this.correlateInteraction(params, true);
    if (request.method === 'item/tool/requestUserInput') {
      await this.handleToolQuestion(request, params, correlation.turnId, correlation.nativeItemId);
      return;
    }
    this.handleApproval(request, params, correlation.turnId, correlation.nativeItemId);
  }

  private handleNotification(method: string, rawParams: unknown): void {
    if (method !== 'serverRequest/resolved') {
      this.normalizer.notification(method, rawParams);
      return;
    }
    const params = asObject(rawParams, 'serverRequest/resolved params');
    if (asString(params.threadId, 'resolved request thread id') !== this.requireThreadId()) {
      throw new CodexAppServerProtocolError(
        'state_invalid',
        'Resolved interaction belongs to another thread',
      );
    }
    const nativeId = params.requestId;
    if (!(
      (typeof nativeId === 'number' && Number.isSafeInteger(nativeId)) ||
      (typeof nativeId === 'string' && nativeId.length > 0)
    )) {
      throw new CodexAppServerProtocolError('frame_invalid', 'Invalid resolved request id');
    }
    const key = rpcIdKey(nativeId);
    const interaction = [...this.interactions.values()].find(
      (candidate) => candidate.nativeRequestKey === key,
    );
    if (!interaction) return;
    this.interactions.delete(interaction.requestId);
    if (!this.rpc.abandonIncomingRequest(nativeId)) {
      throw new CodexAppServerProtocolError(
        'state_invalid',
        'Native interaction was already resolved',
      );
    }
    if (interaction.kind === 'approval') {
      this.emit({
        type: 'approval.resolved',
        turnId: interaction.turnId,
        requestId: interaction.requestId,
        decision: 'denied',
        actor: 'policy',
      });
    } else {
      this.emit({
        type: 'question.cancelled',
        turnId: interaction.turnId,
        requestId: interaction.requestId,
        reason: 'provider_cancelled',
      });
    }
  }

  private async threadRequest(
    method: 'thread/start' | 'thread/resume' | 'thread/fork',
    params: JsonObject,
  ): Promise<unknown> {
    return this.rpc.request(
      method,
      params,
      () => {
        this.deliveryState = 'ambiguous';
      },
      () => {
        // Thread selection contains no user prompt. A completed write restores replay safety until
        // turn/start begins writing the initial work item.
        this.deliveryState = 'not_delivered';
      },
    );
  }

  private parseModelProviderCapabilities(
    result: unknown,
  ): Readonly<CodexAppServerModelProviderCapabilities> {
    const response = asObject(result, 'model provider capabilities response');
    if (
      typeof response.imageGeneration !== 'boolean' ||
      typeof response.namespaceTools !== 'boolean' ||
      typeof response.webSearch !== 'boolean'
    ) {
      throw new CodexAppServerProtocolError(
        'frame_invalid',
        'Invalid Codex model provider capabilities',
      );
    }
    return Object.freeze({
      imageGeneration: response.imageGeneration,
      namespaceTools: response.namespaceTools,
      webSearch: response.webSearch,
    });
  }

  private canonicalWorkspaceTarget(rawTarget: unknown): string {
    if (
      typeof rawTarget === 'string' &&
      rawTarget.length > 0 &&
      hasUnsafeDisplayCharacters(rawTarget)
    ) {
      throw new CodexAppServerProtocolError(
        'interaction_invalid',
        'File approval target contains unsafe display characters',
      );
    }
    let base: string;
    let target: string;
    try {
      base = realpathSync.native(this.options.cwd);
      target =
        typeof rawTarget === 'string' && rawTarget.length > 0
          ? canonicalProviderPath(
              rawTarget,
              'file approval target',
              resolve(this.options.cwd),
              true,
            )
          : base;
    } catch {
      throw new CodexAppServerProtocolError(
        'interaction_invalid',
        'File approval target could not be canonicalized',
      );
    }
    if (
      pathEscapes(base, target) ||
      Buffer.byteLength(target) > 4 * 1024 ||
      hasUnsafeDisplayCharacters(target)
    ) {
      throw new CodexAppServerProtocolError(
        'interaction_invalid',
        'File approval target cannot be represented safely within the trusted workspace',
      );
    }
    return target;
  }

  private handleApproval(
    responder: IncomingRequestResponder,
    params: JsonObject,
    turnId: string,
    nativeItemId: string | undefined,
  ): void {
    let nativeKind: Extract<PendingInteraction, { kind: 'approval' }>['nativeKind'];
    let title: string;
    let action: string;
    let target: string;
    let possibleEffects: Array<'filesystem_write' | 'command' | 'network'>;
    let operation: string;
    let grantedPermissions: JsonObject | undefined;
    if (responder.method === 'item/commandExecution/requestApproval') {
      nativeKind = 'command';
      title = 'Allow command execution?';
      // Do not approve a hidden/truncated command tail. Null command text is unsupported until
      // commandActions has its own complete, lossless renderer.
      action = exactApprovalText(params.command, 4 * 1024, 'command approval text');
      if (params.networkApprovalContext) {
        target = exactNetworkTarget(params.networkApprovalContext);
        possibleEffects = ['command', 'network'];
        operation = 'codex.network.connect';
      } else {
        target = this.canonicalWorkspaceTarget(params.cwd);
        possibleEffects = ['command'];
        operation = 'codex.command.execute';
      }
    } else if (responder.method === 'item/fileChange/requestApproval') {
      nativeKind = 'file';
      title = 'Allow file changes?';
      action = 'Apply proposed file changes';
      target = this.canonicalWorkspaceTarget(params.grantRoot);
      possibleEffects = ['filesystem_write'];
      operation = 'codex.file.change';
    } else if (responder.method === 'item/permissions/requestApproval') {
      nativeKind = 'permissions';
      title = 'Allow additional permissions?';
      action = 'Grant additional sandbox permissions';
      const permissions = validatedPermissionProfile(params.permissions);
      target = permissions.target;
      possibleEffects = [
        ...(permissions.hasFilesystem ? (['filesystem_write'] as const) : []),
        ...(permissions.hasNetwork ? (['network'] as const) : []),
      ];
      grantedPermissions = permissions.grant;
      operation = 'codex.permissions.grant';
    } else {
      throw new CodexAppServerProtocolError(
        'forbidden_method',
        `Unsupported Codex approval request: ${responder.method}`,
      );
    }
    const nativeApprovalKey = approvalCorrelationKey(params, responder.id);
    if (
      [...this.interactions.values()].some(
        (interaction) =>
          interaction.kind === 'approval' && interaction.nativeApprovalKey === nativeApprovalKey,
      )
    ) {
      throw new CodexAppServerProtocolError(
        'interaction_invalid',
        'Duplicate native approval callback',
      );
    }
    if (Buffer.byteLength(target) > 512) {
      throw new CodexAppServerProtocolError(
        'interaction_invalid',
        'Approval target cannot be represented losslessly',
      );
    }
    const requestId = randomUUID();
    this.interactions.set(requestId, {
      kind: 'approval',
      nativeKind,
      requestId,
      turnId,
      responder,
      ...(grantedPermissions ? { grantedPermissions } : {}),
      nativeItemId,
      nativeApprovalKey,
      nativeRequestKey: rpcIdKey(responder.id),
    });
    this.emit({
      type: 'approval.requested',
      turnId,
      requestId,
      title,
      action,
      target,
      ...(typeof params.reason === 'string'
        ? { reason: safeDisplay(params.reason, 4 * 1024, 'Provider requested approval') }
        : {}),
      possibleEffects,
      effectsComplete: false,
      permission: {
        actionClass:
          nativeKind === 'command' && params.networkApprovalContext
            ? 'network'
            : nativeKind === 'command'
              ? 'command'
              : nativeKind === 'file'
                ? 'filesystem'
                : possibleEffects.length === 1 && possibleEffects[0] === 'network'
                  ? 'network'
                  : possibleEffects.length === 1 && possibleEffects[0] === 'filesystem_write'
                    ? 'filesystem'
                    : 'other',
        operation,
        targetFingerprint: targetFingerprint(target),
        safeTargetSummary: target,
        risk: 'unknown',
        effectsComplete: false,
        mcpDestructive: false,
      },
      allowedDecisions: ['allow_once', 'deny'],
      deadlineAt: deadline(),
    });
  }

  private async handleToolQuestion(
    responder: IncomingRequestResponder,
    params: JsonObject,
    turnId: string,
    nativeItemId: string | undefined,
  ): Promise<void> {
    if (
      !Array.isArray(params.questions) ||
      params.questions.length < 1 ||
      params.questions.length > 3
    ) {
      await responder.reject(-32602, 'Unsupported question shape');
      throw new CodexAppServerProtocolError(
        'interaction_invalid',
        'Invalid Codex question request',
      );
    }
    for (const rawQuestion of params.questions) {
      const question = asObject(rawQuestion, 'question');
      if (question.isSecret === true) {
        await responder.reject(-32602, 'Secret questions are not supported');
        throw new CodexAppServerProtocolError(
          'interaction_invalid',
          'Secret Codex questions are not supported',
        );
      }
    }
    const questionIds = new Map<string, string>();
    const optionValues = new Map<string, Map<string, NativeQuestionValue>>();
    const freeTextQuestionIds = new Set<string>();
    const questions = params.questions.map((rawQuestion) => {
      const question = asObject(rawQuestion, 'question');
      const nativeId = asString(question.id, 'question id');
      const id = randomUUID();
      questionIds.set(id, nativeId);
      if (question.isOther === true || !Array.isArray(question.options)) {
        freeTextQuestionIds.add(id);
      }
      let options: Array<{ id: string; label: string; description?: string }> | undefined;
      if (Array.isArray(question.options)) {
        if (question.options.length > 10) {
          throw new CodexAppServerProtocolError('interaction_invalid', 'Too many question options');
        }
        const nativeOptions = new Map<string, NativeQuestionValue>();
        optionValues.set(id, nativeOptions);
        options = question.options.map((rawOption) => {
          const option = asObject(rawOption, 'question option');
          const optionId = randomUUID();
          const nativeLabel = asString(option.label, 'question option label');
          const label = safeDisplay(nativeLabel, 512, 'Option');
          nativeOptions.set(optionId, nativeLabel);
          return {
            id: optionId,
            label,
            ...(typeof option.description === 'string'
              ? { description: safeDisplay(option.description, 2 * 1024, 'Option') }
              : {}),
          };
        });
      }
      return {
        id,
        title: safeDisplay(question.header, 512, 'Question'),
        prompt: safeDisplay(question.question, 4 * 1024, 'Choose an answer'),
        ...(options ? { options } : {}),
        allowsFreeText: question.isOther === true || options === undefined,
      };
    });
    const requestId = randomUUID();
    this.interactions.set(requestId, {
      kind: 'question',
      nativeKind: 'tool_question',
      requestId,
      turnId,
      responder,
      questionIds,
      optionValues,
      freeTextQuestionIds,
      nativeItemId,
      nativeRequestKey: rpcIdKey(responder.id),
    });
    this.emit({ type: 'question.requested', turnId, requestId, questions, deadlineAt: deadline() });
  }

  private async handleMcpElicitation(
    responder: IncomingRequestResponder,
    params: JsonObject,
    turnId: string,
  ): Promise<void> {
    if (params.mode === 'url') {
      const requestId = randomUUID();
      const { authorizationTarget, safeTarget } = exactMcpUrl(params.url);
      this.interactions.set(requestId, {
        kind: 'approval',
        nativeKind: 'mcp_url',
        requestId,
        turnId,
        responder,
        nativeApprovalKey: rpcIdKey(responder.id),
        nativeRequestKey: rpcIdKey(responder.id),
      });
      this.emit({
        type: 'approval.requested',
        turnId,
        requestId,
        title: 'Allow MCP elicitation?',
        action: 'Open an MCP-provided URL',
        target: safeTarget,
        possibleEffects: ['external_side_effect'],
        effectsComplete: false,
        permission: {
          actionClass: 'mcp',
          operation: 'codex.mcp.elicitation',
          targetFingerprint: targetFingerprint(authorizationTarget),
          safeTargetSummary: safeTarget,
          risk: 'unknown',
          effectsComplete: false,
          mcpDestructive: false,
        },
        allowedDecisions: ['allow_once', 'deny'],
        deadlineAt: deadline(),
      });
      return;
    }
    if (params.mode !== 'form') {
      throw new CodexAppServerProtocolError(
        'interaction_invalid',
        'Unsupported MCP elicitation request',
      );
    }
    const schema = asObject(params.requestedSchema, 'MCP elicitation schema');
    const properties = asObject(schema.properties, 'MCP elicitation properties');
    const entries = Object.entries(properties);
    if (entries.length < 1 || entries.length > 3) {
      throw new CodexAppServerProtocolError('interaction_invalid', 'Unsupported MCP form size');
    }
    for (const [, rawProperty] of entries) {
      const property = asObject(rawProperty, 'MCP form property');
      if (property.writeOnly === true || property.format === 'password') {
        throw new CodexAppServerProtocolError(
          'interaction_invalid',
          'Secret MCP elicitation fields are not supported',
        );
      }
      const nativeOptions = Array.isArray(property.enum) ? property.enum : undefined;
      if (!nativeOptions && property.type !== 'string') {
        throw new CodexAppServerProtocolError(
          'interaction_invalid',
          'Unsupported MCP elicitation field type',
        );
      }
      if (
        nativeOptions &&
        (nativeOptions.length < 1 ||
          nativeOptions.length > 10 ||
          nativeOptions.some(
            (option) =>
              option !== null &&
              typeof option !== 'string' &&
              typeof option !== 'number' &&
              typeof option !== 'boolean',
          ))
      ) {
        throw new CodexAppServerProtocolError(
          'interaction_invalid',
          'Unsupported MCP elicitation enum',
        );
      }
    }
    const questionIds = new Map<string, string>();
    const optionValues = new Map<string, Map<string, NativeQuestionValue>>();
    const freeTextQuestionIds = new Set<string>();
    const questions = entries.map(([nativeId, rawProperty]) => {
      const property = asObject(rawProperty, 'MCP form property');
      const id = randomUUID();
      const safeNativeId = safeDisplay(nativeId, 512, 'Field');
      questionIds.set(id, nativeId);
      const nativeOptions = Array.isArray(property.enum) ? property.enum : undefined;
      let options: Array<{ id: string; label: string }> | undefined;
      if (nativeOptions) {
        const values = new Map<string, NativeQuestionValue>();
        optionValues.set(id, values);
        options = nativeOptions.slice(0, 10).map((option) => {
          const optionId = randomUUID();
          const nativeValue = option as NativeQuestionValue;
          const label = safeDisplay(String(nativeValue), 512, 'Option');
          values.set(optionId, nativeValue);
          return { id: optionId, label };
        });
      } else {
        freeTextQuestionIds.add(id);
      }
      return {
        id,
        title: safeDisplay(property.title, 512, safeNativeId),
        prompt: safeDisplay(property.description, 4 * 1024, safeNativeId),
        ...(options ? { options } : {}),
        allowsFreeText: options === undefined,
      };
    });
    const requestId = randomUUID();
    this.interactions.set(requestId, {
      kind: 'question',
      nativeKind: 'mcp_form',
      requestId,
      turnId,
      responder,
      questionIds,
      optionValues,
      freeTextQuestionIds,
      nativeRequestKey: rpcIdKey(responder.id),
    });
    this.emit({ type: 'question.requested', turnId, requestId, questions, deadlineAt: deadline() });
  }

  private async respondApproval(
    interaction: Extract<PendingInteraction, { kind: 'approval' }>,
    decision: 'allow_once' | 'allow_session' | 'deny',
    cancelled = false,
  ): Promise<void> {
    if (interaction.nativeKind === 'mcp_url') {
      await interaction.responder.respond({
        action: decision === 'deny' ? (cancelled ? 'cancel' : 'decline') : 'accept',
        content: null,
        _meta: null,
      });
      return;
    }
    if (interaction.nativeKind === 'permissions') {
      await interaction.responder.respond({
        permissions: decision === 'deny' ? {} : (interaction.grantedPermissions ?? {}),
        // AgentDock owns session grants and trust-epoch invalidation; never persist provider grants.
        scope: 'turn',
      });
      return;
    }
    const nativeDecision =
      decision === 'allow_once' || decision === 'allow_session'
        ? 'accept'
        : cancelled
          ? 'cancel'
          : 'decline';
    await interaction.responder.respond({ decision: nativeDecision });
  }

  private takeInteraction<K extends PendingInteraction['kind']>(
    requestId: string,
    turnId: string,
    kind: K,
  ): Extract<PendingInteraction, { kind: K }> {
    const interaction = this.requireInteraction(requestId, turnId, kind);
    this.interactions.delete(requestId);
    return interaction;
  }

  private requireInteraction<K extends PendingInteraction['kind']>(
    requestId: string,
    turnId: string,
    kind: K,
  ): Extract<PendingInteraction, { kind: K }> {
    const interaction = this.interactions.get(requestId);
    if (!interaction || interaction.kind !== kind || interaction.turnId !== turnId) {
      throw new CodexAppServerProtocolError(
        'interaction_invalid',
        'Interaction is stale or belongs to another turn',
      );
    }
    return interaction as Extract<PendingInteraction, { kind: K }>;
  }

  private correlateInteraction(
    params: JsonObject,
    requireItemId: boolean,
  ): { turnId: string; nativeItemId?: string } {
    const threadId = asString(params.threadId, 'interaction thread id');
    if (threadId !== this.requireThreadId()) {
      throw new CodexAppServerProtocolError(
        'state_invalid',
        'Interaction belongs to another thread',
      );
    }
    const nativeTurnId = asString(params.turnId, 'interaction turn id');
    const active = this.normalizer.activeTurn;
    if (!active || active.nativeId !== nativeTurnId) {
      throw new CodexAppServerProtocolError(
        'state_invalid',
        'Interaction belongs to an inactive turn',
      );
    }
    const nativeItemId = requireItemId ? asString(params.itemId, 'interaction item id') : undefined;
    return { turnId: active.agentId, ...(nativeItemId ? { nativeItemId } : {}) };
  }

  private correlateMcpElicitation(params: JsonObject): { turnId: string } | undefined {
    if (typeof params.threadId !== 'string' || params.threadId !== this.requireThreadId()) {
      return undefined;
    }
    if (typeof params.turnId !== 'string' || params.turnId.length === 0) return undefined;
    const active = this.normalizer.activeTurn;
    if (active?.nativeId !== params.turnId) return undefined;
    return { turnId: active.agentId };
  }

  private requireThreadId(): string {
    const threadId = this.normalizer.providerThreadId;
    if (!threadId)
      throw new CodexAppServerProtocolError('state_invalid', 'Codex thread is unavailable');
    return threadId;
  }

  private requireActiveTurn(agentTurnId: string): { nativeId: string; agentId: string } {
    const active = this.normalizer.activeTurn;
    if (!active || active.agentId !== agentTurnId) {
      throw new CodexAppServerProtocolError('state_invalid', 'Codex turn is not active');
    }
    return active;
  }

  private emit(event: AgentEventV2): void {
    if (this.failure) throw this.failure;
    if (exactEventBytes(event) > MAX_EVENT_BYTES) {
      throw new CodexAppServerProtocolError(
        'frame_invalid',
        'Codex event exceeded the 256 KiB content-block limit',
      );
    }
    if (!this.eventChannel.push(event)) {
      throw new CodexAppServerProtocolError('state_invalid', 'Codex event queue overflowed');
    }
  }

  private assertOpen(): void {
    if (this.closing || this.failed) {
      throw new CodexAppServerProtocolError('closed', 'Codex app-server transport is closed');
    }
  }

  private fail(error: Error): void {
    if (this.failed || this.closing) return;
    this.failed = true;
    this.failure = error;
    this.interactions.clear();
    if (!this.acceptedDeferred.settled) {
      this.acceptedDeferred.resolve(
        this.deliveryState === 'not_delivered' ? 'not_accepted' : 'unknown',
      );
    }
    this.eventChannel.fail(error);
    void this.process?.forceClose().catch(() => undefined);
  }
}

/** Narrow factory kept separate from provider selection and trust policy. */
export function createCodexAppServerTransport(
  options: CodexAppServerTransportOptions,
): CodexAppServerTransport {
  return new CodexAppServerTransport(options);
}
