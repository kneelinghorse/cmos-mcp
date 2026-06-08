// Dynamically adjust coverage thresholds when running a focused subset
// e.g., `npm test -- import-export` should validate functionality without failing global thresholds
const isFocusedRun = process.argv.some((arg) =>
  /import-export|combination|versioning|intelligence/.test(arg)
);

const baselineThresholds = {
  branches: 69,
  functions: 82, // Sprint 51: removing dead condense functions (all tested) lowered ratio by 0.1%
  lines: 84,
  statements: 84,
};

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  globalSetup: '<rootDir>/tests/jest-global-setup.ts',
  globalTeardown: '<rootDir>/tests/jest-global-teardown.ts',
  // Sprint 70 m01: strip real dashboard creds (leaked from .env via env-loader)
  // before each test so fire-and-forget checkpoint syncs never hit the live
  // dashboard or log after teardown. See tests/jest-setup-after-env.ts.
  setupFilesAfterEnv: ['<rootDir>/tests/jest-setup-after-env.ts'],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/*.interface.ts'],
  coverageThreshold: isFocusedRun
    ? {
        // Looser thresholds for focused suites to prevent unrelated files from failing CI
        global: {
          branches: Math.min(75, baselineThresholds.branches),
          functions: Math.min(80, baselineThresholds.functions),
          lines: Math.min(80, baselineThresholds.lines),
          statements: Math.min(80, baselineThresholds.statements),
        },
      }
    : {
        // Project-wide targets aligned with latest green baseline
        global: {
          branches: baselineThresholds.branches,
          functions: baselineThresholds.functions,
          lines: baselineThresholds.lines,
          statements: baselineThresholds.statements,
        },
      },
};
