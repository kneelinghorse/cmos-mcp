// ABOUTME: Real SQLite fixture helper for sender-attribution and messaging tests.
// ABOUTME: Creates temp CMOS projects with seeded metadata + all three contexts rows.

/**
 * SEEDED IS NOT REALISTIC — read this before treating a fixture from here as a
 * stand-in for a real store (s86-m01, Step 5d).
 *
 * As of s86-m01 this helper models what a FRESHLY-INITED store looks like: all
 * three contexts rows present, metadata.project_type set. That closed the
 * row-PRESENCE gap which had been making decision capture fail an FK silently on
 * every fixture. It did NOT close two verified SHAPE gaps, and neither should be
 * "fixed" here:
 *
 *  1. FK SHAPE. This helper builds every fixture with `db.exec(CMOS_SCHEMA)`, and
 *     CMOS_SCHEMA declares SIX foreign keys on strategic_decisions (context_id,
 *     sprint_id, snapshot_id, author_session_id, mission_id, superseded_by). The
 *     live store carries exactly THREE — `PRAGMA foreign_key_list` returns
 *     snapshot_id, sprint_id, context_id. So a fixture ENFORCES a mission_id FK
 *     that the live store does not. Narrowing CMOS_SCHEMA to match is out of scope;
 *     the schema is the target a new store is born into.
 *
 *  2. contexts.source_path. Init writes real paths (mirrored byte-for-byte below),
 *     but the live store's master_context and project_context rows carry EMPTY
 *     source_path — only project_identity has one. Matching init is the right
 *     target for a fixture; matching one older store's history is not.
 *
 * Consequence, and the reason this note exists: any behaviour gated on a DB column
 * or query needs a positive-fire test against a tmpdir COPY of a real store, not
 * only against a fixture from here. A green fixture test does not prove the SQL
 * matches a real store's columns.
 */

import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import os from 'os';
import path from 'path';

import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { CMOS_SCHEMA } from '../../src/tools/cmos/schema';

export interface SeedCmosDbOptions {
  readonly dashboardProjectId?: string | null;
  readonly cmosAddress?: string | null;
  readonly owner?: string | null;
  readonly dashboardUsername?: string | null;
  readonly slug?: string | null;
  readonly projectName?: string;
  readonly projectId?: string;
  readonly tier?: string;
  readonly description?: string;
}

export interface SeededCmosProject {
  readonly projectRoot: string;
  readonly dbPath: string;
  cleanup: () => Promise<void>;
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

export function seedCmosDb(projectRoot: string, options: SeedCmosDbOptions = {}): string {
  const dbDir = path.join(projectRoot, 'cmos', 'db');
  fsSync.mkdirSync(dbDir, { recursive: true });

  const dbPath = path.join(dbDir, 'cmos.sqlite');
  if (fsSync.existsSync(dbPath)) {
    fsSync.unlinkSync(dbPath);
  }

  const projectName = options.projectName ?? options.slug ?? 'test-project';
  const projectSlug = options.slug ?? slugify(projectName);
  const projectId = options.projectId ?? projectSlug;
  const now = new Date().toISOString();

  const db = new Database(dbPath);
  db.exec(CMOS_SCHEMA);

  const upsertMetadata = db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)');
  upsertMetadata.run('project_name', projectName);
  upsertMetadata.run('project_id', projectId);
  upsertMetadata.run('dashboard_slug', projectSlug);

  // s86-m01 (5b) — make `options.tier` actually do something.
  //
  // It used to be a decoy: the value was written only into the project_identity
  // JSON blob below, while the code that resolves a project's tier — getProjectType
  // in cmos-agent-onboard.ts — reads the metadata key `project_type` (which is what
  // cmos_project(init) writes). So `seedCmosDb({tier: 'managed'})` looked like it
  // configured a tier and could not affect any read path.
  //
  // Behaviour-neutral today, and that claim is falsifiable: zero of the importing
  // test files pass `tier`, so every fixture gains project_type='build', which is
  // exactly what getProjectType already returned by default.
  const projectType = options.tier ?? 'build';
  upsertMetadata.run('project_type', projectType);

  if (options.dashboardProjectId) {
    upsertMetadata.run('dashboard_project_id', options.dashboardProjectId);
  }
  if (options.owner) {
    upsertMetadata.run('owner', options.owner);
  }
  if (options.dashboardUsername) {
    upsertMetadata.run('dashboard_username', options.dashboardUsername);
  }

