import winston from 'winston';
import { config } from '../../config/env';

const { combine, timestamp, json, printf, colorize, errors } = winston.format;

const consoleFormat = printf(({ level, message, timestamp, correlationId, ...meta }) => {
  const cid = correlationId ? ` [cid: ${correlationId}]` : '';
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} [${level}]${cid}: ${message}${metaStr}`;
});

export const logger = winston.createLogger({
  level: config.LOG_LEVEL,
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
    json()
  ),
  defaultMeta: { service: 'amrutam-telemedicine-api' },
  transports: [
    new winston.transports.Console({
      format: config.NODE_ENV === 'production'
        ? combine(timestamp(), json())
        : combine(colorize(), timestamp(), consoleFormat),
    }),
  ],
});
