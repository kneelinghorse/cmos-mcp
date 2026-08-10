// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s84-m04 (#478) — CLI to prune context_snapshots content (the ~99%/31.9MB write-only
// ABOUTME: audit blob). Dry-run by DEFAULT; --apply mutates. Content-tombstone unless --hard.

import { withClientAsync } from '../src/tools/cmos/client';
import { createError, createSuccess } from '../src/tools/cmos/errors';
import { tableHasColumn } from '../src/tools/cmos/genesis-columns';
import { ensureContentPrunedColumn } from '../src/tools/cmos/schema-migrations';
import {
  selectSnapshotsToPrune,
  resolveKeepN,
  type SnapshotRow,
  type PruneSelection,
} from '../src/tools/cmos/context-snapshot-prune';

interface Args {
  apply: boolean;
  hard: boolean;
  keep?: number;
  days: number;
  projectRoot?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, hard: false, days: 0 };
  for (const a of argv) {
    if (a === '--apply') args.apply = true;
    else if (a === '--hard') args.hard = true;
    else if (a.startsWith('--keep=')) args.keep = Number(a.slice('--keep='.length));
    else if (a.startsWith('--days=')) args.days = Number(a.slice('--days='.length));
    else if (a.startsWith('--projectRoot=')) args.projectRoot = a.slice('--projectRoot='.length);
  }
  return args;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

interface PruneReport {
  selection: PruneSelection;
  applied: number;
  hard: boolean;
  rowCount: number;
  totalContentBytes: number;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const keepN = resolveKeepN(args.keep, process.env['CMOS_SNAPSHOT_PRUNE_KEEP']);

