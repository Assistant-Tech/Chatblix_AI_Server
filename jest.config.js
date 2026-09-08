/** @type {import('jest').Config} */
// Unit tests. E2E specs (test/**/*.e2e-spec.ts) have their own config
// (jest.e2e.config.js) and require live Postgres/Redis, so they are excluded here.
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 15000,
};
