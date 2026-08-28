// SPDX-License-Identifier: Apache-2.0
// ABOUTME: OC-1 — restamp firehose rows that carry the `unknown-project` sentinel with the
// ABOUTME: identity their own store records. Dry-run by default; --apply snapshots first.

/**
 * OC-1 (sprint 87, carried out of m04) — THE ROWS THE DISCLOSURE ONLY NAMED.
 *
 * s87-m04 made the "no recorded project identity" warning name its store instead of firing once
 * per process. That is a DISCLOSURE fix: it tells an operator which store collapsed, and heals
 * nothing. `derekn.com` carries 217 rows stamped with the literal `'unknown-project'` — written
 * before its `metadata.project_id` existed — and those rows stay wrong until something rewrites
 * them. This script is that something.
 *
 * WHY IT IS NOT PART OF ANY TOOL. The rewrite is a bulk UPDATE across eight tables of a store the
 * running server does not own, and its correct target is knowable only from that store's own
 * metadata. Shipping it as a tool action would put a fleet-wide rewrite one typo away from any
 * agent; shipping it as an operator script keeps the blast radius where the decision is made.
 * `scripts/` is not in package.json's `files[]`, so this does not ship to npm.
 *
 * THE DIVERGENCE THIS MAY CREATE, stated up front because it is the reason OC-1 was an operator
 * call rather than a build step. `derekn.com`'s `backfill_cursor` advanced PAST the collapse, so
 * the mis-stamped rows were probably already replicated to the dashboard's Postgres mirror. A
 * local-only repair therefore makes local and remote disagree about `project_id` for those rows.
 * The script tries to observe the mirror before writing and prints what it learned; per the
 * operator's standing instruction it proceeds even when the mirror cannot be reached, because a
 * store that stays wrong locally is the worse of the two failures — and an unreachable dashboard
 * is not evidence of anything. What it must never do is proceed SILENTLY: the accepted divergence
 * is printed, and is recorded in the sprint close.
 *
 * SAFETY. Dry-run is the default; `--apply` is required to write. Before any write it takes a
 * real snapshot via better-sqlite3's online backup (not a `cp`, which is unsafe against a WAL
 * store with a live sidecar) and prints the path. The UPDATEs run in one transaction, and the
 * script re-counts afterwards and exits non-zero if any sentinel row survives.
 *
 * USAGE
 *   npx ts-node scripts/repair-unknown-project.ts --store <path>            # dry run
 *   npx ts-node scripts/repair-unknown-project.ts --store <path> --apply
 *   … --project-id <id>   override the identity (default: the store's own metadata.project_id)
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

/** The 8 firehose tables (agents.md §"firehose"), each carrying a per-row `project_id`. */
const FIREHOSE_TABLES = [
  'strategic_decisions',
  'learnings',
  'missions',
  'sprints',
  'sessions',
  'next_steps',
  'constraints',
  'context_snapshots',
] as const;

/**
 * The sentinels. `''` is included alongside the literal because `genesisColumns` reaches the
 * fallback on an absent OR empty value, and s87-m04 deleted three empty-string identity rows from
 * the shipped seed — so both spellings of "no identity" exist in the wild.
 */
const SENTINELS = ['unknown-project', ''] as const;

export interface TableCount {
  table: string;
  rows: number;
}

export interface RepairPlan {
  storeRoot: string;
  dbPath: string;
  /** The identity the store records for itself — the value the rows will be restamped to. */
  targetProjectId: string;
  counts: TableCount[];
  total: number;
}

