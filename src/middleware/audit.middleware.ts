import { Request, Response, NextFunction } from 'express';
import { db } from '../infrastructure/database/db.service';
import { CryptoUtil } from '../utils/crypto';

export interface AuditRecordOptions {
  action: string;
  resourceType: string;
  resourceId?: string;
  payload?: any;
}

export const logAuditEvent = async (req: Request, options: AuditRecordOptions): Promise<void> => {
  const userId = req.user?.id || null;
  const ipAddress = req.ip || req.socket.remoteAddress || '127.0.0.1';
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const payloadHash = options.payload ? CryptoUtil.sha256Hash(options.payload) : null;

  try {
    await db.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, ip_address, user_agent, payload_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, options.action, options.resourceType, options.resourceId || null, ipAddress, userAgent, payloadHash]
    );
  } catch (err) {
    console.error('Failed to write audit log entry:', err);
  }
};
