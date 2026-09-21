import { Request, Response, NextFunction } from 'express';
import { redisService } from '../infrastructure/redis/redis.service';
import { config } from '../config/env';
import { securityEventsCounter } from '../infrastructure/telemetry/metrics';

export const createRateLimiter = (options?: { windowMs?: number; maxRequests?: number }) => {
  const windowMs = options?.windowMs || config.RATE_LIMIT_WINDOW_MS;
  const maxRequests = options?.maxRequests || config.RATE_LIMIT_MAX;
  const windowSeconds = Math.ceil(windowMs / 1000);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Exclude health and metrics from rate limiting
    if (req.path.startsWith('/health') || req.path === '/metrics') {
      return next();
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown-ip';
    const routeKey = req.baseUrl || req.path;
    const key = `ratelimit:${ip}:${routeKey}`;

    try {
      const currentVal = await redisService.get(key);
      const currentCount = currentVal ? parseInt(currentVal, 10) : 0;

      if (currentCount >= maxRequests) {
        securityEventsCounter.inc({ event_type: 'RATE_LIMIT_EXCEEDED' });
        res.setHeader('Retry-After', windowSeconds);
        res.status(429).json({
          type: 'https://amrutam.global/errors/rate-limit-exceeded',
          title: 'Too Many Requests',
          status: 429,
          detail: `Rate limit exceeded. Max ${maxRequests} requests per ${windowSeconds}s window.`,
        });
        return;
      }

      await redisService.set(key, (currentCount + 1).toString(), windowSeconds);
      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - (currentCount + 1)));

      next();
    } catch {
      // Fail-open: allow request if rate-limiter store has hiccup
      next();
    }
  };
};
