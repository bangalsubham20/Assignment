import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { securityEventsCounter } from '../infrastructure/telemetry/metrics';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: 'PATIENT' | 'DOCTOR' | 'ADMIN';
  mfaVerified?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      correlationId?: string;
    }
  }
}

export const authenticateToken = (req: Request, res: Response, next: NextFunction): void => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (!token) {
    securityEventsCounter.inc({ event_type: 'UNAUTHORIZED' });
    res.status(401).json({
      type: 'https://amrutam.global/errors/unauthorized',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication token missing or invalid format',
    });
    return;
  }

  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as AuthenticatedUser;
    req.user = payload;
    next();
  } catch (err: any) {
    securityEventsCounter.inc({ event_type: 'INVALID_TOKEN' });
    res.status(401).json({
      type: 'https://amrutam.global/errors/token-expired',
      title: 'Invalid or Expired Token',
      status: 401,
      detail: err.message || 'The provided access token is invalid or expired',
    });
  }
};

export const requireRoles = (...allowedRoles: Array<'PATIENT' | 'DOCTOR' | 'ADMIN'>) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        type: 'https://amrutam.global/errors/unauthorized',
        title: 'Unauthorized',
        status: 401,
        detail: 'Authentication required for this operation',
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      securityEventsCounter.inc({ event_type: 'FORBIDDEN' });
      res.status(403).json({
        type: 'https://amrutam.global/errors/forbidden',
        title: 'Forbidden',
        status: 403,
        detail: `Access restricted. Your role (${req.user.role}) is not authorized to access this resource.`,
      });
      return;
    }

    next();
  };
};
