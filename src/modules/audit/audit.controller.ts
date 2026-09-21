import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../../infrastructure/database/db.service';
import { authenticateToken, requireRoles } from '../../middleware/auth.middleware';

export const auditRouter = Router();

auditRouter.get(
  '/logs',
  authenticateToken,
  requireRoles('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const resLogs = await db.query(
        `SELECT id, user_id, action, resource_type, resource_id, ip_address, user_agent, payload_hash, created_at
         FROM audit_logs
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );
      res.status(200).json({ logs: resLogs.rows, count: resLogs.rowCount });
    } catch (err) {
      next(err);
    }
  }
);
