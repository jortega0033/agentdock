const PLACEHOLDER_KEY = '$fixturePlaceholder';

const PLACEHOLDER_KINDS = new Set([
  'prompt',
  'working_directory',
  'path',
  'environment',
  'credential',
  'reasoning',
  'tool_input',
  'tool_result',
  'free_text',
]);

const TAGGED_REDACTION_KINDS = new Map([
  ['<redacted:prompt>', 'prompt'],
  ['<redacted:cwd>', 'working_directory'],
  ['<redacted:provider-session-id>', 'free_text'],
  ['<redacted:assistant-content>', 'free_text'],
  ['<redacted:tool-action>', 'free_text'],
  ['<redacted:tool-target>', 'free_text'],
  ['<redacted:tool-result>', 'tool_result'],
  ['<redacted:question>', 'prompt'],
  ['<redacted:answer>', 'free_text'],
]);

const REDACTION_SYNTAX = /<\s*redacted\b[^<>]*>/i;

const literalArg = (value) => ({ literal: value });
const operandArg = (kind) => ({ operand: kind });
const NATIVE_ARGV_GRAMMARS = [
  [
    literalArg('-p'),
    literalArg('--input-format'),
    literalArg('text'),
    literalArg('--output-format'),
    literalArg('stream-json'),
    literalArg('--verbose'),
    literalArg('--session-id'),
    operandArg('session_id'),
  ],
  [
    literalArg('-p'),
    literalArg('--input-format'),
    literalArg('text'),
    literalArg('--output-format'),
    literalArg('stream-json'),
    literalArg('--verbose'),
    literalArg('--resume'),
    operandArg('provider_session_id'),
  ],
  [
    literalArg('exec'),
    operandArg('prompt'),
    literalArg('--json'),
    literalArg('--skip-git-repo-check'),
  ],
  [
    literalArg('exec'),
    literalArg('resume'),
    operandArg('provider_session_id'),
    operandArg('prompt'),
    literalArg('--json'),
    literalArg('--skip-git-repo-check'),
  ],
];

const WORKING_DIRECTORY_KEYS = new Set(['cwd', 'working_directory', 'workdir']);
const PATH_KEYS = new Set([
  'path',
  'directory',
  'file_path',
  'filepath',
  'home_directory',
  'root_directory',
  'workspace_root',
  'worktree',
]);
const TOOL_INPUT_KEYS = new Set(['args', 'arguments', 'command', 'input', 'tool_input']);
const TOOL_RESULT_KEYS = new Set([
  'aggregated_output',
  'diff',
  'output',
  'patch',
  'result',
  'stderr',
  'stdout',
  'tool_output',
  'tool_result',
]);
const FREE_TEXT_KEYS = new Set([
  'action',
  'answer',
  'body',
  'completion',
  'content',
  'data',
  'description',
  'detail',
  'details',
  'error',
  'label',
  'message',
  'note',
  'payload',
  'question',
  'query',
  'reason',
  'response',
  'safe_summary',
  'summary',
  'target',
  'text',
  'title',
  'value',
]);
const CONTEXT_PAYLOAD_KEYS = new Set([
  ...TOOL_INPUT_KEYS,
  ...TOOL_RESULT_KEYS,
  ...FREE_TEXT_KEYS,
  'changes',
]);
const USAGE_TOKEN_COUNTER_KEYS = new Set([
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'cached_input_tokens',
  'cached_output_tokens',
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'total_tokens',
]);
const SENSITIVE_CONTEXT_STRUCTURAL_KEYS = new Set([
  'type',
  'kind',
  'subtype',
  'id',
  'name',
  'tool',
  'tool_name',
  'tool_call_id',
  'tool_use_id',
  'content_block_id',
  'request_id',
  'turn_id',
  'session_id',
  'thread_id',
  'status',
  'is_error',
  'exit_code',
  'possible_effects',
  'effects_complete',
  'item',
  'message',
]);

