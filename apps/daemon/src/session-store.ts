import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { agentSessionSchema, type AgentSession } from '@agent-dock/shared';

/**
 * Where SessionManager keeps `AgentSession` records. Writes are synchronous so a session record is
 * durable before SessionManager starts or dispatches provider work.
 *
 * Scope is deliberately narrow: only the `AgentSession` record. A session's live process handle
 * (an `AsyncGenerator` plus a `cancel()` closure) isn't something you can "store" at all, and its
 * buffered event history is owned separately by the v2 execution graph.
 */
export interface SessionStore {
  create(session: AgentSession, protocolVersion?: 1 | 2): void;
  get(id: string): AgentSession | undefined;
  update(id: string, session: AgentSession): void;
  delete(id: string): void;
  list(): AgentSession[];
  protocolVersionOf(id: string): 1 | 2 | undefined;
}

/** In-memory store retained for isolated tests and embedders that explicitly do not need recovery. */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly protocolVersions = new Map<string, 1 | 2>();

  create(session: AgentSession, protocolVersion: 1 | 2 = 1): void {
    this.sessions.set(session.id, session);
    this.protocolVersions.set(session.id, protocolVersion);
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  update(id: string, session: AgentSession): void {
    this.sessions.set(id, session);
  }

  delete(id: string): void {
    this.sessions.delete(id);
    this.protocolVersions.delete(id);
  }

  list(): AgentSession[] {
    return [...this.sessions.values()];
  }

  protocolVersionOf(id: string): 1 | 2 | undefined {
    return this.protocolVersions.get(id);
  }
}

export const SESSION_STORE_SCHEMA_VERSION = 1 as const;
export const SESSION_RESTART_INTERRUPTION_ERROR =
  'daemon restarted before the session completed' as const;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MANIFEST_FILE = 'manifest.json';
const RECORDS_DIRECTORY = 'records';
const QUARANTINE_DIRECTORY = 'quarantine';

interface SessionStoreManifestV0 {
  schemaVersion: 0;
}

interface SessionStoreManifestV1 {
  schemaVersion: typeof SESSION_STORE_SCHEMA_VERSION;
}

interface StoredSessionV0 {
  protocolVersion?: 1 | 2;
  session: AgentSession;
}

type PersistedAgentSessionV1 = Omit<AgentSession, 'prompt' | 'error'>;

interface StoredSessionV1 {
  schemaVersion: typeof SESSION_STORE_SCHEMA_VERSION;
  protocolVersion?: 1 | 2;
  session: PersistedAgentSessionV1;
}

interface LoadedSessionRecord extends StoredSessionV0 {
  needsMigration: boolean;
}

interface PreflightSessionRecord {
  path: string;
  loaded?: LoadedSessionRecord;
  quarantineReason?: string;
}

interface PreflightManifest {
  action: SessionStoreManifestAction;
  quarantineReason?: string;
}

export interface QuarantinedSessionStoreFile {
  originalPath: string;
  quarantinePath: string;
  reason: string;
  bytes: number;
}

export type SessionStoreManifestAction = 'none' | 'created' | 'migrated' | 'rebuilt';

export interface SessionStoreRecoveryReport {
  schemaVersion: typeof SESSION_STORE_SCHEMA_VERSION;
  manifestAction: SessionStoreManifestAction;
  loadedSessionCount: number;
  migratedRecordCount: number;
  interruptedSessionIds: string[];
  quarantinedFiles: QuarantinedSessionStoreFile[];
}

export interface FileSessionStoreOptions {
  /** Test seam; production uses the current UTC timestamp. */
  now?: () => string;
}

/**
 * Thrown instead of rewriting data created by a newer AgentDock build. Unknown future versions are
 * not corruption and must remain untouched so rollback/mixed-version operation is safe.
 */
export class UnsupportedSessionStoreVersionError extends Error {
  constructor(
    readonly version: number,
    readonly path: string,
  ) {
    super(`session store schema version ${version} is newer than supported version 1`);
    this.name = 'UnsupportedSessionStoreVersionError';
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

// Node exposes POSIX mode enforcement but not an equivalent Windows ACL API. On Windows these
// chmod calls are best-effort and the daemon's per-user state-root ACL remains the security bound.
function ensurePrivateDirectory(path: string): void {
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory()) {
      throw new Error(`session store path is not a directory: ${path}`);
    }
  } else {
    mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
  }
  try {
    chmodSync(path, DIRECTORY_MODE);
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'ENOSYS'].includes(errorCode(error) ?? '')) {
      throw error;
    }
  }
}

