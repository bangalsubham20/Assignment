import { db } from '../../infrastructure/database/db.service';
import { CryptoUtil } from '../../utils/crypto';
import { queueService } from '../../jobs/queue.service';
import { AppError } from '../../middleware/errorHandler';

export interface IssuePrescriptionDTO {
  consultationId: string;
  doctorId: string;
  medicalNotes: string;
  medications: Array<{
    name: string;
    dosage: string;
    frequency: string;
    days: number;
  }>;
}

export class PrescriptionService {
  async issuePrescription(data: IssuePrescriptionDTO) {
    // 1. Verify consultation exists and belongs to this doctor
    const consultRes = await db.query('SELECT * FROM consultations WHERE id = $1', [data.consultationId]);
    if (consultRes.rows.length === 0) {
      throw new AppError('Consultation record not found', 404);
    }
    const consultation = consultRes.rows[0];

    if (consultation.doctor_id !== data.doctorId) {
      throw new AppError('Unauthorized: Only the assigned doctor can issue a prescription', 403);
    }

    if (consultation.status === 'CANCELLED') {
      throw new AppError('Cannot prescribe for a cancelled consultation', 400);
    }

    // 2. Encrypt medical notes using AES-256-GCM (Protected Health Information)
    const encryptedNotes = CryptoUtil.encryptField(data.medicalNotes);

    // 3. Generate cryptographic doctor digital signature
    const digitalSignature = CryptoUtil.generatePrescriptionSignature(
      data.doctorId,
      data.consultationId,
      data.medications
    );

    // 4. Save prescription record
    const prescRes = await db.query(
      `INSERT INTO prescriptions (consultation_id, doctor_id, patient_id, encrypted_medical_notes, medications, digital_signature)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        data.consultationId,
        data.doctorId,
        consultation.patient_id,
        encryptedNotes,
        JSON.stringify(data.medications),
        digitalSignature,
      ]
    );
    const prescription = prescRes.rows[0];

    // 5. Complete consultation state
    await db.query(`UPDATE consultations SET status = 'COMPLETED' WHERE id = $1`, [data.consultationId]);

    // 6. Enqueue async PDF generation job
    await queueService.enqueue('GENERATE_PRESCRIPTION_DOCUMENT', {
      prescriptionId: prescription.id,
      consultationId: data.consultationId,
    });

    return {
      prescriptionId: prescription.id,
      consultationId: data.consultationId,
      digitalSignature,
      createdAt: prescription.created_at,
      message: 'Prescription issued with encrypted clinical notes and digital signature',
    };
  }

  async getPrescription(consultationId: string, requestingUserId: string, role: string) {
    const prescRes = await db.query('SELECT * FROM prescriptions WHERE consultation_id = $1', [consultationId]);
    if (prescRes.rows.length === 0) {
      throw new AppError('Prescription not found for this consultation', 404);
    }
    const presc = prescRes.rows[0];

    // RBAC Ownership check: Only patient of record, doctor of record, or admin can decrypt
    if (role !== 'ADMIN' && presc.patient_id !== requestingUserId && presc.doctor_id !== requestingUserId) {
      throw new AppError('Access denied: Unauthorized access to Protected Health Information (PHI)', 403);
    }

    // Decrypt medical notes
    let decryptedNotes = '';
    try {
      decryptedNotes = CryptoUtil.decryptField(presc.encrypted_medical_notes);
    } catch {
      decryptedNotes = '[Decryption failed: signature verification mismatch]';
    }

    const medications = typeof presc.medications === 'string' ? JSON.parse(presc.medications) : presc.medications;

    // Verify digital signature integrity
    const isSignatureValid = CryptoUtil.verifyPrescriptionSignature(
      presc.doctor_id,
      presc.consultation_id,
      medications,
      presc.digital_signature
    );

    return {
      prescriptionId: presc.id,
      consultationId: presc.consultation_id,
      doctorId: presc.doctor_id,
      patientId: presc.patient_id,
      medicalNotes: decryptedNotes,
      medications,
      digitalSignature: presc.digital_signature,
      signatureVerified: isSignatureValid,
      issuedAt: presc.created_at,
    };
  }
}

export const prescriptionService = new PrescriptionService();
