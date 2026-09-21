import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authService } from './auth.service';
import { authenticateToken } from '../../middleware/auth.middleware';
import { logAuditEvent } from '../../middleware/audit.middleware';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(['PATIENT', 'DOCTOR', 'ADMIN']),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
  specialty: z.string().optional(),
  experienceYears: z.number().int().nonnegative().optional(),
  consultationFee: z.number().nonnegative().optional(),
  bio: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totpCode: z.string().optional(),
});

authRouter.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validated = registerSchema.parse(req.body);
    const result = await authService.register(validated);

    await logAuditEvent(req, {
      action: 'USER_REGISTERED',
      resourceType: 'USER',
      resourceId: result.user.id,
      payload: { email: result.user.email, role: result.user.role },
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validated = loginSchema.parse(req.body);
    const result = await authService.login(validated);

    if (result.user) {
      await logAuditEvent(req, {
        action: 'USER_LOGIN_SUCCESS',
        resourceType: 'USER',
        resourceId: result.user.id,
      });
    }

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/mfa/setup', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await authService.setupMFA(req.user!.id);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/mfa/verify', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = z.object({ token: z.string().length(6) }).parse(req.body);
    const result = await authService.verifyMFA(req.user!.id, token);

    await logAuditEvent(req, {
      action: 'MFA_ACTIVATED',
      resourceType: 'USER',
      resourceId: req.user!.id,
    });

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
    const result = await authService.refreshToken(refreshToken);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
