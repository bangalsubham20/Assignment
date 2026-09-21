import { Router, Request, Response, NextFunction } from 'express';
import { analyticsService } from './analytics.service';
import { authenticateToken, requireRoles } from '../../middleware/auth.middleware';

export const analyticsRouter = Router();

analyticsRouter.get(
  '/',
  authenticateToken,
  requireRoles('ADMIN'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const analytics = await analyticsService.getPlatformAnalytics();
      res.status(200).json(analytics);
    } catch (err) {
      next(err);
    }
  }
);
