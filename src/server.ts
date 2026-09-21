import http from 'http';
import { createApp } from './app';
import { config } from './config/env';
import { logger } from './infrastructure/telemetry/logger';
import { db } from './infrastructure/database/db.service';
import { redisService } from './infrastructure/redis/redis.service';
import { runMigrations } from './infrastructure/database/migrate';
import { runSeed } from './infrastructure/database/seed';

async function bootstrap() {
  const app = createApp();
  const server = http.createServer(app);

  // Initialize DB schema & seed data
  try {
    await runMigrations();
    await runSeed();
  } catch (err: any) {
    logger.warn('Bootstrap database setup notice:', err.message);
  }

  const serverPort = config.PORT;
  server.listen(serverPort, () => {
    logger.info(`=======================================================`);
    logger.info(`🚀 Amrutam Telemedicine Backend running on port ${serverPort}`);
    logger.info(`📚 Swagger Documentation: http://localhost:${serverPort}/api/docs`);
    logger.info(`📊 Prometheus Metrics:   http://localhost:${serverPort}/metrics`);
    logger.info(`🩺 Health Readiness:     http://localhost:${serverPort}/health/ready`);
    logger.info(`=======================================================`);
  });

  // Graceful Shutdown
  const gracefulShutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);
    server.close(async () => {
      logger.info('HTTP server closed.');
      try {
        await db.close();
        await redisService.close();
        logger.info('Database and Redis connections terminated.');
        process.exit(0);
      } catch (err) {
        logger.error('Error during shutdown:', err);
        process.exit(1);
      }
    });

    // Force close after 10s timeout
    setTimeout(() => {
      logger.error('Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

bootstrap().catch((err) => {
  logger.error('Fatal error during application startup:', err);
  process.exit(1);
});
