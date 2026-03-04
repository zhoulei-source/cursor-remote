import pino from 'pino';

let loggerInstance: pino.Logger | null = null;

export function createLogger(level: string = 'info'): pino.Logger {
  loggerInstance = pino({
    level,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    },
  });
  return loggerInstance;
}

export function getLogger(): pino.Logger {
  if (!loggerInstance) {
    return createLogger();
  }
  return loggerInstance;
}
