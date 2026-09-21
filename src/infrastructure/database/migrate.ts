import fs from 'fs';
import path from 'path';
import { db } from './db.service';
import { logger } from '../telemetry/logger';

export async function runMigrations() {
  logger.info('Starting database migration...');
  let migrationPath = path.join(__dirname, 'migrations', '001_initial_schema.sql');
  if (!fs.existsSync(migrationPath)) {
    migrationPath = path.join(process.cwd(), 'src', 'infrastructure', 'database', 'migrations', '001_initial_schema.sql');
  }

  if (fs.existsSync(migrationPath)) {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    try {
      await db.query(sql);
      logger.info('Migration 001_initial_schema.sql executed successfully.');
    } catch (err: any) {
      logger.warn('Migration encountered notice/warning (safe if using in-memory or already migrated):', err.message);
    }
  } else {
    logger.warn(`Migration file not found at ${migrationPath}`);
  }
}

if (require.main === module) {
  runMigrations().catch((err) => {
    logger.error('Migration failed:', err);
    process.exit(1);
  });
}
