import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('4000').transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PREFIX: z.string().default('/api/v1'),

  // PostgreSQL
  DATABASE_URL: z.string().optional(),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.string().default('5432').transform((val) => parseInt(val, 10)),
  DB_USER: z.string().default('amrutam_admin'),
  DB_PASSWORD: z.string().default('postgres_dev_password'),
  DB_NAME: z.string().default('amrutam_telemedicine'),
  DB_POOL_MIN: z.string().default('5').transform((val) => parseInt(val, 10)),
  DB_POOL_MAX: z.string().default('25').transform((val) => parseInt(val, 10)),

  // Redis
  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().default('6379').transform((val) => parseInt(val, 10)),
  REDIS_PASSWORD: z.string().optional(),

  // Security (Require strong keys)
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRATION: z.string().default('15m'),
  JWT_REFRESH_EXPIRATION: z.string().default('7d'),

  // Field Level Encryption (AES-256-GCM)
  ENCRYPTION_MASTER_KEY: z.string().length(64, 'ENCRYPTION_MASTER_KEY must be 64-char hex (32 bytes)'),
  ENCRYPTION_KEY_ID: z.string().default('kms-v1'),

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: z.string().default('60000').transform((val) => parseInt(val, 10)),
  RATE_LIMIT_MAX: z.string().default('100').transform((val) => parseInt(val, 10)),

  // Observability
  LOG_LEVEL: z.string().default('info'),
});

// Provide ephemeral fallbacks strictly during non-production test execution if missing
if (process.env.NODE_ENV === 'test') {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_strictly_for_local_testing_min32chars!';
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test_refresh_jwt_secret_strictly_for_testing!';
  process.env.ENCRYPTION_MASTER_KEY = process.env.ENCRYPTION_MASTER_KEY || '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Environment configuration validation failed:');
  console.error(JSON.stringify(parsed.error.format(), null, 2));
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
}

export const config = envSchema.parse(process.env);
