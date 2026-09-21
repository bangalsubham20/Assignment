import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { consultationService } from './consultation.service';
import { authenticateToken } from '../../middleware/auth.middleware';
import { idempotencyMiddleware } from '../../middleware/idempotency.middleware';
import { logAuditEvent } from '../../middleware/audit.middleware';

export const consultationRouter = Router();

const bookSchema = z.object({
  doctorId: z.string().uuid(),
  slotId: z.string().uuid(),
  symptoms: z.string().min(3, 'Please describe your symptoms in at least 3 characters'),
});

const verifyPaymentSchema = z.object({
  consultationId: z.string().uuid(),
  paymentId: z.string().optional(),
  status: z.enum(['SUCCESS', 'FAILED']),
});

// Book consultation with Idempotency guard
consultationRouter.post(
  '/book',
  authenticateToken,
  idempotencyMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = bookSchema.parse(req.body);
      const booking = await consultationService.bookSlot({
        patientId: req.user!.id,
        doctorId: validated.doctorId,
        slotId: validated.slotId,
        symptoms: validated.symptoms,
      });

      await logAuditEvent(req, {
        action: 'CONSULTATION_BOOKED',
        resourceType: 'CONSULTATION',
        resourceId: booking.consultationId,
        payload: { slotId: booking.slotId, doctorId: booking.doctorId },
      });

      res.status(201).json(booking);
    } catch (err) {
      next(err);
    }
  }
);

// Payment confirmation
consultationRouter.post(
  '/payments/verify',
  authenticateToken,
  idempotencyMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = verifyPaymentSchema.parse(req.body);
      const result = await consultationService.verifyPayment(validated.consultationId, validated.status);

      await logAuditEvent(req, {
        action: 'PAYMENT_VERIFIED',
        resourceType: 'PAYMENT',
        resourceId: validated.consultationId,
        payload: { status: validated.status },
      });

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// Cancel consultation
consultationRouter.post(
  '/:id/cancel',
  authenticateToken,
  idempotencyMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await consultationService.cancelConsultation(req.params.id, req.user!.id, req.user!.role);

      await logAuditEvent(req, {
        action: 'CONSULTATION_CANCELLED',
        resourceType: 'CONSULTATION',
        resourceId: req.params.id,
      });

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// Get consultation details
consultationRouter.get(
  '/:id',
  authenticateToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const consultation = await consultationService.getConsultationById(req.params.id);
      res.status(200).json(consultation);
    } catch (err) {
      next(err);
    }
  }
);
