import pino, { type Logger } from 'pino';

const level = process.env.APP_FACTORY_LOG_LEVEL ?? 'info';

export function createLogger(name: string): Logger {
  return pino({
    name,
    level,
    transport: process.stdout.isTTY
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        }
      : undefined,
  });
}

export type { Logger };
