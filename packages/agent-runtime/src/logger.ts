/**
 * Minimal structured logger. Injected everywhere rather than importing a global so tests can
 * assert on log calls and swap in a silent logger. Never pass raw CLI auth/status output or
 * environment variables through `meta` (see SECURITY.md).
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const REDACTED_KEYS = /token|secret|password|authorization|api[-_]?key|credential/i;

function redact(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return meta;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    out[key] = REDACTED_KEYS.test(key) ? '[redacted]' : value;
  }
  return out;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function createConsoleLogger(name: string, minLevel: LogLevel = 'info'): Logger {
  function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const entry = {
      time: new Date().toISOString(),
      level,
      name,
      message,
      ...redact(meta),
    };
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  return {
    debug: (m, meta) => log('debug', m, meta),
    info: (m, meta) => log('info', m, meta),
    warn: (m, meta) => log('warn', m, meta),
    error: (m, meta) => log('error', m, meta),
  };
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
