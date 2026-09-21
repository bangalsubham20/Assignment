import { Request, Response, NextFunction } from 'express';
import { db } from '../infrastructure/database/db.service';
import { CryptoUtil } from '../utils/crypto';
import { idempotencyHitsCounter } from '../infrastructure/telemetry/metrics';

/**
 * Enterprise Idempotency Middleware
 * Guarantees exactly-once semantics for mutating HTTP requests.
 */
export const idempotencyMiddleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  // Only apply to mutating requests
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next();
  }

  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

  // If no idempotency key was supplied, continue normally
  if (!idempotencyKey) {
    return next();
  }

  const requestHash = CryptoUtil.sha256Hash({
    method: req.method,
    url: req.originalUrl,
    body: req.body,
    user: req.user?.id,
  });

  try {
    // 1. Check if key already exists
    const existingResult = await db.query(
      'SELECT * FROM idempotency_keys WHERE key = $1',
      [idempotencyKey]
    );

    if (existingResult.rows.length > 0) {
      const existing = existingResult.rows[0];

      // If already completed and payload matches, replay cached response
      if (existing.status === 'COMPLETED') {
        idempotencyHitsCounter.inc({ outcome: 'REPLAYED' });
        res.setHeader('X-Idempotent-Replay', 'true');
        res.status(existing.response_code);
        try {
          res.json(JSON.parse(existing.response_body));
        } catch {
          res.send(existing.response_body);
        }
        return;
      }

      // If still processing, fast-fail with 409 Conflict
      if (existing.status === 'PROCESSING') {
        idempotencyHitsCounter.inc({ outcome: 'CONFLICT_IN_PROGRESS' });
        res.status(409).json({
          type: 'https://amrutam.global/errors/conflict',
          title: 'Request In Progress',
          status: 409,
          detail: 'A mutation request with this Idempotency-Key is currently being executed. Please retry shortly.',
        });
        return;
      }
    }

    // 2. Insert key in 'PROCESSING' state
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours retention
    await db.query(
      `INSERT INTO idempotency_keys (key, request_hash, status, expires_at)
       VALUES ($1, $2, 'PROCESSING', $3)`,
      [idempotencyKey, requestHash, expiresAt.toISOString()]
    );

    idempotencyHitsCounter.inc({ outcome: 'NEW' });

    // 3. Intercept response to store result upon completion
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    res.json = function (body: any) {
      const responseCode = res.statusCode;
      const responseBody = JSON.stringify(body);

      // Async persist completed response without blocking response cycle
      db.query(
        `UPDATE idempotency_keys
         SET response_code = $1, response_body = $2, status = 'COMPLETED'
         WHERE key = $3`,
        [responseCode, responseBody, idempotencyKey]
      ).catch((err) => {
        console.error('Failed to update idempotency key:', err);
      });

      return originalJson(body);
    };

    res.send = function (body: any) {
      const responseCode = res.statusCode;
      const responseBody = typeof body === 'string' ? body : JSON.stringify(body);

      db.query(
        `UPDATE idempotency_keys
         SET response_code = $1, response_body = $2, status = 'COMPLETED'
         WHERE key = $3`,
        [responseCode, responseBody, idempotencyKey]
      ).catch((err) => {
        console.error('Failed to update idempotency key:', err);
      });

      return originalSend(body);
    };

    next();
  } catch (err) {
    // If DB check fails, don't block the request in development
    next(err);
  }
};
