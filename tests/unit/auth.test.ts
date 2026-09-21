import { authService } from '../../src/modules/auth/auth.service';
import { authenticator } from 'otplib';

describe('AuthService - Authentication & MFA Security', () => {
  const testEmail = `test.user.${Date.now()}@amrutam.co.in`;
  let userId = '';

  it('should register a new patient user with hashed credentials', async () => {
    const res = await authService.register({
      email: testEmail,
      password: 'SuperSecurePassword123!',
      role: 'PATIENT',
      firstName: 'Rohan',
      lastName: 'Verma',
    });

    expect(res.user).toBeDefined();
    expect(res.user.email).toBe(testEmail);
    expect(res.user.role).toBe('PATIENT');
    expect(res.tokens.accessToken).toBeDefined();
    expect(res.tokens.refreshToken).toBeDefined();
    userId = res.user.id;
  });

  it('should fail registration on duplicate email', async () => {
    await expect(
      authService.register({
        email: testEmail,
        password: 'AnotherPassword123!',
        role: 'PATIENT',
        firstName: 'Duplicate',
        lastName: 'User',
      })
    ).rejects.toThrow('already registered');
  });

  it('should successfully log in with valid credentials', async () => {
    const res = await authService.login({
      email: testEmail,
      password: 'SuperSecurePassword123!',
    });

    expect(res.tokens?.accessToken).toBeDefined();
    expect(res.user?.id).toBe(userId);
  });

  it('should reject login with wrong password', async () => {
    await expect(
      authService.login({
        email: testEmail,
        password: 'WrongPassword!',
      })
    ).rejects.toThrow('Invalid email or password');
  });

  it('should setup TOTP MFA and verify code successfully', async () => {
    const setup = await authService.setupMFA(userId);
    expect(setup.secret).toBeDefined();
    expect(setup.qrCodeUrl).toContain('data:image/png;base64');

    // Generate valid TOTP token using the secret
    const token = authenticator.generate(setup.secret);
    const verifyRes = await authService.verifyMFA(userId, token);
    expect(verifyRes.success).toBe(true);
  });
});