  const identity = {
    project_id: projectId,
    project_name: projectName,
    cmos_address: options.cmosAddress ?? '',
    platform: 'aquex.ai',
    domain: '',
    // s86-m01 (5b): derived from the same value as metadata.project_type above,
    // instead of being hardcoded to 'build' while metadata carried nothing.
    project_type: projectType,
    tier: projectType,
    status: 'active_development',
    description: options.description ?? '',
    objectives: [],
    related_projects: [],
    foundational_docs: [],
    tracelab_refs: [],
    type_fields: {},
    identity_contract_version: 'v1',
    created_at: now,
    updated_at: now,
  };

  const upsertContext = db.prepare(
    `INSERT OR REPLACE INTO contexts (id, source_path, content, updated_at)
     VALUES (?, ?, ?, ?)`
  );
  upsertContext.run(
    'project_identity',
    'cmos/contexts/project-identity.json',
    JSON.stringify(identity),
    now
  );

  // s86-m01 (5a) — a real store carries THREE contexts rows; this fixture used to
  // write only project_identity, and the omission failed QUIETLY.
  //
  // strategic_decisions.context_id is `NOT NULL DEFAULT 'master_context'` with a FK
  // to contexts(id), and the client turns FK enforcement ON at connection open. So
  // on every seeded fixture, decision capture violated that FK and the handler
  // still returned success:true with decisionExtractionCount 0 — measured before
  // this change: capture succeeded, extraction count 0, `SELECT COUNT(*) FROM
  // strategic_decisions` 0. Three test files had each grown their own local
  // workaround for it; all three are deleted now that the helper is honest.
  //
  // source_path values are byte-identical to what cmos_project(init) writes
  // (cmos-project-init.ts) — deliberately NOT the 'cmos/contexts/master-context.json'
  // spelling the deleted workarounds used, which would have baked in a second,
  // quieter fidelity gap.
  //
  // content '{}' is load-bearing and verified behaviour-neutral on both readers:
  // detectFreshProject lowercases master_context content and looks for
  // 'project brief'/'project_brief' — '{}' has neither, so it still returns true,
  // identical to the row being absent; and project-identity.ts reads `tier` out of
  // project_context, where JSON.parse('{}')['tier'] is undefined, so tier stays
  // 'build'. There is deliberately NO opt-out flag: an opt-in recreates exactly the
  // two-worlds problem that produced this bug.
  upsertContext.run('project_context', 'cmos/context/project_context.json', '{}', now);
  upsertContext.run('master_context', 'cmos/context/master_context.json', '{}', now);

  db.close();
  CmosDetector.resetInstance();
  return dbPath;
}

/**
 * Give an independently-writable test store its own durable project identity.
 *
 * Real-store tests copy one source database into several temp project roots. Those copies are
 * separate projects for the duration of the test, so retaining the source project_id would model
 * an invalid state: two live stores claiming one identity. Keep metadata and the canonical
 * project_identity context aligned; historical provenance rows deliberately remain historical.
 */
export function reidentifyCmosTestStore(
  projectRoot: string,
  projectId = `test-${path.basename(path.resolve(projectRoot))}`
): string {
  const dbPath = path.join(projectRoot, 'cmos', 'db', 'cmos.sqlite');
  const db = new Database(dbPath);
  try {
    db.transaction(() => {
      db.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', ?)`).run(
        projectId
      );

      const context = db
        .prepare(`SELECT content FROM contexts WHERE id = 'project_identity'`)
        .get() as { content: string } | undefined;
      if (context) {
        const parsed = JSON.parse(context.content) as Record<string, unknown>;
        parsed.project_id = projectId;
        parsed.updated_at = new Date().toISOString();
        db.prepare(
          `UPDATE contexts SET content = ?, updated_at = ? WHERE id = 'project_identity'`
        ).run(JSON.stringify(parsed), parsed.updated_at);
      }
    })();
  } finally {
    db.close();
  }
  CmosDetector.resetInstance();
  return projectId;
}

export async function createSeededCmosProject(
  options: SeedCmosDbOptions = {},
  prefix = 'cmos-seeded-'
): Promise<SeededCmosProject> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const dbPath = seedCmosDb(projectRoot, options);

  return {
    projectRoot,
    dbPath,
    cleanup: () => fs.rm(projectRoot, { recursive: true, force: true }),
  };
}