function ensurePrivateFile(path: string): void {
  try {
    chmodSync(path, FILE_MODE);
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'ENOSYS'].includes(errorCode(error) ?? '')) {
      throw error;
    }
  }
}

// Some Windows filesystems reject opening/fsyncing directories. Record and manifest files are
// still fsynced before atomic rename; directory fsync is required everywhere Node supports it.
function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
  } catch (error) {
    const code = errorCode(error);
    if (
      process.platform !== 'win32' ||
      !['EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(code ?? '')
    ) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let renamed = false;
  try {
    descriptor = openSync(temporaryPath, 'wx', FILE_MODE);
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    ensurePrivateFile(temporaryPath);
    renameSync(temporaryPath, path);
    renamed = true;
    ensurePrivateFile(path);
    syncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!renamed && existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Keep the original write error; startup quarantines interrupted temporary files.
      }
    }
  }
}

function parseProtocolVersion(value: unknown): 1 | 2 | undefined {
  if (value === undefined) return undefined;
  if (value === 1 || value === 2) return value;
  throw new Error('invalid session protocol version');
}

function parseSession(value: unknown): AgentSession {
  const parsed = agentSessionSchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid session record');
  return parsed.data;
}

const persistedAgentSessionV1Schema = agentSessionSchema
  .omit({ prompt: true, error: true })
  .strict();

function parsePersistedSessionV1(value: unknown): AgentSession {
  const parsed = persistedAgentSessionV1Schema.safeParse(value);
  if (!parsed.success) throw new Error('invalid persisted session metadata');
  return { ...parsed.data, prompt: '' };
}

function redactSessionForPersistence(session: AgentSession): PersistedAgentSessionV1 {
  const { prompt, error, ...metadata } = session;
  void prompt;
  void error;
  const parsed = persistedAgentSessionV1Schema.safeParse(metadata);
  if (!parsed.success) throw new Error('invalid persisted session metadata');
  return parsed.data;
}

function parseLegacySession(value: unknown): AgentSession {
  const session = parseSession(value);
  return { ...session, prompt: '' };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertTemporarySchemaSupported(path: string): void {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (
      isObject(value) &&
      typeof value.schemaVersion === 'number' &&
      value.schemaVersion > SESSION_STORE_SCHEMA_VERSION
    ) {
      throw new UnsupportedSessionStoreVersionError(value.schemaVersion, path);
    }
  } catch (error) {
    if (error instanceof UnsupportedSessionStoreVersionError) throw error;
    // Torn/invalid temporary files are ordinary interrupted writes and are quarantined later.
  }
}

function parseStoredSession(value: unknown, path: string): LoadedSessionRecord {
  if (!isObject(value)) throw new Error('invalid session file');
  const version = value.schemaVersion;
  if (typeof version === 'number' && version > SESSION_STORE_SCHEMA_VERSION) {
    throw new UnsupportedSessionStoreVersionError(version, path);
  }
  if (version === SESSION_STORE_SCHEMA_VERSION) {
    return {
      session: parsePersistedSessionV1(value.session),
      protocolVersion: parseProtocolVersion(value.protocolVersion),
      needsMigration: false,
    };
  }
  if (version !== undefined && version !== 0) throw new Error('invalid session schema version');

  // Manifest v0 used an unversioned wrapper. Accepting a raw AgentSession as well makes recovery
  // tolerant of the earliest prototype while still rewriting it immediately to the v1 wrapper.
  if ('session' in value) {
    return {
      session: parseLegacySession(value.session),
      protocolVersion: parseProtocolVersion(value.protocolVersion) ?? 1,
      needsMigration: true,
    };
  }
  return {
    session: parseLegacySession(value),
    protocolVersion: parseProtocolVersion(value.protocolVersion) ?? 1,
    needsMigration: true,
  };
}

function recordFileName(id: string): string {
  const parsed = agentSessionSchema.shape.id.safeParse(id);
  if (!parsed.success) throw new Error('session id must be a UUID');
  return `${parsed.data}.json`;
}

/**
 * Synchronous, crash-safe filesystem implementation for base session metadata.
 *
 * `directory` is the store-owned state subdirectory (for example `<state>/sessions-v1`). Event
 * history, lineage, retention and continuation locks intentionally belong to the execution graph
 * store rather than this compatibility layer.
 */
export class FileSessionStore implements SessionStore {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly protocolVersions = new Map<string, 1 | 2>();
  private readonly recordsDirectory: string;
  private readonly quarantineDirectory: string;
  private readonly manifestPath: string;
  private readonly now: () => string;
  private report: SessionStoreRecoveryReport = {
    schemaVersion: SESSION_STORE_SCHEMA_VERSION,
    manifestAction: 'none',
    loadedSessionCount: 0,
    migratedRecordCount: 0,
    interruptedSessionIds: [],
    quarantinedFiles: [],
  };

