// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Keeps every dependency-ordering surface aligned with the transition paths that exist.
// ABOUTME: Preserves the six historical s85-m05 edges that prove dependency order is not enforced.

import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from '@jest/globals';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { createSeededCmosProject } from '../../helpers/seedCmosDb';
import {
  cmosMissionDependsSchema,
  cmosMissionDependsToolDefinition,
} from '../../../src/tools/cmos/cmos-mission-depends';
import {
  cmosMission,
  cmosMissionSchema,
  cmosMissionToolDefinition,
} from '../../../src/tools/cmos/cmos-mission';
import { cmosMissionTransition } from '../../../src/tools/cmos/cmos-mission-transition';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const TOOL_REFERENCE_PATH = path.join(REPO_ROOT, 'TOOL_REFERENCE.md');
const PRIVATE = requiresPrivateEvidence({
  reason: 'private dependency documentation, CLI, and historical edge store',
  paths: {
    liveDb: 'cmos/db/cmos.sqlite',
    buildSessionPrompt: 'cmos/docs/build-session-prompt.md',
    cli: 'cmos/cli.py',
  },
});

const EXPECTED_DISCLOSURE =
  'Dependency relationships are recorded for ordering and graph expansion; they are not enforced at mission start or completion.';
const FALSE_ENFORCEMENT_PROMISE =
  /blocks .+ from starting|requires .+ completed first|enables .+ proceed|stays queued\/blocked until/i;

const ENFORCEMENT_ENTRYPOINTS = [
  'src/tools/cmos/cmos-mission-start.ts',
  'src/tools/cmos/cmos-mission-transition.ts',
  'src/tools/cmos/cmos-mission-status.ts',
  'src/tools/cmos/cmos-mission-complete.ts',
] as const;

function readEntrypoints(): Readonly<Record<string, string>> {
  return Object.fromEntries(
    ENFORCEMENT_ENTRYPOINTS.map((file) => [
      file,
      fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'),
    ])
  );
}

/**
 * This deliberately treats any dependency-named code in the four lifecycle entrypoints as a
 * review signal, not as proof of enforcement. A future implementation may call a helper rather
 * than query mission_dependencies directly, so limiting the gate to SQL would miss the likely
 * shape. A neutral helper name can still evade this bounded scan; that false-negative profile is
 * why the entrypoint list and token rule live beside the assertion rather than behind a generic
 * repository search.
 */
