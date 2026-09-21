import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import YAML from 'yamljs';
import swaggerUi from 'swagger-ui-express';
import { v4 as uuidv4 } from 'uuid';

import { config } from './config/env';
import { db } from './infrastructure/database/db.service';
import { redisService } from './infrastructure/redis/redis.service';
import { prometheusRegister, httpRequestDurationHistogram, httpRequestsTotal } from './infrastructure/telemetry/metrics';
import { errorHandler } from './middleware/errorHandler';
import { createRateLimiter } from './middleware/rateLimiter.middleware';

// Import domain routers
import { authRouter } from './modules/auth/auth.controller';
import { doctorRouter } from './modules/doctor/doctor.controller';
import { consultationRouter } from './modules/consultation/consultation.controller';
import { prescriptionRouter } from './modules/prescription/prescription.controller';
import { searchRouter } from './modules/search/search.controller';
import { analyticsRouter } from './modules/analytics/analytics.controller';
import { auditRouter } from './modules/audit/audit.controller';

export function createApp(): express.Application {
  const app = express();

  // 1. Security Headers (Defense in Depth)
  app.use(helmet({
    contentSecurityPolicy: false, // Allows Swagger UI inline assets
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  // 2. Cross-Origin Resource Sharing
  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Correlation-ID'],
    exposedHeaders: ['X-Idempotent-Replay', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
  }));

  // 3. Body Parsers
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // 4. Request Correlation ID & Latency Telemetry Middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
    req.correlationId = correlationId;
    res.setHeader('X-Correlation-ID', correlationId);

    const startTimer = process.hrtime();

    res.on('finish', () => {
      const diff = process.hrtime(startTimer);
      const durationSeconds = diff[0] + diff[1] / 1e9;
      const route = req.route?.path || req.path || 'unknown';
      const statusCode = res.statusCode.toString();

      httpRequestDurationHistogram.observe(
        { method: req.method, route, status_code: statusCode },
        durationSeconds
      );

      httpRequestsTotal.inc({
        method: req.method,
        route,
        status_code: statusCode,
      });
    });

    next();
  });

  // 5. Global Rate Limiter
  app.use(createRateLimiter());

  // 6. Interactive Swagger Documentation UI
  try {
    const openapiPath = path.join(__dirname, '..', 'docs', 'openapi.yaml');
    const swaggerDoc = YAML.load(openapiPath);
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));
  } catch (err) {
    console.warn('Swagger UI could not load openapi.yaml directly:', err);
  }

  // 7. Kubernetes Liveness & Readiness Probes
  app.get('/health/live', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
  });

  app.get('/health/ready', async (_req: Request, res: Response) => {
    const dbHealthy = await db.isHealthy();
    const redisHealthy = await redisService.isHealthy();

    const isReady = dbHealthy && redisHealthy;
    const status = isReady ? 200 : 503;

    res.status(status).json({
      status: isReady ? 'READY' : 'DEGRADED',
      checks: {
        database: dbHealthy ? 'OK' : 'ERROR',
        redis: redisHealthy ? 'OK' : 'ERROR',
      },
      timestamp: new Date().toISOString(),
    });
  });

  // 8. Prometheus Metrics Endpoint
  app.get('/metrics', async (_req: Request, res: Response) => {
    res.setHeader('Content-Type', prometheusRegister.contentType);
    res.send(await prometheusRegister.metrics());
  });

  // 9. Mount API Routers
  const prefix = config.API_PREFIX;
  app.use(`${prefix}/auth`, authRouter);
  app.use(`${prefix}/doctors`, doctorRouter);
  app.use(`${prefix}/consultations`, consultationRouter);
  app.use(`${prefix}/prescriptions`, prescriptionRouter);
  app.use(`${prefix}/search`, searchRouter);
  app.use(`${prefix}/admin/analytics`, analyticsRouter);
  app.use(`${prefix}/audit`, auditRouter);

  // 10. Root Welcome / Quickinfo
  app.get('/', (_req: Request, res: Response) => {
    res.status(200).json({
      name: 'Amrutam Telemedicine Backend API',
      version: '1.0.0',
      status: 'OPERATIONAL',
      documentation: '/api/docs',
      health: '/health/ready',
      metrics: '/metrics',
    });
  });

  // 11. Centralized RFC 7807 Error Handler
  app.use(errorHandler);

  return app;
}
