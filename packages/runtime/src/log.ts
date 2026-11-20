type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Any local@domain, dotted or not (a provider may echo an address cut short or on a local host). */
const EMAIL = /[^\s"'<>@]+@[^\s"'<>@]+/g;
/** v1 tokens and v2 links (@swarm/tokens): `v<n>.<purpose>.<kid>.<payload>.<signature>`. */
const TOKEN = /\bv[12]\.[a-z0-9-]+\.[a-z0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
/** Anthropic API keys (Copilot): a workspace's own key must never reach a log line. */
const MODEL_KEY = /\bsk-ant-[A-Za-z0-9_-]+/g;

/** Strips emails, signed tokens and model API keys from anything that is about to be logged. */
export function redact(value: string): string {
  return value.replace(TOKEN, '[token]').replace(MODEL_KEY, '[key]').replace(EMAIL, '[email]');
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** JSON lines, one object per event, with PII redacted. */
export function createLogger(base: Record<string, unknown>): Logger {
  const write = (level: LogLevel, message: string, fields: Record<string, unknown> = {}) => {
    const line = redact(
      JSON.stringify({ level, message, ...base, ...fields, time: new Date().toISOString() }),
    );
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