function dependencyContractFindings(
  disclosure: string,
  entrypoints: Readonly<Record<string, string>>
): string[] {
  const dependencySignal =
    /\bmission_dependencies\b|\bdepend(?:s|ed|ing|ent|ents|ence|ency|encies)?\b/i;
  const filesWithSignals = Object.entries(entrypoints)
    .filter(([, source]) => dependencySignal.test(source))
    .map(([file]) => file)
    .sort();
  const saysNotEnforced = disclosure.includes('not enforced at mission start or completion');
  const findings: string[] = [];

  if (filesWithSignals.length > 0 && saysNotEnforced) {
    findings.push(
      `dependency signal found in ${filesWithSignals.join(', ')} while disclosure still says not enforced`
    );
  }
  if (filesWithSignals.length === 0 && !saysNotEnforced) {
    findings.push('no dependency signal found, but disclosure no longer says not enforced');
  }
  return findings;
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('s88-m06 dependency-ordering contract', () => {
  it('publishes one recorded-not-enforced disclosure on every definition surface', () => {
    const surfaces = [
      cmosMissionDependsSchema.shape.type.description,
      cmosMissionDependsToolDefinition.description,
      cmosMissionDependsToolDefinition.inputSchema.properties.type.description,
      cmosMissionSchema.shape.type.description,
      cmosMissionToolDefinition.inputSchema.properties.type.description,
      fs.readFileSync(TOOL_REFERENCE_PATH, 'utf8'),
    ];

    for (const surface of surfaces) {
      expect(surface).toContain(EXPECTED_DISCLOSURE);
      expect(surface).not.toMatch(FALSE_ENFORCEMENT_PROMISE);
    }
  });

  it('proves all three labels remain record-only through the registered lifecycle routers', async () => {
    const project = await createSeededCmosProject({}, 'dependency-contract-');
    try {
      const db = new Database(project.dbPath);
      db.exec(`
        INSERT INTO sprints (id, title, status)
        VALUES ('dependency-sprint', 'Dependency contract', 'Active');

        INSERT INTO missions (id, sprint_id, name, status)
        VALUES
          ('blocker', 'dependency-sprint', 'Blocker', 'Queued'),
          ('blocked', 'dependency-sprint', 'Supposedly blocked', 'Queued'),
          ('dependent', 'dependency-sprint', 'Requires dropped prerequisite', 'In Progress'),
          ('dropped-prerequisite', 'dependency-sprint', 'Dropped prerequisite', 'Dropped'),
          ('dropped-enabler', 'dependency-sprint', 'Dropped enabler', 'Dropped'),
          ('supposedly-enabled', 'dependency-sprint', 'Supposedly enabled', 'Queued');
      `);
      db.close();

      const dependencies = [
        ['blocker', 'blocked', 'Blocks'],
        ['dependent', 'dropped-prerequisite', 'Requires'],
        ['dropped-enabler', 'supposedly-enabled', 'Enables'],
      ] as const;
      for (const [fromId, toId, type] of dependencies) {
        const result = await cmosMission({
          action: 'depends',
          fromId,
          toId,
          type,
          projectRoot: project.projectRoot,
        });
        expect(result.success).toBe(true);
        expect(result.data).toMatchObject({ fromId, toId, type });
      }

      expect(
        (
          await cmosMissionTransition({
            action: 'start',
            missionId: 'blocked',
            projectRoot: project.projectRoot,
          })
        ).success
      ).toBe(true);
      expect(
        (
          await cmosMissionTransition({
            action: 'complete',
            missionId: 'dependent',
            notes: 'The recorded Requires edge is intentionally not a completion gate.',
            projectRoot: project.projectRoot,
          })
        ).success
      ).toBe(true);
      expect(
        (
          await cmosMissionTransition({
            action: 'start',
            missionId: 'supposedly-enabled',
            projectRoot: project.projectRoot,
          })
        ).success
      ).toBe(true);

      const verificationDb = new Database(project.dbPath, { readonly: true });
      const statuses = verificationDb
        .prepare(
          `SELECT id, status
             FROM missions
            WHERE id IN ('blocked', 'dependent', 'supposedly-enabled')
            ORDER BY id`
        )
        .all();
      const edgeCount = (
        verificationDb.prepare('SELECT COUNT(*) AS count FROM mission_dependencies').get() as {
          count: number;
        }
      ).count;
      verificationDb.close();

      expect(statuses).toEqual([
        { id: 'blocked', status: 'In Progress' },
        { id: 'dependent', status: 'Completed' },
        { id: 'supposedly-enabled', status: 'In Progress' },
      ]);
      expect(edgeCount).toBe(3);
    } finally {
      await project.cleanup();
    }
  });

  it('removes all three labels without turning their names into operational claims', async () => {
    const project = await createSeededCmosProject({}, 'dependency-removal-contract-');
    try {
      const db = new Database(project.dbPath);
      db.exec(`
        INSERT INTO sprints (id, title, status)
        VALUES ('removal-sprint', 'Dependency removal contract', 'Active');

        INSERT INTO missions (id, sprint_id, name, status)
        VALUES
          ('blocks-from', 'removal-sprint', 'Blocks source', 'Queued'),
          ('blocks-to', 'removal-sprint', 'Blocks target', 'Queued'),
          ('requires-from', 'removal-sprint', 'Requires source', 'Queued'),
          ('requires-to', 'removal-sprint', 'Requires target', 'Queued'),
          ('enables-from', 'removal-sprint', 'Enables source', 'Queued'),
          ('enables-to', 'removal-sprint', 'Enables target', 'Queued');
      `);
      db.close();

      const dependencies = [
        ['blocks-from', 'blocks-to', 'Blocks'],
        ['requires-from', 'requires-to', 'Requires'],
        ['enables-from', 'enables-to', 'Enables'],
      ] as const;
      for (const [fromId, toId, type] of dependencies) {
        expect(
          (
            await cmosMission({
              action: 'depends',
              fromId,
              toId,
              type,
              projectRoot: project.projectRoot,
            })
          ).success
        ).toBe(true);

        const removal = await cmosMission({
          action: 'undepends',
          fromId,
          toId,
          projectRoot: project.projectRoot,
        });
        expect(removal.success).toBe(true);
        expect(removal.data).toMatchObject({
          fromId,
          toId,
          message: `Removed ${type} dependency: '${fromId}' -> '${toId}'. ${EXPECTED_DISCLOSURE}`,
        });
        expect(removal.data).not.toMatchObject({
          message: expect.stringMatching(/\bno longer (?:blocks|requires|enables)\b/i),
        });
      }

      const verificationDb = new Database(project.dbPath, { readonly: true });
      const edgeCount = (
        verificationDb.prepare('SELECT COUNT(*) AS count FROM mission_dependencies').get() as {
          count: number;
        }
      ).count;
      verificationDb.close();
      expect(edgeCount).toBe(0);
    } finally {
      await project.cleanup();
    }
  });

  it('keeps not-enforced wording consistent with the four dependency-free lifecycle entrypoints', () => {
    expect(dependencyContractFindings(EXPECTED_DISCLOSURE, readEntrypoints())).toEqual([]);
  });

  it('is falsifiable in both directions', () => {
    expect(
      dependencyContractFindings(EXPECTED_DISCLOSURE, {
        'cmos-mission-complete.ts': 'SELECT * FROM mission_dependencies WHERE from_id = ?',
      })
    ).toEqual([
      'dependency signal found in cmos-mission-complete.ts while disclosure still says not enforced',
    ]);
    expect(
      dependencyContractFindings('Dependency ordering is enforced at completion.', {
        'cmos-mission-complete.ts': 'export const completeMission = () => undefined;',
      })
    ).toEqual(['no dependency signal found, but disclosure no longer says not enforced']);
  });

  it('keeps the three private evidence inputs together or visibly scopes them out', () => {
    expect([0, Object.keys(PRIVATE.relativePaths).length]).toContain(
      PRIVATE.availableRelativePaths.length
    );
  });
});

PRIVATE.describe('s88-m06 private dependency evidence', () => {
  it('corrects the active build-session prompt rather than promising a queue gate', () => {
    const prompt = fs.readFileSync(PRIVATE.paths.buildSessionPrompt, 'utf8');
    expect(prompt).toContain(EXPECTED_DISCLOSURE);
    expect(prompt).not.toMatch(FALSE_ENFORCEMENT_PROMISE);
  });

  it('keeps the private CLI help and receipt honest about recorded-only relationships', () => {
    const cli = fs.readFileSync(PRIVATE.paths.cli, 'utf8');
    expect(cli).toContain(EXPECTED_DISCLOSURE);
    expect(cli).not.toContain('help="Mission that blocks another"');
    expect(cli).not.toContain('help="Mission that is blocked"');
  });

  it('retains exactly the six s85-m05 Requires edges and their historical statuses', async () => {
    const hashBefore = sha256(PRIVATE.paths.liveDb);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-evidence-'));
    const copyPath = path.join(tempDir, 'cmos.sqlite');
    const source = new Database(PRIVATE.paths.liveDb, { readonly: true, fileMustExist: true });
    try {
      await source.backup(copyPath);
    } finally {
      source.close();
    }

    try {
      const db = new Database(copyPath, { readonly: true, fileMustExist: true });
      const rows = db
        .prepare(
          `SELECT d.from_id AS fromId,
                  d.to_id AS toId,
                  d.type,
                  m.status AS prerequisiteStatus
             FROM mission_dependencies d
             JOIN missions m ON m.id = d.to_id
            WHERE d.from_id = 's85-m05'
            ORDER BY d.to_id`
        )
        .all();
      db.close();

      expect(rows).toEqual([
        { fromId: 's85-m05', toId: 's85-m03', type: 'Requires', prerequisiteStatus: 'Completed' },
        { fromId: 's85-m05', toId: 's85-m04', type: 'Requires', prerequisiteStatus: 'Completed' },
        { fromId: 's85-m05', toId: 's85-m06', type: 'Requires', prerequisiteStatus: 'Dropped' },
        { fromId: 's85-m05', toId: 's85-m07', type: 'Requires', prerequisiteStatus: 'Dropped' },
        { fromId: 's85-m05', toId: 's85-m08', type: 'Requires', prerequisiteStatus: 'Dropped' },
        { fromId: 's85-m05', toId: 's85-m09', type: 'Requires', prerequisiteStatus: 'Dropped' },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    expect(sha256(PRIVATE.paths.liveDb)).toBe(hashBefore);
  });
});
