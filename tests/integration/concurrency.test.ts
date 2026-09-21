import request from 'supertest';
import { createApp } from '../../src/app';
import { db } from '../../src/infrastructure/database/db.service';
import jwt from 'jsonwebtoken';
import { config } from '../../src/config/env';

describe('Concurrency Protection & Race Condition Prevention', () => {
  const app = createApp();
  let doctorId: string;
  let slotId: string;
  const patientTokens: string[] = [];

  beforeAll(async () => {
    // 1. Create a Doctor
    const docUser = await db.query(
      `INSERT INTO users (email, password_hash, role) VALUES ('doc.race@amrutam.co.in', 'hash', 'DOCTOR')`
    );
    doctorId = docUser.rows[0].id;
    await db.query(
      `INSERT INTO doctors (user_id, specialty, experience_years, consultation_fee) VALUES ($1, 'AYURVEDA', 8, 500)`,
      [doctorId]
    );

    // 2. Create a Single Target Slot
    const start = new Date(Date.now() + 86400000);
    const end = new Date(start.getTime() + 1800000);
    const slotRes = await db.query(
      `INSERT INTO availability_slots (doctor_id, start_time, end_time, status) VALUES ($1, $2, $3, 'AVAILABLE')`,
      [doctorId, start.toISOString(), end.toISOString()]
    );
    slotId = slotRes.rows[0].id;

    // 3. Create 5 Patient users and tokens
    for (let i = 1; i <= 5; i++) {
      const patient = await db.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1, 'hash', 'PATIENT')`,
        [`patient.race.${i}@amrutam.co.in`]
      );
      const token = jwt.sign(
        { id: patient.rows[0].id, email: patient.rows[0].email, role: 'PATIENT' },
        config.JWT_SECRET,
        { expiresIn: '1h' }
      );
      patientTokens.push(token);
    }
  });

  it('should allow only ONE patient to book a slot under high concurrency and reject all others with 409 Conflict', async () => {
    // Dispatch 5 concurrent booking requests for the EXACT same slotId
    const promises = patientTokens.map((token, index) => {
      return request(app)
        .post('/api/v1/consultations/book')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', `race-key-${index}-${Date.now()}`)
        .send({
          doctorId,
          slotId,
          symptoms: `Concurrent booking test from patient ${index}`,
        });
    });

    const responses = await Promise.all(promises);

    const successfulBookings = responses.filter((res) => res.status === 201);
    const rejectedBookings = responses.filter((res) => res.status === 409 || res.status === 400);

    // EXACTLY 1 booking succeeded
    expect(successfulBookings.length).toBe(1);
    // The other 4 were cleanly rejected
    expect(rejectedBookings.length).toBe(4);

    // Verify slot is now marked LOCKED
    const slotCheck = await db.query('SELECT status FROM availability_slots WHERE id = $1', [slotId]);
    expect(slotCheck.rows[0].status).toBe('LOCKED');
  });
});
