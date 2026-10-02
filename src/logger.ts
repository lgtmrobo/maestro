import pino from 'pino';

const logLevel = process.env.MAESTRO_LOG_LEVEL || 'info';

const baseLogger = pino({
  name: 'maestro',
  level: logLevel,
});

export function createLogger(bindings: Record<string, unknown> = {}): pino.Logger {
  return baseLogger.child(bindings);
}

export type Logger = pino.Logger;