  constructor(
    readonly directory: string,
    options: FileSessionStoreOptions = {},
  ) {
    this.recordsDirectory = join(directory, RECORDS_DIRECTORY);
    this.quarantineDirectory = join(directory, QUARANTINE_DIRECTORY);
    this.manifestPath = join(directory, MANIFEST_FILE);
    this.now = options.now ?? (() => new Date().toISOString());
    this.load();
  }

  create(session: AgentSession, protocolVersion: 1 | 2 = 1): void {
    parseSession(session);
    this.persist(session, protocolVersion);
    this.sessions.set(session.id, session);
    this.protocolVersions.set(session.id, protocolVersion);
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  update(id: string, session: AgentSession): void {
    parseSession(session);
    if (session.id !== id) throw new Error('session update id does not match record id');
    if (!this.sessions.has(id)) throw new Error(`cannot update unknown session: ${id}`);
    const protocolVersion = this.protocolVersions.get(id);
    if (protocolVersion === undefined) {
      throw new Error(`session protocol version is missing: ${id}`);
    }
    this.persist(session, protocolVersion);
    this.sessions.set(id, session);
  }

  delete(id: string): void {
    let fileName: string;
    try {
      fileName = recordFileName(id);
    } catch {
      this.sessions.delete(id);
      this.protocolVersions.delete(id);
      return;
    }
    const path = join(this.recordsDirectory, fileName);
    try {
      unlinkSync(path);
      syncDirectory(this.recordsDirectory);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    this.sessions.delete(id);
    this.protocolVersions.delete(id);
  }

  list(): AgentSession[] {
    return [...this.sessions.values()];
  }

  protocolVersionOf(id: string): 1 | 2 | undefined {
    return this.protocolVersions.get(id);
  }

  getRecoveryReport(): SessionStoreRecoveryReport {
    return {
      ...this.report,
      interruptedSessionIds: [...this.report.interruptedSessionIds],
      quarantinedFiles: this.report.quarantinedFiles.map((entry) => ({ ...entry })),
    };
  }

  private persist(session: AgentSession, protocolVersion: 1 | 2 | undefined): void {
    const record: StoredSessionV1 = {
      schemaVersion: SESSION_STORE_SCHEMA_VERSION,
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
      session: redactSessionForPersistence(session),
    };
    atomicWriteJson(join(this.recordsDirectory, recordFileName(session.id)), record);
  }

  private load(): void {
    ensurePrivateDirectory(this.directory);
    ensurePrivateDirectory(this.recordsDirectory);
    ensurePrivateDirectory(this.quarantineDirectory);

    // Complete a read-only pass first. In particular, an older daemon must discover a record from
    // a future schema before it quarantines corruption, upgrades v0 data, or recovers an active
    // session. That leaves the entire store available to the newer daemon exactly as it found it.
    const rootTemporaryPaths = this.preflightRootTemporaryFiles();
    const manifest = this.preflightManifest();
    const records = this.preflightRecords();
    for (const path of rootTemporaryPaths) this.quarantine(path, 'interrupted atomic write');
    if (manifest.quarantineReason !== undefined) {
      this.quarantine(this.manifestPath, manifest.quarantineReason);
    } else if (manifest.action === 'none') {
      ensurePrivateFile(this.manifestPath);
    }

    let migratedRecordCount = 0;
    const interruptedSessionIds: string[] = [];

    for (const record of records) {
      if (record.quarantineReason !== undefined) {
        this.quarantine(record.path, record.quarantineReason);
        continue;
      }
      const loaded = record.loaded;
      if (loaded === undefined) throw new Error('invalid session preflight result');
      let session = loaded.session;
      let needsWrite = loaded.needsMigration;
      if (session.status === 'starting' || session.status === 'running') {
        session = {
          ...session,
          status: 'failed',
          completedAt: this.now(),
          error: SESSION_RESTART_INTERRUPTION_ERROR,
        };
        interruptedSessionIds.push(session.id);
        needsWrite = true;
      }
      if (needsWrite) {
        this.persist(session, loaded.protocolVersion);
        if (loaded.needsMigration) migratedRecordCount += 1;
      } else {
        ensurePrivateFile(record.path);
      }
      this.sessions.set(session.id, session);
      if (loaded.protocolVersion !== undefined) {
        this.protocolVersions.set(session.id, loaded.protocolVersion);
      }
    }

    // The v1 manifest is written last. If migration is interrupted, a retry sees v0 plus a safe
    // mixture of already-upgraded and legacy record files and repeats without data loss.
    if (manifest.action !== 'none') {
      const manifest: SessionStoreManifestV1 = { schemaVersion: SESSION_STORE_SCHEMA_VERSION };
      atomicWriteJson(this.manifestPath, manifest);
    }

    this.report = {
      schemaVersion: SESSION_STORE_SCHEMA_VERSION,
      manifestAction: manifest.action,
      loadedSessionCount: this.sessions.size,
      migratedRecordCount,
      interruptedSessionIds,
      quarantinedFiles: this.report.quarantinedFiles,
    };
  }

  private preflightRootTemporaryFiles(): string[] {
    const paths = readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\.manifest\.json\..+\.tmp$/.test(entry.name))
      .map((entry) => join(this.directory, entry.name));
    for (const path of paths) assertTemporarySchemaSupported(path);
    return paths;
  }

  private preflightRecords(): PreflightSessionRecord[] {
    const records: PreflightSessionRecord[] = [];
    let unsupportedVersion: UnsupportedSessionStoreVersionError | undefined;
    for (const entry of readdirSync(this.recordsDirectory, { withFileTypes: true })) {
      const path = join(this.recordsDirectory, entry.name);
      if (entry.name.endsWith('.tmp')) {
        assertTemporarySchemaSupported(path);
        records.push({ path, quarantineReason: 'interrupted atomic write' });
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;
      try {
        const stat = lstatSync(path);
        if (!stat.isFile()) throw new Error('session path is not a regular file');
        const loaded = parseStoredSession(JSON.parse(readFileSync(path, 'utf8')) as unknown, path);
        if (entry.name !== recordFileName(loaded.session.id)) {
          throw new Error('session file name does not match record id');
        }
        records.push({ path, loaded });
      } catch (error) {
        if (error instanceof UnsupportedSessionStoreVersionError) {
          unsupportedVersion ??= error;
          continue;
        }
        if (errorCode(error) !== undefined) throw error;
        records.push({
          path,
          quarantineReason: error instanceof Error ? error.message : 'invalid session record',
        });
      }
    }
    if (unsupportedVersion !== undefined) throw unsupportedVersion;
    return records;
  }

  private preflightManifest(): PreflightManifest {
    if (!existsSync(this.manifestPath)) return { action: 'created' };
    try {
      const stat = lstatSync(this.manifestPath);
      if (!stat.isFile()) throw new Error('session manifest is not a regular file');
      const parsed = JSON.parse(readFileSync(this.manifestPath, 'utf8')) as unknown;
      if (!isObject(parsed) || typeof parsed.schemaVersion !== 'number') {
        throw new Error('invalid session manifest');
      }
      if (parsed.schemaVersion > SESSION_STORE_SCHEMA_VERSION) {
        throw new UnsupportedSessionStoreVersionError(parsed.schemaVersion, this.manifestPath);
      }
      if (parsed.schemaVersion === 0) {
        void (parsed as unknown as SessionStoreManifestV0);
        return { action: 'migrated' };
      }
      if (parsed.schemaVersion !== SESSION_STORE_SCHEMA_VERSION) {
        throw new Error('invalid session manifest version');
      }
      void (parsed as unknown as SessionStoreManifestV1);
      return { action: 'none' };
    } catch (error) {
      if (error instanceof UnsupportedSessionStoreVersionError) throw error;
      if (errorCode(error) !== undefined) throw error;
      return {
        action: 'rebuilt',
        quarantineReason: error instanceof Error ? error.message : 'invalid session manifest',
      };
    }
  }

  private quarantine(path: string, reason: string): void {
    let bytes = 0;
    let regularFile = false;
    try {
      const stat = lstatSync(path);
      bytes = stat.size;
      regularFile = stat.isFile();
    } catch {
      // A raced-away path has no bytes to report and no content left to preserve.
    }
    ensurePrivateDirectory(this.quarantineDirectory);
    const quarantinePath = join(
      this.quarantineDirectory,
      `${basename(path)}.corrupt-${Date.now()}-${randomUUID()}`,
    );
    renameSync(path, quarantinePath);
    if (regularFile) ensurePrivateFile(quarantinePath);
    syncDirectory(dirname(path));
    syncDirectory(this.quarantineDirectory);
    this.report.quarantinedFiles.push({ originalPath: path, quarantinePath, reason, bytes });
  }
}

export { FileSessionStore as FilesystemSessionStore };
