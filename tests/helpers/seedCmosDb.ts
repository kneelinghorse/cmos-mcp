// ABOUTME: Real SQLite fixture helper for sender-attribution and messaging tests.
// ABOUTME: Creates temp CMOS projects with seeded metadata + project_identity rows.

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
    project_type: 'build',
    tier: options.tier ?? 'build',
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

  db.prepare(
    `INSERT OR REPLACE INTO contexts (id, source_path, content, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run('project_identity', 'cmos/contexts/project-identity.json', JSON.stringify(identity), now);

  db.close();
  CmosDetector.resetInstance();
  return dbPath;
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
