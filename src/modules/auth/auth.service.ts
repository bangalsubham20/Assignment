import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { db } from '../../infrastructure/database/db.service';
import { config } from '../../config/env';
import { AppError } from '../../middleware/errorHandler';

export interface RegisterDTO {
  email: string;
  password: string;
  role: 'PATIENT' | 'DOCTOR' | 'ADMIN';
  firstName: string;
  lastName: string;
  phone?: string;
  specialty?: string;
  experienceYears?: number;
  consultationFee?: number;
  bio?: string;
}

export interface LoginDTO {
  email: string;
  password: string;
  totpCode?: string;
}

export class AuthService {
  async register(data: RegisterDTO) {
    // 1. Check if email already registered
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [data.email.toLowerCase()]);
    if (existing.rows.length > 0) {
      throw new AppError('Email address is already registered', 409);
    }

    // 2. Hash password with bcrypt (12 rounds)
    const salt = await bcrypt.genSalt(12);
    const passwordHash = await bcrypt.hash(data.password, salt);

    // 3. Insert user
    const userRes = await db.query(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, $3)`,
      [data.email.toLowerCase(), passwordHash, data.role]
    );
    const user = userRes.rows[0];

    // 4. Insert profile
    await db.query(
      `INSERT INTO profiles (user_id, first_name, last_name, phone)
       VALUES ($1, $2, $3, $4)`,
      [user.id, data.firstName, data.lastName, data.phone || null]
    );

    // 5. If Doctor, insert doctor record
    if (data.role === 'DOCTOR') {
      await db.query(
        `INSERT INTO doctors (user_id, specialty, experience_years, consultation_fee, bio)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          user.id,
          data.specialty || 'AYURVEDA',
          data.experienceYears || 5,
          data.consultationFee || 500,
          data.bio || 'Ayurvedic specialist focusing on holistic holistic healing',
        ]
      );
    }

    const tokens = this.generateTokens({
      id: user.id,
      email: user.email,
      role: user.role,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        firstName: data.firstName,
        lastName: data.lastName,
      },
      tokens,
    };
  }

  async login(data: LoginDTO) {
    const userRes = await db.query('SELECT * FROM users WHERE email = $1', [data.email.toLowerCase()]);
    if (userRes.rows.length === 0) {
      throw new AppError('Invalid email or password credentials', 401);
    }

    const user = userRes.rows[0];
    const isPasswordValid = await bcrypt.compare(data.password, user.password_hash);
    if (!isPasswordValid) {
      throw new AppError('Invalid email or password credentials', 401);
    }

    // Check MFA if enabled
    if (user.mfa_enabled) {
      if (!data.totpCode) {
        return {
          mfaRequired: true,
          userId: user.id,
          message: 'Multi-factor authentication code required',
        };
      }

      const isValidOtp = authenticator.verify({
        token: data.totpCode,
        secret: user.mfa_secret,
      });

      if (!isValidOtp) {
        throw new AppError('Invalid multi-factor authentication code', 401);
      }
    }

    const tokens = this.generateTokens({
      id: user.id,
      email: user.email,
      role: user.role,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        mfaEnabled: user.mfa_enabled,
      },
      tokens,
    };
  }

  async setupMFA(userId: string) {
    const userRes = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) {
      throw new AppError('User not found', 404);
    }
    const user = userRes.rows[0];

    const secret = authenticator.generateSecret();
    const otpAuthUrl = authenticator.keyuri(user.email, 'Amrutam Telemedicine', secret);
    const qrCodeUrl = await QRCode.toDataURL(otpAuthUrl);

    await db.query('UPDATE users SET mfa_secret = $1 WHERE id = $2', [secret, userId]);

    return {
      secret,
      qrCodeUrl,
      otpAuthUrl,
    };
  }

  async verifyMFA(userId: string, token: string) {
    const userRes = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) {
      throw new AppError('User not found', 404);
    }
    const user = userRes.rows[0];

    if (!user.mfa_secret) {
      throw new AppError('MFA setup not initialized for this account', 400);
    }

    const isValid = authenticator.verify({
      token,
      secret: user.mfa_secret,
    });

    if (!isValid) {
      throw new AppError('Invalid verification code', 400);
    }

    await db.query('UPDATE users SET mfa_enabled = TRUE WHERE id = $1', [userId]);

    return { success: true, message: 'MFA successfully activated' };
  }

  async refreshToken(refreshToken: string) {
    try {
      const decoded = jwt.verify(refreshToken, config.JWT_REFRESH_SECRET) as any;
      const userRes = await db.query('SELECT id, email, role FROM users WHERE id = $1', [decoded.id]);
      if (userRes.rows.length === 0) {
        throw new AppError('User not found or revoked', 401);
      }
      const user = userRes.rows[0];

      return this.generateTokens({
        id: user.id,
        email: user.email,
        role: user.role,
      });
    } catch {
      throw new AppError('Invalid or expired refresh token', 401);
    }
  }

  private generateTokens(payload: { id: string; email: string; role: string }) {
    const accessToken = jwt.sign(payload, config.JWT_SECRET, {
      expiresIn: config.JWT_ACCESS_EXPIRATION as any,
    });

    const refreshToken = jwt.sign({ id: payload.id }, config.JWT_REFRESH_SECRET, {
      expiresIn: config.JWT_REFRESH_EXPIRATION as any,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: config.JWT_ACCESS_EXPIRATION,
      tokenType: 'Bearer',
    };
  }
}

export const authService = new AuthService();
