// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m06 structural gate — credential-repair paths must resolve USER-scoped, the
// ABOUTME: authenticating-keyId setter must stay in one place, and no success payload may fake it.

/**
 * Sprint 86 m06 — the three invariants that hold this fix in place.
 *
 * Two of them are UNOBSERVABLE behaviourally today, which is exactly why they need a gate
 * rather than a test:
 *
 *  - `defaultClientFactory` in project-key-capture resolves user-scoped, but the startup
 *    runner only reaches it after proving no local project row exists, so the project-scoped
 *    and user-scoped entry points behave identically there. A behavioural test for it would
 *    be a test that cannot fail. What CAN be gated is the structure: no code under `src/auth/`
 *    may resolve through the project-scoped entry point, and a future "no-op simplification"
 *    that reverts it must go red here.
 *  - The authenticating-keyId setter has exactly one call site. Spraying it across the
 *    resolution arms is the rejected fix: the field never reaches the wire, so stamping it in
 *    an arm that authenticates with a project key records an attribution the request does not
 *    support — a lie that looks like a fix.
 *
 * FALSE-NEGATIVE PROFILE, written rather than discovered later. This gate reads TEXT, so:
 *  (1) it cannot see a project-scoped client passed INTO `src/auth/` from a caller outside it
 *      — `classifyAttribution` rule 5 is the runtime backstop for that, covered in
 *      reissue-resolution.test.ts;
 *  (2) it cannot see resolution reached through an alias or a dynamic property access
 *      (`const f = DashboardClient['fromEnvForProject']`);
 *  (3) it counts CALL SITES, not mentions — comments and doc prose that name the chain are
 *      deliberately allowed, because describing why the change exists is the point. The rule is
 *      an identifier followed by `(`, so it is strict in one direction: a comment that writes the
 *      name WITH parentheses would be counted as a call site. That is a false POSITIVE (it fails
 *      loudly, it does not silently permit), which is the safe direction for a gate;
 *  (4) it says nothing about whether the resolved credential is CORRECT, only which entry
 *      point produced it.
 * Each check below therefore carries a premise assertion proving the pattern can still match
 * something, so a rename cannot silently turn the gate into a tautology.
 *
 * ZERO ALLOWLIST ENTRIES.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const AUTH_DIR = path.join(REPO_ROOT, 'src', 'auth');
const DASHBOARD_CLIENT = path.join(REPO_ROOT, 'src', 'tools', 'cmos', 'dashboard-client.ts');
const CMOS_AUTH = path.join(REPO_ROOT, 'src', 'tools', 'cmos', 'cmos-auth.ts');

/**
 * Every `.ts` file under src/auth (the credential-capture surface), RECURSIVELY — a future
 * `src/auth/<subdir>/` must not be able to resolve project-scoped where this gate cannot see it.
 */
function authSources(dir: string = AUTH_DIR): Array<{ file: string; content: string }> {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return authSources(full);
    if (!entry.name.endsWith('.ts')) return [];
    return [{ file: path.relative(AUTH_DIR, full), content: fs.readFileSync(full, 'utf8') }];
  });
}

/** Call sites, not mentions: an identifier immediately followed by `(`. */
function callSites(content: string, method: string): number {
  return (content.match(new RegExp(`\\b${method}\\s*\\(`, 'g')) ?? []).length;
}

describe('s86-m06 structural gate: user-scoped resolution for credential repair', () => {
  it('has files to inspect (premise)', () => {
    const sources = authSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.map((s) => s.file)).toContain('project-key-capture.ts');
  });

  it('no code under src/auth resolves a client through the project-scoped entry point', () => {
    const offenders = authSources()
      .map(({ file, content }) => ({ file, hits: callSites(content, 'fromEnvForProject') }))
      .filter((row) => row.hits > 0);

    expect(offenders).toEqual([]);
  });

  it('project-key-capture resolves through the user-scoped entry point (premise: the pattern matches)', () => {
    const content = fs.readFileSync(path.join(AUTH_DIR, 'project-key-capture.ts'), 'utf8');

    // The positive half. Without this, the check above would pass just as well on a file that
    // resolves nothing at all — which is how a gate becomes a tautology.
    expect(callSites(content, 'fromEnvForUser')).toBeGreaterThan(0);

    // And the comment recording WHY the change is unobservable today must survive, so a later
    // dead-code sweep does not read it as a pointless indirection.
    expect(content).toMatch(/provably dead|latent-trap|no-op simplification/);
  });

  it('the authenticating-keyId setter has exactly one call site repo-wide', () => {
    const clientSource = fs.readFileSync(DASHBOARD_CLIENT, 'utf8');

    // One definition + one call, both in dashboard-client.ts.
    const definitions = (clientSource.match(/^\s*setAuthenticatingKeyId\s*\(/gm) ?? []).length;
    expect(definitions).toBe(1);

    const totalCalls = callSites(clientSource, 'setAuthenticatingKeyId') - definitions;
    expect(totalCalls).toBe(1);

    // And it is inside the shared user-scoped chain, not in an arm-1/arm-2 path.
    const chainStart = clientSource.indexOf('private static async resolveUserScopedChain');
    expect(chainStart).toBeGreaterThan(-1);
    const callIndex = clientSource.indexOf('client.setAuthenticatingKeyId(');
    expect(callIndex).toBeGreaterThan(chainStart);
  });

  it('the reissue success payload does not hardcode an empty revoked list', () => {
    const content = fs.readFileSync(CMOS_AUTH, 'utf8');

    // Premise: the field is still reported at all.
    expect(content).toContain('revokedKeyIds');
    // The lie: a success answer asserting "nothing was revoked" regardless of the response.
    expect(content).not.toMatch(/revokedKeyIds:\s*\[\s*\]/);
  });

  it('no message on the reissue path names device code as the cause of an attribution failure', () => {
    // Each entry pairs the forbidden wording with a PREMISE — a string the honest replacement
    // must still contain. Without the premise this check is a pure negative: on a future tree
    // where the wording has moved on it could never fail, which is the tautology the header
    // above claims this gate avoids. The premise makes a reword redden the gate instead.
    const files = [
      { file: CMOS_AUTH, premise: 'holds no user-scoped keys' },
      { file: path.join(AUTH_DIR, 'project-key-capture.ts'), premise: 'holds no user-scoped keys' },
      {
        file: path.join(REPO_ROOT, 'src', 'tools', 'cmos', 'checkpoint-backfill.ts'),
        premise: 'keySource=',
      },
    ];

    for (const { file, premise } of files) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content).toContain(premise);
      expect(content).not.toContain('device code flow must be run');
      expect(content).not.toContain('run device code flow');
      // Nor may any of them promise that a later reissue will succeed.
      expect(content).not.toContain('then reissue will succeed');
      expect(content).not.toContain('reissue on next startup will recover');
    }
  });
});
