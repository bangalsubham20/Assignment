import bcrypt from 'bcryptjs';
import { db } from './db.service';
import { logger } from '../telemetry/logger';

export async function runSeed() {
  logger.info('Starting database seeding...');

  const passwordHash = await bcrypt.hash('Amrutam@2026', 10);

  // 1. Seed Admin
  const adminEmail = 'admin@amrutam.co.in';
  let adminRes = await db.query('SELECT id FROM users WHERE email = $1', [adminEmail]);
  if (adminRes.rows.length === 0) {
    adminRes = await db.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'ADMIN')`,
      [adminEmail, passwordHash]
    );
    await db.query(
      `INSERT INTO profiles (user_id, first_name, last_name) VALUES ($1, 'Amrutam', 'Admin')`,
      [adminRes.rows[0].id]
    );
    logger.info(`Admin user created: ${adminEmail}`);
  }

  // 2. Seed Doctor 1 (Ayurveda)
  const doc1Email = 'dr.ramanathan@amrutam.co.in';
  let doc1Res = await db.query('SELECT id FROM users WHERE email = $1', [doc1Email]);
  let doc1Id = '';
  if (doc1Res.rows.length === 0) {
    doc1Res = await db.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'DOCTOR')`,
      [doc1Email, passwordHash]
    );
    doc1Id = doc1Res.rows[0].id;
    await db.query(
      `INSERT INTO profiles (user_id, first_name, last_name, phone) VALUES ($1, 'Vaidya', 'Ramanathan', '+919876543210')`,
      [doc1Id]
    );
    await db.query(
      `INSERT INTO doctors (user_id, specialty, experience_years, consultation_fee, bio, rating, total_reviews)
       VALUES ($1, 'AYURVEDA', 14, 750.00, 'Senior Ayurvedic Physician specializing in chronic metabolic health, pulse diagnosis (Nadi Pariksha), and herbal formulations.', 4.95, 340)`,
      [doc1Id]
    );
    logger.info(`Doctor 1 created: ${doc1Email}`);
  } else {
    doc1Id = doc1Res.rows[0].id;
  }

  // 3. Seed Doctor 2 (Panchakarma)
  const doc2Email = 'dr.ananya@amrutam.co.in';
  let doc2Res = await db.query('SELECT id FROM users WHERE email = $1', [doc2Email]);
  let doc2Id = '';
  if (doc2Res.rows.length === 0) {
    doc2Res = await db.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'DOCTOR')`,
      [doc2Email, passwordHash]
    );
    doc2Id = doc2Res.rows[0].id;
    await db.query(
      `INSERT INTO profiles (user_id, first_name, last_name, phone) VALUES ($1, 'Dr. Ananya', 'Mukherjee', '+919876543211')`,
      [doc2Id]
    );
    await db.query(
      `INSERT INTO doctors (user_id, specialty, experience_years, consultation_fee, bio, rating, total_reviews)
       VALUES ($1, 'PANCHAKARMA', 9, 600.00, 'Ayurvedic Consultant with expertise in detoxification therapies, stress management, and rejuvenation protocols.', 4.88, 215)`,
      [doc2Id]
    );
    logger.info(`Doctor 2 created: ${doc2Email}`);
  } else {
    doc2Id = doc2Res.rows[0].id;
  }

  // 4. Seed Patient
  const patientEmail = 'patient@amrutam.co.in';
  let patientRes = await db.query('SELECT id FROM users WHERE email = $1', [patientEmail]);
  if (patientRes.rows.length === 0) {
    patientRes = await db.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'PATIENT')`,
      [patientEmail, passwordHash]
    );
    await db.query(
      `INSERT INTO profiles (user_id, first_name, last_name, phone) VALUES ($1, 'Aarav', 'Sharma', '+919123456780')`,
      [patientRes.rows[0].id]
    );
    logger.info(`Patient created: ${patientEmail}`);
  }

  // 5. Seed Availability Slots for Doctors
  const now = new Date();
  for (let i = 1; i <= 3; i++) {
    const start = new Date(now.getTime() + i * 3600 * 1000);
    const end = new Date(start.getTime() + 30 * 60 * 1000); // 30 min slot
    await db.query(
      `INSERT INTO availability_slots (doctor_id, start_time, end_time, status) VALUES ($1, $2, $3, 'AVAILABLE')`,
      [doc1Id, start.toISOString(), end.toISOString()]
    );
    await db.query(
      `INSERT INTO availability_slots (doctor_id, start_time, end_time, status) VALUES ($1, $2, $3, 'AVAILABLE')`,
      [doc2Id, start.toISOString(), end.toISOString()]
    );
  }

  logger.info('Database seeded successfully with doctors, patients, and availability slots.');
}

if (require.main === module) {
  runSeed().catch((err) => {
    logger.error('Database seeding failed:', err);
    process.exit(1);
  });
}
