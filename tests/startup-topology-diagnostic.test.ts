import { describe, expect, test } from '@jest/globals';
import { evaluateStartupTopology } from '../src/index';
import { CmosErrors } from '../src/tools/cmos/errors';

// s78-m06: topology diagnostic + /register nudge repoint.

describe('evaluateStartupTopology (s78-m06)', () => {
  test('WARNs only when CMOS_PROJECT_ROOT is pinned AND >1 project is registered', () => {
    expect(evaluateStartupTopology('/repo', 2).warned).toBe(true);
    expect(evaluateStartupTopology('/repo', 5).warned).toBe(true);
  });

  test('silent for a single registered project (unambiguous)', () => {
    expect(evaluateStartupTopology('/repo', 1).warned).toBe(false);
    expect(evaluateStartupTopology('/repo', 0).warned).toBe(false);
  });

  test('silent when CMOS_PROJECT_ROOT is unset/empty/whitespace (project-local server)', () => {
    expect(evaluateStartupTopology(undefined, 9).warned).toBe(false);
    expect(evaluateStartupTopology('', 9).warned).toBe(false);
    expect(evaluateStartupTopology('   ', 9).warned).toBe(false);
  });

  test('reports the inputs it evaluated', () => {
    const r = evaluateStartupTopology('/repo', 3);
    expect(r.projectRootPinned).toBe(true);
    expect(r.registryProjectCount).toBe(3);
  });
});

describe('sign-up nudges repointed to /register (s78-m06)', () => {
  test('dashboardNotConfigured points sign-up at /register', () => {
    const err = CmosErrors.dashboardNotConfigured();
    expect(err.message).toContain('https://cmos.aquex.ai/register');
    // The CMOS_DASHBOARD_URL config example stays the bare base URL (not /register).
    expect(err.suggestion).toContain('CMOS_DASHBOARD_URL=https://cmos.aquex.ai');
    expect(err.suggestion).not.toContain('CMOS_DASHBOARD_URL=https://cmos.aquex.ai/register');
  });

  test('dashboardUpgradeRequired points upgrade at /register', () => {
    const err = CmosErrors.dashboardUpgradeRequired('vector search');
    expect(err.message).toContain('https://cmos.aquex.ai/register');
    expect(err.suggestion).toContain('https://cmos.aquex.ai/register');
  });
});