const SECRET_PATTERNS = [
  {
    code: 'api_key_prefix',
    pattern:
      /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/i,
  },
  {
    code: 'authorization_value',
    pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  },
  {
    code: 'private_key',
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i,
  },
  {
    code: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  },
  {
    code: 'credential_assignment',
    pattern:
      /\b(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PASSWORD|PRIVATE[_-]?KEY|REFRESH[_-]?TOKEN|SECRET)\s*[=:]\s*[^\s,;]{4,}/i,
  },
  {
    code: 'url_credentials',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  },
  {
    code: 'windows_home_path',
    pattern: /\b[A-Z]:[\\/]Users[\\/][^\\/\s]+/i,
  },
  {
    code: 'unix_home_path',
    pattern: /(?:^|[\s"'=])(?:\/(?:home|Users)\/[^/\s]+|\/root(?:\/|$))/,
  },
  {
    code: 'tilde_home_path',
    pattern: /(?:^|[\s"'=])~[\\/]/,
  },
  {
    code: 'home_variable',
    pattern: /(?:%USERPROFILE%|\$\{?(?:HOME|USERPROFILE)\}?)/i,
  },
];

function normalizeKey(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function keyParts(normalizedKey) {
  return normalizedKey.split('_').filter(Boolean);
}

function placeholder(kind) {
  return { [PLACEHOLDER_KEY]: kind };
}

function placeholderKind(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length !== 1 || entries[0]?.[0] !== PLACEHOLDER_KEY) return undefined;
  const kind = entries[0][1];
  return typeof kind === 'string' && PLACEHOLDER_KINDS.has(kind) ? kind : undefined;
}

function taggedRedactionKind(value) {
  return typeof value === 'string' ? TAGGED_REDACTION_KINDS.get(value) : undefined;
}

function hasRedactionSyntax(value) {
  return typeof value === 'string' && REDACTION_SYNTAX.test(value);
}

function nativeArgvGrammar(value) {
  if (!Array.isArray(value)) return undefined;
  return NATIVE_ARGV_GRAMMARS.find(
    (grammar) =>
      grammar.length === value.length &&
      grammar.every((slot, index) => !slot.literal || value[index] === slot.literal),
  );
}

function approvedNativeOperand(value, kind) {
  const placeholder = placeholderKind(value);
  if (kind === 'prompt') {
    return placeholder === 'prompt' || value === '<redacted:prompt>';
  }
  if (kind === 'session_id') {
    return placeholder === 'free_text' || value === '<session-id>';
  }
  return placeholder === 'free_text' || value === '<redacted:provider-session-id>';
}

function isContainer(value) {
  return value !== null && typeof value === 'object';
}

function contextForObject(value, inheritedContext) {
  const discriminator =
    typeof value.type === 'string'
      ? value.type.toLowerCase()
      : typeof value.kind === 'string'
        ? value.kind.toLowerCase()
        : '';

  if (
    discriminator.includes('tool_result') ||
    discriminator === 'tool.completed' ||
    discriminator === 'item.completed'
  ) {
    return 'tool_result';
  }
  if (
    discriminator.includes('tool_use') ||
    discriminator === 'tool.started' ||
    discriminator === 'item.started'
  ) {
    return 'tool_input';
  }
  if (
    discriminator.includes('reasoning') ||
    discriminator.includes('thinking') ||
    discriminator.includes('chain_of_thought')
  ) {
    return 'reasoning';
  }
  if (discriminator === 'input.follow_up' || discriminator === 'input.steer') {
    return 'prompt';
  }
  return inheritedContext;
}

function sensitiveKind(key, context, value) {
  const normalized = normalizeKey(key);
  const parts = keyParts(normalized);

  if (
    USAGE_TOKEN_COUNTER_KEYS.has(normalized) &&
    typeof value === 'number' &&
    Number.isFinite(value)
  ) {
    return undefined;
  }
  if (parts.includes('prompt')) return 'prompt';
  if (WORKING_DIRECTORY_KEYS.has(normalized)) return 'working_directory';
  if (PATH_KEYS.has(normalized) || parts.includes('path')) return 'path';
  if (normalized === 'env' || parts.includes('environment') || parts.includes('env')) {
    return 'environment';
  }
  if (
    normalized === 'auth' ||
    normalized === 'authentication' ||
    normalized === 'authorization' ||
    normalized === 'headers' ||
    parts.some((part) => /^(?:cookie|credential|password|secret|token)s?$/.test(part)) ||
    (parts.includes('key') &&
      parts.some((part) =>
        ['access', 'api', 'client', 'private', 'secret', 'session'].includes(part),
      )) ||
    ['access_key', 'api_key', 'apikey', 'client_secret', 'private_key'].includes(normalized)
  ) {
    return 'credential';
  }
  if (
    parts.includes('reasoning') ||
    parts.includes('thinking') ||
    normalized === 'chain_of_thought'
  ) {
    return 'reasoning';
  }
  if (context === 'reasoning' && CONTEXT_PAYLOAD_KEYS.has(normalized)) return 'reasoning';
  if (TOOL_RESULT_KEYS.has(normalized)) return 'tool_result';
  if (
    TOOL_INPUT_KEYS.has(normalized) &&
    !(
      normalized === 'command' &&
      isContainer(value) &&
      !Array.isArray(value) &&
      typeof value.type === 'string'
    )
  ) {
    return 'tool_input';
  }
  if (context === 'tool_result' && CONTEXT_PAYLOAD_KEYS.has(normalized)) {
    return 'tool_result';
  }
  if (context === 'tool_input' && CONTEXT_PAYLOAD_KEYS.has(normalized)) return 'tool_input';
  if (context === 'prompt' && FREE_TEXT_KEYS.has(normalized)) {
    return isContainer(value) ? undefined : 'prompt';
  }
  if (FREE_TEXT_KEYS.has(normalized)) return 'free_text';
  if (
    (context === 'tool_input' || context === 'tool_result' || context === 'reasoning') &&
    !SENSITIVE_CONTEXT_STRUCTURAL_KEYS.has(normalized)
  ) {
    return context;
  }
  return undefined;
}

function secretPatternCodes(value) {
  return SECRET_PATTERNS.filter(({ pattern }) => pattern.test(value)).map(({ code }) => code);
}

function childPath(parent, key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function assertJsonPrimitive(value, path) {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`fixture contains a non-finite number at ${path}`);
  }
  if (['bigint', 'function', 'symbol', 'undefined'].includes(typeof value)) {
    throw new TypeError(`fixture contains a non-JSON value at ${path}`);
  }
}

/**
 * Returns a deep, JSON-compatible copy with every sensitive payload replaced structurally.
 * Placeholder values contain only a redaction category; no fragment, hash, or length derived
 * from the original value is retained.
 */
export function sanitizeFixture(fixture) {
  const active = new WeakSet();

  function sanitizeNativeArgv(value, path) {
    assertJsonPrimitive(value, path);
    if (!Array.isArray(value)) return [placeholder('free_text')];
    const grammar = nativeArgvGrammar(value);
    if (!grammar) return value.map(() => placeholder('free_text'));
    return value.map((argument, index) => {
      const argumentPath = `${path}[${index}]`;
      assertJsonPrimitive(argument, argumentPath);
      const slot = grammar[index];
      if (slot.literal) return slot.literal;
      if (approvedNativeOperand(argument, slot.operand)) {
        return isContainer(argument) ? { ...argument } : argument;
      }
      return placeholder(slot.operand === 'prompt' ? 'prompt' : 'free_text');
    });
  }

  function sanitize(value, path, inheritedContext) {
    assertJsonPrimitive(value, path);
    if (!isContainer(value)) return value;
    if (placeholderKind(value)) return { ...value };
    if (active.has(value)) throw new TypeError(`fixture contains a cycle at ${path}`);
    active.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((entry, index) =>
          inheritedContext === 'free_text_container' && typeof entry === 'string'
            ? placeholder('free_text')
            : sanitize(entry, `${path}[${index}]`, inheritedContext),
        );
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`fixture contains a non-plain object at ${path}`);
      }
      const context = contextForObject(value, inheritedContext);
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => {
          const entryPath = childPath(path, key);
          const normalizedKey = normalizeKey(key);
          if (context === 'native_input' && normalizedKey === 'argv') {
            return [key, sanitizeNativeArgv(entry, entryPath)];
          }
          if (context === 'native_input' && normalizedKey === 'stdin') {
            assertJsonPrimitive(entry, entryPath);
            return [key, entry === null ? null : placeholder('prompt')];
          }
          const kind = sensitiveKind(key, context, entry);
          if (kind && (kind !== 'free_text' || !isContainer(entry))) {
            return [key, placeholder(kind)];
          }
          return [
            key,
            sanitize(
              entry,
              entryPath,
              normalizedKey === 'native_input'
                ? 'native_input'
                : kind === 'free_text' && Array.isArray(entry)
                  ? 'free_text_container'
                  : context,
            ),
          ];
        }),
      );
    } finally {
      active.delete(value);
    }
  }

  return sanitize(fixture, '$', undefined);
}