function fail(message: string): never {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

export function storeDbPath(storeRoot: string): string {
  return path.join(storeRoot, 'cmos', 'db', 'cmos.sqlite');
}

function hasTable(db: Database.Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function hasProjectIdColumn(db: Database.Database, table: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === 'project_id');
}

const SENTINEL_WHERE = `project_id IN (${SENTINELS.map(() => '?').join(', ')})`;

/**
 * Count the sentinel rows per table and resolve the target identity.
 *
 * READ-ONLY. Building the plan must never write, because the dry run exists precisely so an
 * operator can look before anything happens.
 */
export function buildPlan(storeRoot: string, projectIdOverride?: string): RepairPlan {
  const dbPath = storeDbPath(storeRoot);
  if (!fs.existsSync(dbPath)) fail(`no CMOS store at ${dbPath}`);

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    let targetProjectId = projectIdOverride ?? '';
    if (!targetProjectId) {
      if (!hasTable(db, 'metadata')) fail(`${dbPath} has no metadata table; pass --project-id`);
      const row = db.prepare("SELECT value FROM metadata WHERE key = 'project_id'").get() as
        | { value: string }
        | undefined;
      targetProjectId = (row?.value ?? '').trim();
    }
    // The whole point is to replace a sentinel with a real identity. Restamping rows to the same
    // sentinel would be a no-op reported as a repair — this sprint's defect, in a repair script.
    if (!targetProjectId || (SENTINELS as readonly string[]).includes(targetProjectId)) {
      fail(
        `${dbPath} records no usable project identity (metadata.project_id = ` +
          `${JSON.stringify(targetProjectId)}). Set it first, or pass --project-id explicitly. ` +
          `Restamping rows to the sentinel would report a repair that did not happen.`
      );
    }

    const counts: TableCount[] = [];
    for (const table of FIREHOSE_TABLES) {
      if (!hasTable(db, table) || !hasProjectIdColumn(db, table)) continue;
      const { c } = db
        .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${SENTINEL_WHERE}`)
        .get(...SENTINELS) as { c: number };
      if (c > 0) counts.push({ table, rows: c });
    }
    return {
      storeRoot,
      dbPath,
      targetProjectId,
      counts,
      total: counts.reduce((a, b) => a + b.rows, 0),
    };
  } finally {
    db.close();
  }
}

/**
 * Snapshot via SQLite's ONLINE BACKUP, not a file copy.
 *
 * A `cp` of a WAL database without its `-wal` sidecar silently drops every committed transaction
 * still in that sidecar; the copy opens fine and is quietly short. `db.backup()` reads through the
 * WAL and produces a consistent single file. Returns the snapshot path.
 */
export async function snapshotStore(dbPath: string, stampIso: string): Promise<string> {
  const stamp = stampIso.replace(/[:.]/g, '').replace(/-/g, '');
  const dest = `${dbPath}.pre-oc1-${stamp}.bak`;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
    fail(`snapshot at ${dest} is missing or empty — refusing to write`);
  }
  return dest;
}

/** Apply the plan in ONE transaction, then re-count. Returns rows actually changed per table. */
export function applyPlan(plan: RepairPlan): TableCount[] {
  const db = new Database(plan.dbPath, { fileMustExist: true });
  try {
    const changed: TableCount[] = [];
    const run = db.transaction(() => {
      for (const { table } of plan.counts) {
        const info = db
          .prepare(`UPDATE ${table} SET project_id = ? WHERE ${SENTINEL_WHERE}`)
          .run(plan.targetProjectId, ...SENTINELS);
        changed.push({ table, rows: info.changes });
      }
    });
    run();

    // Re-count under the SAME predicate. `changes` is what the statement reported; this is what
    // the database now holds, and only the second one is evidence.
    let survivors = 0;
    for (const { table } of plan.counts) {
      const { c } = db
        .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${SENTINEL_WHERE}`)
        .get(...SENTINELS) as { c: number };
      survivors += c;
    }
    if (survivors > 0) fail(`${survivors} sentinel row(s) survived the repair — store not clean`);
    return changed;
  } finally {
    db.close();
  }
}

/**
 * Try to observe the dashboard's mirror before writing.
 *
 * Best-effort BY DESIGN, and the result never blocks: an unreachable dashboard is not evidence
 * about the mirror's contents. What it buys is that when the dashboard IS reachable, the operator
 * sees the replica's own numbers next to the divergence they are about to accept.
 */
async function probeDashboard(storeRoot: string): Promise<string> {
  try {
    const { DashboardClient } = await import('../src/tools/cmos/dashboard-client');
    const resolved = await DashboardClient.fromEnvForProject(storeRoot);
    if (!resolved.success || !resolved.data) {
      return `unreachable — no dashboard client resolved (${resolved.error?.message ?? 'no client'})`;
    }
    const status = await resolved.data.client.getSyncStatus();
    if (!status.success || !status.data) {
      return `unreachable — ${status.error?.message ?? 'sync status call failed'}`;
    }
    const d = status.data;
    return `reachable — mirror holds ${d.totalMirrorRows} rows across ${d.projectCount} project(s); last sync ${d.lastSyncAt ?? 'never'}`;
  } catch (e) {
    return `unreachable — ${(e as Error).message}`;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const storeRoot = arg('--store');
  const apply = argv.includes('--apply');
  const projectIdOverride = arg('--project-id');
  if (!storeRoot)
    fail('usage: repair-unknown-project.ts --store <path> [--project-id <id>] [--apply]');

  const plan = buildPlan(path.resolve(storeRoot), projectIdOverride);
  console.log(`\nOC-1 repair — ${plan.dbPath}`);
  console.log(`  target project_id: ${JSON.stringify(plan.targetProjectId)}`);
  if (plan.total === 0) {
    console.log('  nothing to repair: no row carries a sentinel identity.');
    return;
  }
  console.log(`  sentinel rows: ${plan.total}`);
  for (const c of plan.counts) console.log(`     ${c.table}: ${c.rows}`);

  if (!apply) {
    console.log('\n  DRY RUN — nothing was written. Re-run with --apply to repair.');
    return;
  }

  const replica = await probeDashboard(plan.storeRoot);
  console.log(`\n  dashboard mirror: ${replica}`);
  console.log(
    '  ACCEPTED DIVERGENCE: these rows were probably already replicated with the sentinel. ' +
      'This repair is local-only; local and mirror will disagree on project_id until the ' +
      'dashboard is re-backfilled for this project.'
  );

  const snapshot = await snapshotStore(plan.dbPath, new Date().toISOString());
  console.log(`  snapshot: ${snapshot}`);

  const changed = applyPlan(plan);
  const total = changed.reduce((a, b) => a + b.rows, 0);
  console.log(`\n  repaired ${total} row(s):`);
  for (const c of changed) console.log(`     ${c.table}: ${c.rows}`);
  console.log('  re-counted after commit: 0 sentinel rows remain.');
}

if (require.main === module) {
  void main().catch((e) => fail((e as Error).stack ?? String(e)));
}
