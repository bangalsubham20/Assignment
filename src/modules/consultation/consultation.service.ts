import { db } from '../../infrastructure/database/db.service';
import { lockService } from '../../infrastructure/redis/lock.service';
import { queueService } from '../../jobs/queue.service';
import { consultationsTotalCounter, activeConsultationsGauge, lockContentionCounter } from '../../infrastructure/telemetry/metrics';
import { AppError } from '../../middleware/errorHandler';

export interface BookConsultationDTO {
  patientId: string;
  doctorId: string;
  slotId: string;
  symptoms: string;
}

export class ConsultationService {
  /**
   * Book a consultation slot with Distributed Locking & Optimistic Concurrency Protection
   */
  async bookSlot(data: BookConsultationDTO) {
    const lockResource = `slot:${data.slotId}`;
    // 1. Acquire distributed lock (Redlock) with 4-second TTL
    const lock = await lockService.acquireLock(lockResource, 4000);
    if (!lock) {
      lockContentionCounter.inc({ resource: 'slot_booking' });
      throw new AppError('This slot is currently being processed by another patient. Please select another slot.', 409);
    }

    try {
      // 2. Fetch slot with optimistic version check
      const slotRes = await db.query(
        `SELECT * FROM availability_slots WHERE id = $1`,
        [data.slotId]
      );

      if (slotRes.rows.length === 0) {
        throw new AppError('Availability slot not found', 404);
      }

      const slot = slotRes.rows[0];

      if (slot.status !== 'AVAILABLE') {
        throw new AppError('This slot is no longer available for booking', 400);
      }

      // 3. Atomically lock the slot in DB using optimistic version condition
      const updateRes = await db.query(
        `UPDATE availability_slots
         SET status = 'LOCKED', version = version + 1, locked_at = NOW()
         WHERE id = $1 AND status = 'AVAILABLE' AND version = $2`,
        [data.slotId, slot.version]
      );

      if (updateRes.rowCount === 0) {
        throw new AppError('Slot state changed concurrently. Please retry.', 409);
      }

      // 4. Retrieve doctor fee
      const docRes = await db.query('SELECT consultation_fee FROM doctors WHERE user_id = $1', [data.doctorId]);
      const fee = docRes.rows[0]?.consultation_fee || 500;

      // 5. Create consultation record
      const meetingLink = `https://meet.amrutam.co.in/room/${data.slotId.substring(0, 8)}`;
      const consultRes = await db.query(
        `INSERT INTO consultations (patient_id, doctor_id, slot_id, status, symptoms, meeting_link)
         VALUES ($1, $2, $3, 'PENDING_PAYMENT', $4, $5)`,
        [data.patientId, data.doctorId, data.slotId, data.symptoms, meetingLink]
      );
      const consultation = consultRes.rows[0];

      // 6. Create initial pending payment record
      const payRes = await db.query(
        `INSERT INTO payments (consultation_id, amount, currency, status, transaction_ref)
         VALUES ($1, $2, 'INR', 'PENDING', $3)`,
        [consultation.id, fee, `PAY_INTENT_${Date.now()}`]
      );
      const payment = payRes.rows[0];

      // 7. Enqueue compensation saga job: auto-release slot if unpaid after 15 minutes (900,000 ms)
      await queueService.enqueue('AUTO_RELEASE_EXPIRED_SLOT', {
        slotId: data.slotId,
        consultationId: consultation.id,
      }, 15 * 60 * 1000);

      // Track metric
      consultationsTotalCounter.inc({ status: 'INITIATED' });

      return {
        consultationId: consultation.id,
        status: consultation.status,
        slotId: data.slotId,
        doctorId: data.doctorId,
        patientId: data.patientId,
        amountDue: Number(fee),
        meetingLink: consultation.meeting_link,
        paymentId: payment.id,
        expiresInSeconds: 900,
      };
    } finally {
      // 8. Always release distributed lock
      await lockService.releaseLock(lock);
    }
  }

  /**
   * Complete payment verification and confirm consultation
   */
  async verifyPayment(consultationId: string, paymentStatus: 'SUCCESS' | 'FAILED') {
    const consultRes = await db.query('SELECT * FROM consultations WHERE id = $1', [consultationId]);
    if (consultRes.rows.length === 0) {
      throw new AppError('Consultation not found', 404);
    }
    const consultation = consultRes.rows[0];

    if (paymentStatus === 'SUCCESS') {
      await db.query(`UPDATE payments SET status = 'SUCCESS' WHERE consultation_id = $1`, [consultationId]);
      await db.query(`UPDATE consultations SET status = 'CONFIRMED' WHERE id = $1`, [consultationId]);
      await db.query(`UPDATE availability_slots SET status = 'BOOKED' WHERE id = $1`, [consultation.slot_id]);

      consultationsTotalCounter.inc({ status: 'CONFIRMED' });
      activeConsultationsGauge.inc();

      // Async notification job
      await queueService.enqueue('SEND_CONSULTATION_NOTIFICATION', {
        recipientEmail: 'patient@amrutam.co.in',
        title: 'Consultation Confirmed',
        body: `Your consultation is scheduled. Join link: ${consultation.meeting_link}`,
      });

      return {
        consultationId,
        status: 'CONFIRMED',
        message: 'Payment verified and consultation confirmed',
      };
    } else {
      // Payment failed: release slot
      await db.query(`UPDATE payments SET status = 'FAILED' WHERE consultation_id = $1`, [consultationId]);
      await db.query(`UPDATE consultations SET status = 'CANCELLED' WHERE id = $1`, [consultationId]);
      await db.query(`UPDATE availability_slots SET status = 'AVAILABLE' WHERE id = $1`, [consultation.slot_id]);

      consultationsTotalCounter.inc({ status: 'CANCELLED' });

      return {
        consultationId,
        status: 'CANCELLED',
        message: 'Payment failed. Slot has been released.',
      };
    }
  }

  /**
   * Cancel consultation and release slot
   */
  async cancelConsultation(consultationId: string, userId: string, role: string) {
    const consultRes = await db.query('SELECT * FROM consultations WHERE id = $1', [consultationId]);
    if (consultRes.rows.length === 0) {
      throw new AppError('Consultation not found', 404);
    }
    const consultation = consultRes.rows[0];

    // Ownership check
    if (role !== 'ADMIN' && consultation.patient_id !== userId && consultation.doctor_id !== userId) {
      throw new AppError('You do not have permission to cancel this consultation', 403);
    }

    if (['COMPLETED', 'CANCELLED'].includes(consultation.status)) {
      throw new AppError(`Cannot cancel consultation in ${consultation.status} state`, 400);
    }

    await db.query(`UPDATE consultations SET status = 'CANCELLED' WHERE id = $1`, [consultationId]);
    await db.query(`UPDATE availability_slots SET status = 'AVAILABLE' WHERE id = $1`, [consultation.slot_id]);
    await db.query(`UPDATE payments SET status = 'REFUNDED' WHERE consultation_id = $1`, [consultationId]);

    consultationsTotalCounter.inc({ status: 'CANCELLED' });
    activeConsultationsGauge.dec();

    return {
      consultationId,
      status: 'CANCELLED',
      message: 'Consultation successfully cancelled and slot restored to available',
    };
  }

  async getConsultationById(id: string) {
    const res = await db.query('SELECT * FROM consultations WHERE id = $1', [id]);
    if (res.rows.length === 0) {
      throw new AppError('Consultation not found', 404);
    }
    return res.rows[0];
  }
}

export const consultationService = new ConsultationService();
