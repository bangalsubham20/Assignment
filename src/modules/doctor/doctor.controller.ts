import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { doctorService } from './doctor.service';
import { authenticateToken, requireRoles } from '../../middleware/auth.middleware';
import { logAuditEvent } from '../../middleware/audit.middleware';

export const doctorRouter = Router();

const createSlotsSchema = z.object({
  slots: z.array(
    z.object({
      startTime: z.string().datetime(),
      endTime: z.string().datetime(),
    })
  ).min(1, 'At least one slot is required'),
});

// Doctor profile
doctorRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const doctor = await doctorService.getDoctorProfile(req.params.id);
    res.status(200).json(doctor);
  } catch (err) {
    next(err);
  }
});

// Available slots for a doctor
doctorRouter.get('/:id/slots', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slots = await doctorService.getAvailableSlots(req.params.id);
    res.status(200).json(slots);
  } catch (err) {
    next(err);
  }
});

// Create slots (Doctor only)
doctorRouter.post(
  '/slots',
  authenticateToken,
  requireRoles('DOCTOR'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = createSlotsSchema.parse(req.body);
      const slots = await doctorService.createSlots(req.user!.id, validated.slots);

      await logAuditEvent(req, {
        action: 'DOCTOR_CREATED_SLOTS',
        resourceType: 'AVAILABILITY_SLOT',
        payload: { count: slots.length },
      });

      res.status(201).json({ message: 'Slots created successfully', slots });
    } catch (err) {
      next(err);
    }
  }
);