  const result = await withClientAsync<PruneReport>(
    async (client) => {
      // DRY-RUN is strictly read-only: guard the content_pruned_at read so a store predating
      // the column is NOT altered just to preview. The migration (ALTER ADD COLUMN) is deferred
      // to the --apply path, which lands the column before any write filters on it (Hardening #4).
      const prunedExpr = tableHasColumn(client, 'context_snapshots', 'content_pruned_at')
        ? 'content_pruned_at'
        : 'NULL AS content_pruned_at';

      const rowsRes = client.getMany<{
        id: number;
        context_id: string;
        source: string | null;
        created_at: string;
        content_len: number;
        content_pruned_at: string | null;
      }>(
        `SELECT id, context_id, source, created_at, LENGTH(content) AS content_len, ${prunedExpr}
         FROM context_snapshots`,
        []
      );
      if (!rowsRes.success) {
        return createError<PruneReport>(
          rowsRes.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to read context_snapshots' }
        );
      }
      const rows: SnapshotRow[] = (rowsRes.data ?? []).map((r) => ({
        id: r.id,
        contextId: r.context_id,
        source: r.source,
        createdAt: r.created_at,
        contentLength: r.content_len,
        contentPrunedAt: r.content_pruned_at,
      }));
      const totalContentBytes = rows.reduce((s, r) => s + r.contentLength, 0);

      // Live FK set — NEVER hardcode; a decision's snapshot_id keeps that row's content.
      const fkRes = client.getMany<{ snapshot_id: number }>(
        `SELECT DISTINCT snapshot_id FROM strategic_decisions WHERE snapshot_id IS NOT NULL`,
        []
      );
      // FAIL CLOSED (m04 review): the FK set is the ONLY thing keeping a decision-referenced
      // snapshot's content (and, under --hard, its row + the decision's FK link) from being
      // reclaimed. A silent empty-set fallback on a failed read would drop ALL FK protection
      // and irreversibly prune an audit-referenced snapshot — so abort rather than under-protect.
      // (A missing strategic_decisions table / snapshot_id column is a legitimate empty set —
      // no refs can exist there; only a real read failure on a store that HAS refs is dangerous.
      // The client wraps a missing table as "Table 'X' does not exist" and SQLite raw as
      // "no such table/column" — accept BOTH phrasings as structural absence.)
      if (
        !fkRes.success &&
        !/does not exist|no such (table|column)/i.test(fkRes.error?.message ?? '')
      ) {
        return createError<PruneReport>(
          fkRes.error ?? {
            code: 'DB_QUERY_FAILED',
            message: 'Failed to read the live snapshot FK set (strategic_decisions.snapshot_id)',
          }
        );
      }
      const fkIds = new Set<number>((fkRes.data ?? []).map((r) => r.snapshot_id));

      const selection = selectSnapshotsToPrune(rows, fkIds, {
        keepPerContext: keepN,
        days: args.days,
        nowMs: Date.now(),
      });

      let applied = 0;
      if (args.apply && selection.prunableIds.length > 0) {
        // Land the tombstone column before the write filters on it (Process Hardening #4).
        // Run OUTSIDE the transaction below (a plain ALTER is fine here; this is not the
        // 12-step firehose rebuild, but keep column-DDL out of BEGIN IMMEDIATE on principle).
        ensureContentPrunedColumn(client);
        const nowIso = new Date().toISOString();
        const begin = client.execute('BEGIN IMMEDIATE', []);
        if (!begin.success) {
          return createError<PruneReport>(
            begin.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to begin prune transaction' }
          );
        }
        try {
          for (const id of selection.prunableIds) {
            const res = args.hard
              ? client.execute('DELETE FROM context_snapshots WHERE id = ?', [id])
              : client.execute(
                  // Guard on content_pruned_at IS NULL so a concurrent/rerun is idempotent.
                  "UPDATE context_snapshots SET content = '', content_pruned_at = ? WHERE id = ? AND content_pruned_at IS NULL",
                  [nowIso, id]
                );
            if (!res.success) throw new Error(res.error?.message ?? `prune failed on id ${id}`);
            applied += res.data?.changes ?? 0;
          }
          const commit = client.execute('COMMIT', []);
          if (!commit.success) throw new Error(commit.error?.message ?? 'commit failed');
        } catch (err) {
          client.execute('ROLLBACK', []);
          return createError<PruneReport>({
            code: 'DB_QUERY_FAILED',
            message: `Prune aborted and rolled back: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      return createSuccess<PruneReport>({
        selection,
        applied,
        hard: args.hard,
        rowCount: rows.length,
        totalContentBytes,
      });
    },
    args.projectRoot ? { projectRoot: args.projectRoot } : undefined
  );

  if (!result.success || !result.data) {
    console.error(`[prune:snapshots] failed: ${result.error?.message ?? 'unknown error'}`);
    return 1;
  }

  const { selection, applied, hard, rowCount, totalContentBytes } = result.data;
  const mode = args.apply
    ? hard
      ? 'APPLY (--hard DELETE)'
      : 'APPLY (content-tombstone)'
    : 'DRY-RUN';
  console.log(`[prune:snapshots] ${mode} — keep-N=${keepN}/context, --days=${args.days || 'off'}`);
  console.log(
    `[prune:snapshots] ${rowCount} rows, ${fmtBytes(totalContentBytes)} content; ` +
      `${selection.preserveIds.length} preserved, ${selection.prunableIds.length} prunable ` +
      `(~${fmtBytes(selection.bytesReclaimable)} reclaimable)`
  );
  const r = selection.preserveReasons;
  console.log(
    `[prune:snapshots] preserve reasons: newest=${r.newestPerContext} lastN=${r.lastN} ` +
      `live-FK=${r.fkReferenced} sprint_complete=${r.sprintComplete} within-days=${r.withinDays}`
  );
  for (const c of selection.perContext) {
    console.log(
      `  - ${c.contextId}: ${c.total} total → ${c.preserved} preserved, ${c.prunable} prunable`
    );
  }

  if (args.apply) {
    console.log(
      `[prune:snapshots] APPLIED: ${applied} row(s) ${hard ? 'hard-deleted' : 'content-tombstoned'}. ` +
        `${hard ? 'Rows are GONE.' : 'Content is GONE (row/metadata/FK/event preserved).'} ` +
        `Recovery is ONLY via a DB-file backup (cmos-db-snapshot).`
    );
  } else {
    console.log(
      `[prune:snapshots] DRY-RUN — no changes written. Re-run with --apply to prune ` +
        `(--hard to DELETE rows instead of content-tombstone). --apply is IRREVERSIBLE.`
    );
  }
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[prune:snapshots] failed:', err);
      process.exit(1);
    });
}

export { main as pruneContextSnapshots, parseArgs };
