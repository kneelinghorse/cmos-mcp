// s77-m10: dedicated config for the heavy first-run E2E (pack -> install -> drive
// over stdio). Kept OUT of the default suite (jest.config.js ignores /tests/e2e/) so
// it never touches the coverage floors or the unit-test runtime. Run with
// `npm run test:e2e-firstrun`. No globalSetup — it must NOT reuse the in-process
// suite's shared registry/config fixtures; it isolates its own CMOS_CONFIG_DIR.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/e2e'],
  testMatch: ['**/*.e2e.ts'],
  collectCoverage: false,
  testTimeout: 180000,
};
