import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prescriptionService } from './prescription.service';
import { authenticateToken, requireRoles } from '../../middleware/auth.middleware';
import { idempotencyMiddleware } from '../../middleware/idempotency.middleware';
import { logAuditEvent } from '../../middleware/audit.middleware';

export const prescriptionRouter = Router();

const createPrescriptionSchema = z.object({
  consultationId: z.string().uuid(),
  medicalNotes: z.string().min(5, 'Medical notes are required'),
  medications: z.array(
    z.object({
      name: z.string().min(1),
      dosage: z.string().min(1),
      frequency: z.string().min(1),
      days: z.number().int().positive(),
    })
  ).min(1, 'At least one medication is required'),
});

// Issue prescription (Doctors only, Idempotent)
prescriptionRouter.post(
  '/',
  authenticateToken,
  requireRoles('DOCTOR'),
  idempotencyMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = createPrescriptionSchema.parse(req.body);
      const result = await prescriptionService.issuePrescription({
        consultationId: validated.consultationId,
        doctorId: req.user!.id,
        medicalNotes: validated.medicalNotes,
        medications: validated.medications,
      });

      await logAuditEvent(req, {
        action: 'PRESCRIPTION_ISSUED',
        resourceType: 'PRESCRIPTION',
        resourceId: result.prescriptionId,
        payload: { consultationId: validated.consultationId },
      });

      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// View decrypted prescription (Patient, Doctor, Admin)
prescriptionRouter.get(
  '/:consultationId',
  authenticateToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prescription = await prescriptionService.getPrescription(
        req.params.consultationId,
        req.user!.id,
        req.user!.role
      );

      await logAuditEvent(req, {
        action: 'PRESCRIPTION_ACCESSED_AND_DECRYPTED',
        resourceType: 'PRESCRIPTION',
        resourceId: prescription.prescriptionId,
      });

      res.status(200).json(prescription);
    } catch (err) {
      next(err);
    }
  }
);
