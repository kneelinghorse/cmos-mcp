// ABOUTME: Real-DB integration coverage for cmos_message(action="whoami") diagnostics.
// ABOUTME: Verifies candidate traces include rejected and accepted roots in precedence order.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { formatMessageForLLM, getWhoamiDiagnostics } from '../../src/tools/cmos/cmos-message';
import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { resolveSenderContext } from '../../src/intelligence/sender-context';
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

  it('shows an explicit non-CMOS root as final: rejected, with no other project consulted', async () => {
    // s92-m01: an explicit projectRoot is never swapped for an MCP root or the cwd project.
    const result = await getWhoamiDiagnostics({
      explicitProjectRoot: invalidRoot,
      mcpRoots: [stage1Project.projectRoot],
      cwdOverride: '/tmp/no-cmos-here',
      serverInstallRootOverride: '/mock/server-install',
    });

    expect(result.success).toBe(false);
    expect(result.data?.resolved.projectRoot).toBeNull();
    expect(result.data?.candidates).toEqual([
      expect.objectContaining({
        source: 'explicit',
        accepted: false,
        rejectReason: expect.stringMatching(/no CMOS database/i),
      }),
    ]);

    const formatted = formatMessageForLLM('whoami', result);
    expect(formatted).toContain('Candidate trace:');
    expect(formatted).toContain('✗ explicit');
    expect(formatted).not.toContain('mcp-roots');
  });

  it('returns a full candidate trace showing a skipped store-less MCP root and the accepted one', async () => {
    const result = await getWhoamiDiagnostics({
      mcpRoots: [invalidRoot, stage1Project.projectRoot],
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
    expect(result.data?.candidates).toEqual([
      expect.objectContaining({
        source: 'mcp-roots',
        accepted: false,
        projectRoot: path.resolve(invalidRoot),
        rejectReason: expect.stringMatching(/no CMOS database/i),
      }),
      expect.objectContaining({
        source: 'mcp-roots',
        accepted: true,
        projectRoot: path.resolve(stage1Project.projectRoot),
      }),
    ]);

    const formatted = formatMessageForLLM('whoami', result);
    expect(formatted).toContain('✗ mcp-roots');
    expect(formatted).toContain('✓ mcp-roots');
  });

  it('s92-m01: shows the registry default, says it is not applied, and names the re-confirm call', async () => {
    const configDir = await makeTempDir('whoami-default-cfg-');
    const savedConfigDir = process.env.CMOS_CONFIG_DIR;
    process.env.CMOS_CONFIG_DIR = configDir;
    ProjectGraphRegistry.resetInstance();
    try {
      const registry = await ProjectGraphRegistry.create({ configDir });
      const entry = registry.registerStore(stage1Project.projectRoot);
      registry.setDefault(entry.project_id); // the pre-3.2.0 way: never confirmed

      const result = await getWhoamiDiagnostics({
        mcpRoots: [stage1Project.projectRoot],
        cwdOverride: '/tmp/no-cmos-here',
        serverInstallRootOverride: '/mock/server-install',
      });

      expect(result.data?.registryDefault).toMatchObject({
        projectId: 'stage1',
        storePath: path.resolve(stage1Project.projectRoot),
        applied: false,
      });
      expect(result.data?.serverProjectRoot).toBeNull();
      expect(result.warnings).toContainEqual(
        `registry default: Stage1 — not applied; re-run setAsDefault to enable: cmos_project(action="register", projectRoot=${JSON.stringify(path.resolve(stage1Project.projectRoot))}, setAsDefault=true)`
      );
      expect(formatMessageForLLM('whoami', result)).toContain(
        'Registry default: Stage1 (not applied)'
      );
    } finally {
      ProjectGraphRegistry.resetInstance();
      if (savedConfigDir === undefined) delete process.env.CMOS_CONFIG_DIR;
      else process.env.CMOS_CONFIG_DIR = savedConfigDir;
      await fs.rm(configDir, { recursive: true, force: true });
    }
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
    it('reports the repair a send would make, on the STRICT-success path, without making it', async () => {
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

        // Strict resolution SUCCEEDED — which is the whole point. s93-m11: whoami is a diagnostic
        // and writes nothing, so it resolves with the address the next write would store (a send
        // repairs it before resolving), and the notice says that repair is still to come.
        expect(result.success).toBe(true);
        expect(result.data?.resolved.projectRoot).toBe(healable.projectRoot);
        expect(result.data?.wouldAttributeAs.senderAddress).toBe('cmos://derek/healable');

        const warnings = (result.warnings ?? []).join('\n');
        expect(warnings).toContain(
          'Stale cmos_address cmos://unknown/healable: the next write repairs it to cmos://derek/healable'
        );
        expect(warnings).not.toContain('fail-closed');

        // ...and the store still holds the stale address: whoami repaired nothing.
        const db = new Database(path.join(healable.projectRoot, 'cmos', 'db', 'cmos.sqlite'), {
          readonly: true,
        });
        try {
          const row = db
            .prepare("SELECT content FROM contexts WHERE id = 'project_identity'")
            .get() as { content: string };
          expect(JSON.parse(row.content).cmos_address).toBe('cmos://unknown/healable');
        } finally {
          db.close();
        }
      } finally {
        await healable.cleanup();
      }
    });
  });
});

describe('s93-m11 — diagnostics outside a dispatched call write nothing', () => {
  // The confirming critic: whoami from the CLI and the startup lines run with no call context, where
  // callMayWrite() is true, and validation seeded a missing project_identity row.
  it('whoami and a startup resolution leave a store with no identity row as they found it', async () => {
    const project = await createSeededCmosProject(
      {
        projectName: 'Rowless',
        projectId: 'rowless',
        slug: 'rowless',
        dashboardProjectId: '11111111-2222-4333-8444-555555555555',
        owner: 'derek',
      },
      'whoami-rowless-'
    );
    const dbPath = path.join(project.projectRoot, 'cmos', 'db', 'cmos.sqlite');
    const rows = (): number => {
      const db = new Database(dbPath, { readonly: true });
      try {
        return (
          db.prepare("SELECT COUNT(*) AS n FROM contexts WHERE id = 'project_identity'").get() as {
            n: number;
          }
        ).n;
      } finally {
        db.close();
      }
    };
    try {
      const db = new Database(dbPath);
      try {
        db.prepare("DELETE FROM contexts WHERE id = 'project_identity'").run();
      } finally {
        db.close();
      }

      await getWhoamiDiagnostics({
        cwdOverride: project.projectRoot,
        serverInstallRootOverride: '/mock/server-install',
      });
      expect(rows()).toBe(0);

      const startup = await resolveSenderContext({
        requireSenderIdentity: false,
        heal: 'preview',
        cwdOverride: project.projectRoot,
        serverInstallRootOverride: '/mock/server-install',
      });
      expect(startup.projectRoot).toBe(project.projectRoot);
      expect(rows()).toBe(0);
    } finally {
      await project.cleanup();
    }
  });
});
