import { describe, expect, test } from '@jest/globals';
import { evaluateStartupTopology } from '../src/index';
import { RbookErrors } from '../src/tools/rbook/errors';

// s78-m06: topology diagnostic + /register nudge repoint.

describe('evaluateStartupTopology (s78-m06)', () => {
  test('WARNs only when RBOOK_PROJECT_ROOT is pinned AND >1 project is registered', () => {
    expect(evaluateStartupTopology('/repo', 2).warned).toBe(true);
    expect(evaluateStartupTopology('/repo', 5).warned).toBe(true);
  });

  test('silent for a single registered project (unambiguous)', () => {
    expect(evaluateStartupTopology('/repo', 1).warned).toBe(false);
    expect(evaluateStartupTopology('/repo', 0).warned).toBe(false);
  });

  test('silent when RBOOK_PROJECT_ROOT is unset/empty/whitespace (project-local server)', () => {
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
    const err = RbookErrors.dashboardNotConfigured();
    expect(err.message).toContain('https://reasonbook.ai/register');
    // s92-m06: the suggestion no longer tells the user to set RBOOK_DASHBOARD_URL — the URL has a
    // default, so a missing sign-in, not the URL, is what this error means. It names the sign-in
    // and the bare base URL, never /register.
    expect(err.suggestion).toContain('rbook_auth(action="login_init")');
    expect(err.suggestion).toContain('https://reasonbook.ai');
    expect(err.suggestion).not.toContain('/register');
  });

  test('dashboardUpgradeRequired points upgrade at /register', () => {
    const err = RbookErrors.dashboardUpgradeRequired('vector search');
    expect(err.message).toContain('https://reasonbook.ai/register');
    expect(err.suggestion).toContain('https://reasonbook.ai/register');
  });
});
