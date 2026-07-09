// Dynamically adjust coverage thresholds when running a focused subset
// e.g., `npm test -- import-export` should validate functionality without failing global thresholds
const isFocusedRun = process.argv.some((arg) => /combination|intelligence/.test(arg));

// Coverage floors — measured-green integers, deliberately set BELOW the measured
// ratios so normal work does not red CI on noise (never bolt filler tests onto
// live code to hold a number: design doc §5.4).
//
// Sprint 51: removing dead condense functions (all tested) lowered ratio by 0.1%.
// Sprint 76 (Great Deletion G2): deleting the heavily-covered dead agentic island +
//   its edge-padder tests dropped global functions 83.94 -> 80.51; lowered 82 -> 80.
// Sprint 77 m03 (2026-07-08, gpt-tokenizer excision — OWNS the definitive re-set):
//   removed the well-covered GPT counting + preload/health apparatus AND its tests,
//   and added Claude-path + keep-branch-guard coverage. Re-measured full-suite green:
//   statements 84.74, branches 69.60, functions 80.17, lines 85.45. Floors held at
//   the values below (each sits under measured with headroom); m04-m06 only ADD
//   coverage and re-confirm-green, so the ratios rise from here. Floors are final
//   after m06.
const baselineThresholds = {
  branches: 69,
  functions: 80,
  lines: 84,
  statements: 84,
};

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // DB-heavy integration suites (bdd/cmos-session-start.steps, sprint-status-sync,
  // tier-config, sync-locks, …) occasionally exceed the 5s default under 220+-suite
  // parallel CPU contention, producing rotating timeout flakes. 30s gives headroom
  // without masking real hangs; a file-level jest.setTimeout still overrides per suite.
  testTimeout: 30000,
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // s77-m10: the heavy first-run E2E (tests/e2e/*.e2e.ts) runs under jest.e2e.config.js
  // via `npm run test:e2e-firstrun`, never in the default suite (protects the coverage
  // floors + unit runtime). testMatch already excludes *.e2e.ts; this is belt-and-suspenders.
  testPathIgnorePatterns: ['/node_modules/', '/tests/e2e/'],
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
