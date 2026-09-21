import crypto from 'crypto';
import { config } from '../config/env';

export interface EncryptedPayload {
  keyId: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export class CryptoUtil {
  private static masterKey = Buffer.from(config.ENCRYPTION_MASTER_KEY, 'hex');

  /**
   * Encrypt sensitive PHI / medical text using AES-256-GCM
   * Returns formatted envelope string: "keyId:iv:authTag:ciphertext"
   */
  static encryptField(plaintext: string): string {
    const iv = crypto.randomBytes(12); // 96-bit recommended IV for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    
    let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return `${config.ENCRYPTION_KEY_ID}:${iv.toString('hex')}:${authTag}:${ciphertext}`;
  }

  /**
   * Decrypt AES-256-GCM encrypted envelope string
   */
  static decryptField(envelope: string): string {
    const parts = envelope.split(':');
    if (parts.length !== 4) {
      throw new Error('Malformed encrypted envelope format');
    }

    const [_keyId, ivHex, authTagHex, ciphertextHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAuthTag(authTag);

    let plaintext = decipher.update(ciphertextHex, 'hex', 'utf8');
    plaintext += decipher.final('utf8');

    return plaintext;
  }

  /**
   * Generate SHA-256 Hash of string or object for tamper-evident logs and idempotency payload checks
   */
  static sha256Hash(data: any): string {
    const stringified = typeof data === 'string' ? data : JSON.stringify(data);
    return crypto.createHash('sha256').update(stringified).digest('hex');
  }

  /**
   * Generate a cryptographic digital signature for a doctor prescription
   */
  static generatePrescriptionSignature(doctorId: string, consultationId: string, medications: any): string {
    const dataToSign = `${doctorId}|${consultationId}|${JSON.stringify(medications)}`;
    return crypto.createHmac('sha256', this.masterKey).update(dataToSign).digest('hex');
  }

  /**
   * Verify digital signature
   */
  static verifyPrescriptionSignature(doctorId: string, consultationId: string, medications: any, signature: string): boolean {
    const expected = this.generatePrescriptionSignature(doctorId, consultationId, medications);
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }
}
