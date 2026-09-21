import { db } from '../../infrastructure/database/db.service';
import { redisService } from '../../infrastructure/redis/redis.service';
import { AppError } from '../../middleware/errorHandler';

export interface CreateSlotDTO {
  doctorId: string;
  startTime: string;
  endTime: string;
}

export class DoctorService {
  async getDoctorProfile(doctorId: string) {
    const cacheKey = `cache:doctor:${doctorId}`;
    const cached = await redisService.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const docRes = await db.query(
      `SELECT d.*, p.first_name, p.last_name, p.avatar_url, u.email
       FROM doctors d
       JOIN profiles p ON d.user_id = p.user_id
       JOIN users u ON d.user_id = u.id
       WHERE d.user_id = $1`,
      [doctorId]
    );

    if (docRes.rows.length === 0) {
      throw new AppError('Doctor not found', 404);
    }

    const doc = docRes.rows[0];
    await redisService.set(cacheKey, JSON.stringify(doc), 300); // 5m TTL
    return doc;
  }

  async createSlots(doctorId: string, slots: Array<{ startTime: string; endTime: string }>) {
    // Check doctor exists
    const docCheck = await db.query('SELECT user_id FROM doctors WHERE user_id = $1', [doctorId]);
    if (docCheck.rows.length === 0) {
      throw new AppError('Only registered doctors can create availability slots', 403);
    }

    const createdSlots = [];
    for (const slot of slots) {
      const start = new Date(slot.startTime);
      const end = new Date(slot.endTime);

      if (end <= start) {
        throw new AppError('Slot end time must be after start time', 400);
      }

      const res = await db.query(
        `INSERT INTO availability_slots (doctor_id, start_time, end_time, status)
         VALUES ($1, $2, $3, 'AVAILABLE')`,
        [doctorId, start.toISOString(), end.toISOString()]
      );
      createdSlots.push(res.rows[0]);
    }

    // Invalidate cached slots for this doctor
    await redisService.del(`cache:slots:${doctorId}`);
    return createdSlots;
  }

  async getAvailableSlots(doctorId: string) {
    const cacheKey = `cache:slots:${doctorId}`;
    const cached = await redisService.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const res = await db.query(
      `SELECT id, doctor_id, start_time, end_time, status, version
       FROM availability_slots
       WHERE doctor_id = $1 AND status = 'AVAILABLE'
       ORDER BY start_time ASC`,
      [doctorId]
    );

    await redisService.set(cacheKey, JSON.stringify(res.rows), 30); // 30s TTL
    return res.rows;
  }
}

export const doctorService = new DoctorService();
