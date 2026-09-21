import { CryptoUtil } from '../../src/utils/crypto';

describe('CryptoUtil - Field-Level Encryption & Digital Signatures', () => {
  it('should encrypt and decrypt clinical medical notes using AES-256-GCM', () => {
    const rawNotes = 'Patient exhibits Pitta dosha aggravation with acid reflux and skin flare-ups.';
    const encrypted = CryptoUtil.encryptField(rawNotes);

    expect(encrypted).not.toBe(rawNotes);
    expect(encrypted.split(':')).toHaveLength(4); // keyId:iv:authTag:ciphertext

    const decrypted = CryptoUtil.decryptField(encrypted);
    expect(decrypted).toBe(rawNotes);
  });

  it('should reject tampered ciphertext during GCM tag authentication', () => {
    const rawNotes = 'Confidential patient health data';
    const encrypted = CryptoUtil.encryptField(rawNotes);
    const parts = encrypted.split(':');
    
    // Tamper with ciphertext
    parts[3] = parts[3].slice(0, -2) + 'aa';
    const tampered = parts.join(':');

    expect(() => CryptoUtil.decryptField(tampered)).toThrow();
  });

  it('should generate and verify prescription digital signature', () => {
    const doctorId = 'doc-uuid-1234';
    const consultationId = 'consult-uuid-5678';
    const medications = [{ name: 'Triphala', dosage: '500mg', days: 15 }];

    const signature = CryptoUtil.generatePrescriptionSignature(doctorId, consultationId, medications);
    expect(signature).toBeDefined();
    expect(typeof signature).toBe('string');
    expect(signature.length).toBe(64); // SHA-256 hex length

    const isValid = CryptoUtil.verifyPrescriptionSignature(doctorId, consultationId, medications, signature);
    expect(isValid).toBe(true);

    // Tampered medication should fail signature check
    const tamperedMedications = [{ name: 'Triphala', dosage: '2000mg', days: 15 }];
    const isTamperedValid = CryptoUtil.verifyPrescriptionSignature(doctorId, consultationId, tamperedMedications, signature);
    expect(isTamperedValid).toBe(false);
  });
});
