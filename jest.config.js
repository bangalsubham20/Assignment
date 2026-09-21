process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'super_secure_jwt_secret_key_amrutam_telemedicine_32chars_min_length!';
process.env.JWT_REFRESH_SECRET = 'super_secure_jwt_refresh_secret_key_amrutam_telemedicine_32chars!';
process.env.ENCRYPTION_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { esModuleInterop: true } }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['src/**/*.ts', '!src/server.ts'],
  testTimeout: 15000,
};
