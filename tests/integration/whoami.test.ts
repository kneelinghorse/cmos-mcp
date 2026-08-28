// ABOUTME: Real-DB integration coverage for cmos_message(action="whoami") diagnostics.
// ABOUTME: Verifies candidate traces include rejected and accepted roots in precedence order.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { formatMessageForLLM, getWhoamiDiagnostics } from '../../src/tools/cmos/cmos-message';
import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { createSeededCmosProject, type SeededCmosProject } from '../helpers/seedCmosDb';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('whoami diagnostics', () => {
  let stage1Project: SeededCmosProject;
  let invalidRoot: string;

  beforeEach(async () => {
    CmosDetector.resetInstance();
    invalidRoot = await makeTempDir('whoami-invalid-');
    stage1Project = await createSeededCmosProject(
      {
        projectName: 'Stage1',
        projectId: 'stage1',
        slug: 'stage1',
        dashboardProjectId: 'ddb34d24-30e3-4eb3-b13c-20b106a75970',
        cmosAddress: 'cmos://derek/stage1',
      },
      'whoami-stage1-'
    );
  });

  afterEach(async () => {
    CmosDetector.resetInstance();
    await Promise.all([
      fs.rm(invalidRoot, { recursive: true, force: true }),
      stage1Project.cleanup(),
    ]);
  });

  it('returns a full candidate trace showing rejected explicit root and accepted MCP root', async () => {
    const result = await getWhoamiDiagnostics({
      explicitProjectRoot: invalidRoot,
      mcpRoots: [stage1Project.projectRoot],
      cwdOverride: '/tmp/no-cmos-here',
      serverInstallRootOverride: '/mock/server-install',
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      resolved: {
        projectRoot: path.resolve(stage1Project.projectRoot),
        source: 'mcp-roots',
        dashboardProjectId: 'ddb34d24-30e3-4eb3-b13c-20b106a75970',
        cmosAddress: 'cmos://derek/stage1',
      },
    });
    expect(result.data?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'explicit',
          accepted: false,
          rejectReason: expect.stringMatching(/no CMOS database/i),
        }),
        expect.objectContaining({
          source: 'mcp-roots',
          accepted: true,
          projectRoot: path.resolve(stage1Project.projectRoot),
        }),
      ])
    );

    const formatted = formatMessageForLLM('whoami', result);
    expect(formatted).toContain('Candidate trace:');
    expect(formatted).toContain('✗ explicit');
    expect(formatted).toContain('✓ mcp-roots');
  });

  /**
   * s87-m05 (#1015) — THE WARNING THAT FIRES ALONGSIDE A FULLY RESOLVED PAYLOAD.
   *
   * `buildWhoamiWarnings` was passed `relaxedContext`, which is assigned only inside
   * `if (!strictContext)`. On the SUCCESS path it is `undefined`, so the guard
   * `(!mcpRoots || mcpRoots.length === 0) && !relaxedContext?.projectRoot` fired even though
   * `resolvedContext` held the resolution. Nine rows of this repo's own signed-off artifact,
   * `cmos/docs/attribution-rebuild-verification.md`, record the warning beside a resolved root, a
   * dashboard project id and an address.
   *
   * THE TRAP THIS SUITE WAS ALREADY IN, and it is why the arm below omits `mcpRoots` entirely:
   * the guard's FIRST clause is `(!mcpRoots || mcpRoots.length === 0)`. When the client advertises
   * roots the warning CANNOT fire, whichever context is passed — so bolting an assertion onto the
   * existing test above, which passes a non-empty `mcpRoots`, would have produced exactly the
   * vacuous gate this sprint is named against. The no-roots path is real and named:
   * `runWhoamiCli()` calls `getWhoamiDiagnostics()` with no arguments at all — that is
   * `cmos-mcp --whoami`, the entry point that generated the nine false rows.
   */
  describe('s87-m05 (#1015): the no-roots warning', () => {
    it('does NOT fire when resolution SUCCEEDED and no roots were advertised', async () => {
      const result = await getWhoamiDiagnostics({
        cwdOverride: stage1Project.projectRoot,
        serverInstallRootOverride: '/mock/server-install',
        // mcpRoots OMITTED — this is the shape that reaches the guard.
      });

      expect(result.success).toBe(true);
      expect(result.data?.resolved.projectRoot).toBe(stage1Project.projectRoot);
      expect(result.data?.resolved.source).toBe('cwd');
      // THE FIX: a resolved payload no longer carries a warning saying nothing resolved.
      expect((result.warnings ?? []).join('\n')).not.toContain('No MCP roots were advertised');
    });

    it('does not fire for an explicitly EMPTY mcpRoots either', async () => {
      // `undefined` and `[]` take different halves of the `||`, so both are exercised.
      const result = await getWhoamiDiagnostics({
        mcpRoots: [],
        cwdOverride: stage1Project.projectRoot,
        serverInstallRootOverride: '/mock/server-install',
      });

      expect(result.success).toBe(true);
      expect(result.data?.resolved.projectRoot).toBe(stage1Project.projectRoot);
      expect((result.warnings ?? []).join('\n')).not.toContain('No MCP roots were advertised');
    });

    it('STILL fires when nothing resolved and no roots were advertised — the guard is not disabled', async () => {
      // The negative control. The fix must not silence a warning that is TRUE: with no roots and
      // no resolvable store, diagnosis really is limited to cwd/registry inspection.
      const result = await getWhoamiDiagnostics({
        cwdOverride: invalidRoot,
        serverInstallRootOverride: '/mock/server-install',
      });

      expect((result.warnings ?? []).join('\n')).toContain('No MCP roots were advertised');
    });

    /**
     * ANTI-VACUITY, EXPLICIT. This is what makes the arms above load-bearing rather than
     * decorative: it records that a roots-supplied test CANNOT detect this defect, in either
     * direction, so nobody later "strengthens" the suite by adding roots to the cases above and
     * quietly turns them into assertions about nothing.
     */
    it('a roots-SUPPLIED call cannot detect this defect — asserted, so the omission above is not an oversight', async () => {
      const result = await getWhoamiDiagnostics({
        mcpRoots: [stage1Project.projectRoot],
        cwdOverride: invalidRoot,
        serverInstallRootOverride: '/mock/server-install',
      });
      // Nothing resolved from cwd, yet the warning is silent — because roots were advertised.
      // Before the fix this was ALSO silent. The case is blind to the change either way.
      expect((result.warnings ?? []).join('\n')).not.toContain('No MCP roots were advertised');
    });
  });

  /**
   * s87-m05 (#1015) — THE TRUE NEGATIVE. The same one argument was ALSO dropping a real notice.
   *
   * `:560` reads `.healed` off the context it is handed. Because that was `relaxedContext` —
   * assigned only when strict resolution FAILS — the "Healed stale cmos_address" notice has been
   * silently dropped on every strict-SUCCESS path since sprint-53. And a strict success is
   * exactly when a heal is most likely: `resolveSenderContext`'s `accept()` sets `healed` on any
   * accepted candidate regardless of `requireSenderIdentity`, and `validateProject` heals by
   * default — so a store whose `cmos://unknown/*` address is rewritten to canonical is then
   * ACCEPTED by strict resolution, and said nothing about it.
   *
   * This is why the fix is "pass resolvedContext", not "rename the parameter": the rename alone
   * changes nothing, and passing the right context repairs a false positive AND a true negative.
   */
  describe('s87-m05 (#1015): the heal notice, silently dropped since sprint-53', () => {
    it('reports a heal that happened on the STRICT-success path', async () => {
      const healable = await createSeededCmosProject(
        {
          projectName: 'Healable',
          projectId: 'healable',
          slug: 'healable',
          dashboardProjectId: '11111111-2222-4333-8444-555555555555',
          // Stale on purpose: this is what the heal rewrites.
          cmosAddress: 'cmos://unknown/healable',
          owner: 'derek',
        },
        'whoami-heal-'
      );
      try {
        const result = await getWhoamiDiagnostics({
          cwdOverride: healable.projectRoot,
          serverInstallRootOverride: '/mock/server-install',
        });

        // Strict resolution SUCCEEDED — which is the whole point. The heal made the address
        // canonical, so the candidate was accepted, so `relaxedContext` was never assigned.
        expect(result.success).toBe(true);
        expect(result.data?.resolved.projectRoot).toBe(healable.projectRoot);

        const warnings = (result.warnings ?? []).join('\n');
        expect(warnings).toContain('Healed stale cmos_address');
        expect(warnings).toContain('cmos://unknown/healable');
      } finally {
        await healable.cleanup();
      }
    });
  });
});
