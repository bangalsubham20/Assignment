import request from 'supertest';
import { createApp } from '../../src/app';

describe('End-to-End Telemedicine Workflow', () => {
  const app = createApp();

  let doctorToken: string;
  let doctorId: string;
  let patientToken: string;
  let patientId: string;
  let adminToken: string;

  let createdSlotId: string;
  let consultationId: string;

  beforeAll(async () => {
    // 1. Register Doctor
    const docRes = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: `dr.e2e.${Date.now()}@amrutam.co.in`,
        password: 'DoctorPassword123!',
        role: 'DOCTOR',
        firstName: 'Vaidya',
        lastName: 'E2E',
        specialty: 'AYURVEDA',
        consultationFee: 750,
      });
    doctorToken = docRes.body.tokens.accessToken;
    doctorId = docRes.body.user.id;

    // 2. Register Patient
    const patientRes = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: `patient.e2e.${Date.now()}@amrutam.co.in`,
        password: 'PatientPassword123!',
        role: 'PATIENT',
        firstName: 'Arjun',
        lastName: 'Patel',
      });
    patientToken = patientRes.body.tokens.accessToken;
    patientId = patientRes.body.user.id;

    // 3. Register Admin
    const adminRes = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: `admin.e2e.${Date.now()}@amrutam.co.in`,
        password: 'AdminPassword123!',
        role: 'ADMIN',
        firstName: 'System',
        lastName: 'Admin',
      });
    adminToken = adminRes.body.tokens.accessToken;
  });

  it('1. Doctor creates availability slots', async () => {
    const start = new Date(Date.now() + 3600000);
    const end = new Date(start.getTime() + 1800000);

    const res = await request(app)
      .post('/api/v1/doctors/slots')
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({
        slots: [{ startTime: start.toISOString(), endTime: end.toISOString() }],
      });

    expect(res.status).toBe(201);
    expect(res.body.slots).toHaveLength(1);
    createdSlotId = res.body.slots[0].id;
  });

  it('2. Patient searches doctors by specialty', async () => {
    const res = await request(app).get('/api/v1/search?specialty=AYURVEDA');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('3. Patient reserves slot with Idempotency Key', async () => {
    const idemKey = `idem-book-${Date.now()}`;

    // First attempt
    const res1 = await request(app)
      .post('/api/v1/consultations/book')
      .set('Authorization', `Bearer ${patientToken}`)
      .set('Idempotency-Key', idemKey)
      .send({
        doctorId,
        slotId: createdSlotId,
        symptoms: 'Mild stress and chronic insomnia',
      });

    expect(res1.status).toBe(201);
    expect(res1.body.consultationId).toBeDefined();
    expect(res1.body.status).toBe('PENDING_PAYMENT');
    consultationId = res1.body.consultationId;

    // Second attempt with exact same Idempotency Key -> Replay cached response
    const res2 = await request(app)
      .post('/api/v1/consultations/book')
      .set('Authorization', `Bearer ${patientToken}`)
      .set('Idempotency-Key', idemKey)
      .send({
        doctorId,
        slotId: createdSlotId,
        symptoms: 'Mild stress and chronic insomnia',
      });

    expect(res2.status).toBe(201);
    expect(res2.headers['x-idempotent-replay']).toBe('true');
    expect(res2.body.consultationId).toBe(consultationId);
  });

  it('4. Patient completes payment verification to confirm slot', async () => {
    const res = await request(app)
      .post('/api/v1/consultations/payments/verify')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({
        consultationId,
        status: 'SUCCESS',
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CONFIRMED');
  });

  it('5. Doctor issues digital prescription with encrypted notes', async () => {
    const res = await request(app)
      .post('/api/v1/prescriptions')
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({
        consultationId,
        medicalNotes: 'Clinical assessment: Vata imbalance. Recommended Brahmi Vati and evening meditation.',
        medications: [
          { name: 'Brahmi Vati', dosage: '2 tablets', frequency: 'Bedtime', days: 30 },
          { name: 'Ashwagandha Churna', dosage: '1 tsp', frequency: 'Morning with milk', days: 30 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.digitalSignature).toBeDefined();
    expect(res.body.prescriptionId).toBeDefined();
  });

  it('6. Patient views decrypted prescription with validated digital signature', async () => {
    const res = await request(app)
      .get(`/api/v1/prescriptions/${consultationId}`)
      .set('Authorization', `Bearer ${patientToken}`);

    expect(res.status).toBe(200);
    expect(res.body.medicalNotes).toContain('Vata imbalance');
    expect(res.body.signatureVerified).toBe(true);
    expect(res.body.medications).toHaveLength(2);
  });

  it('7. Admin accesses platform analytics', async () => {
    const res = await request(app)
      .get('/api/v1/admin/analytics')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.capacityMetrics.dailyConsultationsTarget).toBe(100000);
  });

  it('8. Health and Prometheus metrics endpoints are active', async () => {
    const health = await request(app).get('/health/ready');
    expect(health.status).toBe(200);

    const metrics = await request(app).get('/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.text).toContain('amrutam_http_requests_total');
  });
});