/**
 * Scans a fixture without echoing suspect values. Findings contain only a stable code and path.
 */
export function scanFixtureForSecrets(fixture) {
  const findings = [];
  const active = new WeakSet();

  function add(code, path) {
    findings.push({ code, path });
  }

  function scanNativeArgv(value, path) {
    const grammar = nativeArgvGrammar(value);
    if (!grammar) {
      add('invalid_native_argv', path);
      return;
    }
    value.forEach((argument, index) => {
      const slot = grammar[index];
      if (slot.literal || approvedNativeOperand(argument, slot.operand)) return;
      const argumentPath = `${path}[${index}]`;
      if (hasRedactionSyntax(argument)) {
        add(
          taggedRedactionKind(argument) ? 'placeholder_kind_mismatch' : 'invalid_redaction_tag',
          argumentPath,
        );
      } else if (
        isContainer(argument) &&
        Object.prototype.hasOwnProperty.call(argument, PLACEHOLDER_KEY)
      ) {
        add(
          placeholderKind(argument) ? 'placeholder_kind_mismatch' : 'invalid_placeholder',
          argumentPath,
        );
      } else {
        add('sensitive_value', argumentPath);
      }
    });
  }

  function scanNativeStdin(value, path) {
    if (value === null || placeholderKind(value) === 'prompt' || value === '<redacted:prompt>') {
      return;
    }
    if (hasRedactionSyntax(value) && !taggedRedactionKind(value)) {
      add('invalid_redaction_tag', path);
      return;
    }
    if (placeholderKind(value) || taggedRedactionKind(value)) {
      add('placeholder_kind_mismatch', path);
      return;
    }
    if (isContainer(value) && Object.prototype.hasOwnProperty.call(value, PLACEHOLDER_KEY)) {
      add('invalid_placeholder', path);
      return;
    }
    add('sensitive_value', path);
  }

  function scan(value, path, inheritedContext) {
    if (typeof value === 'string') {
      if (hasRedactionSyntax(value) && !taggedRedactionKind(value)) {
        add('invalid_redaction_tag', path);
      }
      for (const code of secretPatternCodes(value)) add(code, path);
      return;
    }
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) add('non_json_value', path);
      return;
    }
    if (typeof value !== 'object') {
      add('non_json_value', path);
      return;
    }

    const existingPlaceholder = placeholderKind(value);
    if (existingPlaceholder) return;
    if (Object.prototype.hasOwnProperty.call(value, PLACEHOLDER_KEY)) {
      add('invalid_placeholder', path);
      return;
    }
    if (active.has(value)) {
      add('cyclic_value', path);
      return;
    }
    active.add(value);
    try {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => {
          const entryPath = `${path}[${index}]`;
          if (inheritedContext === 'free_text_container' && typeof entry === 'string') {
            add('sensitive_value', entryPath);
          } else {
            scan(entry, entryPath, inheritedContext);
          }
        });
        return;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        add('non_plain_object', path);
        return;
      }
      const context = contextForObject(value, inheritedContext);
      for (const [key, entry] of Object.entries(value)) {
        const keyFindings = secretPatternCodes(key);
        const entryPath =
          keyFindings.length === 0 ? childPath(path, key) : `${path}["<redacted-key>"]`;
        for (const code of keyFindings) add(code, entryPath);
        const normalizedKey = normalizeKey(key);
        if (context === 'native_input' && normalizedKey === 'argv') {
          scanNativeArgv(entry, entryPath);
          continue;
        }
        if (context === 'native_input' && normalizedKey === 'stdin') {
          scanNativeStdin(entry, entryPath);
          continue;
        }
        const kind = sensitiveKind(key, context, entry);
        const actualPlaceholder = placeholderKind(entry);
        const taggedKind = taggedRedactionKind(entry);
        if (hasRedactionSyntax(entry) && !taggedKind) {
          add('invalid_redaction_tag', entryPath);
          continue;
        }
        if (kind && actualPlaceholder !== kind && taggedKind !== kind) {
          if (actualPlaceholder || taggedKind) {
            add('placeholder_kind_mismatch', entryPath);
            continue;
          }
          if (kind !== 'free_text') {
            add('sensitive_value', entryPath);
            continue;
          }
        }
        scan(
          entry,
          entryPath,
          normalizedKey === 'native_input'
            ? 'native_input'
            : kind === 'free_text' && Array.isArray(entry)
              ? 'free_text_container'
              : context,
        );
      }
    } finally {
      active.delete(value);
    }
  }

  scan(fixture, '$', undefined);
  return findings;
}
