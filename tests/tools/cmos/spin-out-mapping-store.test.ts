// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Actual SQLite copies prove mapped citations and fresh genesis survive the target read path.
// ABOUTME: Private positive fire uses consistent temporary backups and never mutates the real store.
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { allocateSpinOutIds, mapSpinOutRows } from '../../../src/tools/cmos/spin-out-mapping';
import { SPIN_OUT_TABLES } from '../../../src/tools/cmos/spin-out-columns';
import { genesisColumns } from '../../../src/tools/cmos/genesis-columns';
import { prepareRecordLinkWrite } from '../../../src/tools/cmos/record-link-write';
import { readRecordLinks, repairRecordLinksBatch } from '../../../src/tools/cmos/record-links';
import { citationNeighbors } from '../../../src/tools/cmos/citation-neighbors';
import { loadLinkInventory } from '../../../src/tools/cmos/record-link-store';
import type {
  SpinOutSourceSnapshot,
  SpinOutSourceRow,
  SpinOutCopyPlan,
} from '../../../src/tools/cmos/spin-out-types';
import type { CmosToolResult } from '../../../src/tools/cmos/types';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';

const PRIVATE = requiresPrivateEvidence({
  reason:
    'The real spin-out shape and citation corpus are private; mutations run only on temporary SQLite backups.',
  paths: { source: 'cmos/db/cmos.sqlite' },
});
function must<T>(result: CmosToolResult<T>): NonNullable<T> {
  if (!result.success || result.data == null)
    throw new Error(result.error?.message ?? 'missing required result');
  return result.data as NonNullable<T>;
}
function insertPlan(client: CmosDatabaseClient, plan: SpinOutCopyPlan, projectId: string): void {
  for (const row of plan.rows) {
    const g = genesisColumns(client, row.table, projectId);
    const columns = [...Object.keys(row.values), ...g.columns];
    must(
      client.execute(
        `INSERT INTO ${row.table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
        [...Object.values(row.values), ...g.values]
      )
    );
  }
  for (const row of plan.deferredSupersessions)
    must(
      client.execute('UPDATE strategic_decisions SET superseded_by=? WHERE id=?', [
        row.supersededBy,
        row.id,
      ])
    );
  const union = plan.rows.flatMap((row) =>
    row.target.kind === 'decision' || row.target.kind === 'learning'
      ? [{ kind: row.target.kind, id: row.target.id }]
      : []
  );
  must(repairRecordLinksBatch(client, union));
}

PRIVATE.describe('private copied-store mapping positive fire', () => {
  it('rewrites actual source citations and reads only mapped target endpoints after union repair', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-spin-map-real-'));
    const sourcePath = path.join(root, 'source.sqlite'),
      targetPath = path.join(root, 'target.sqlite');
    const original = new Database(PRIVATE.paths.source, { readonly: true, fileMustExist: true });
    let source: CmosDatabaseClient | undefined, target: CmosDatabaseClient | undefined;
    try {
      await original.backup(sourcePath);
      const copy = new Database(sourcePath, { readonly: true });
      try {
        await copy.backup(targetPath);
      } finally {
        copy.close();
      }
      source = must(
        await CmosDatabaseClient.create({
          dbPath: sourcePath,
          readonly: true,
          registerProject: false,
        })
      );
      const inventory = loadLinkInventory(source, true);
      expect(inventory.localProjectId).toBeTruthy();
      const graph = readRecordLinks(source);
      expect(graph.available).toBe(true);
      const selected = graph.links.find((edge) => {
        if (edge.from_kind !== 'decision' || edge.to_kind !== 'decision') return false;
        return [edge.from_id, edge.to_id].every((id) => {
          const row = inventory.sources.find(
            (entry) => entry.kind === 'decision' && entry.id === id
          );
          return row && row.fields.status !== 'superseded' && row.fields.superseded_by == null;
        });
      });
      expect(selected).toBeDefined();
      if (!selected) throw new Error('Required real-store positive citation pair is absent');
      const rows = [selected.from_id, selected.to_id].map((id) => ({
        key: { kind: 'decision' as const, id },
        values: must(
          source!.getOne<SpinOutSourceRow['values']>(
            'SELECT * FROM strategic_decisions WHERE id=?',
            [id]
          )
        ),
      }));
      const columns = Object.fromEntries(
        Object.entries(SPIN_OUT_TABLES).map(([kind, table]) => [
          kind,
          must(source!.getMany<{ name: string }>(`PRAGMA table_info(${table})`)).map(
            (column) => column.name
          ),
        ])
      ) as unknown as SpinOutSourceSnapshot['columns'];
      const snapshot: SpinOutSourceSnapshot = {
        sourceProjectId: inventory.localProjectId!,
        columns,
        selectionDescriptor: { decisionIds: rows.map((row) => row.key.id).sort((a, b) => a - b) },
        rows,
        dependencies: [],
        collisionInventory: inventory.identities,
      };
      const writable = new Database(targetPath);
      try {
        writable.prepare("UPDATE metadata SET value='copy-target' WHERE key='project_id'").run();
      } finally {
        writable.close();
      }
      target = must(
        await CmosDatabaseClient.create({ dbPath: targetPath, registerProject: false })
      );
      const warnings: string[] = [];
      expect(prepareRecordLinkWrite(target, warnings).success).toBe(true);
      expect(warnings).toEqual([]);
      const before = must(source.getMany('SELECT * FROM strategic_decisions ORDER BY id'));
      const ids = must(allocateSpinOutIds(target, snapshot));
      const plan = must(
        mapSpinOutRows(snapshot, ids, {
          operationId: 'real-copy',
          source: {
            projectId: snapshot.sourceProjectId,
            root: path.dirname(sourcePath),
            storePath: sourcePath,
          },
          target: {
            projectId: 'copy-target',
            root: path.dirname(targetPath),
            storePath: targetPath,
          },
          sourceUri: 'cmos://private/source',
          masterContextId: 'master_context',
        })
      );
      const transaction = target.transaction(() => insertPlan(target!, plan, 'copy-target'));
      expect(transaction.success).toBe(true);
      const from = ids.find((entry) => entry.source.id === selected.from_id)!.target.id as number;
      const to = ids.find((entry) => entry.source.id === selected.to_id)!.target.id as number;
      const targetGraph = readRecordLinks(target);
      expect(targetGraph.warnings).toEqual([]);
      expect(
        targetGraph.links.filter((edge) => edge.from_kind === 'decision' && edge.from_id === from)
      ).toEqual([
        {
          from_kind: 'decision',
          from_id: from,
          to_kind: 'decision',
          to_id: to,
          resolution: 'typed',
        },
      ]);
      const neighbors = citationNeighbors(target, 'decision', [from]);
      expect(neighbors.available).toBe(true);
      expect(neighbors.neighbors.has(to)).toBe(true);
      expect(neighbors.neighbors.has(selected.to_id)).toBe(false);
      const stamps = must(
        target.getMany<{
          stable_event_id: string;
          origin_seq: number;
          project_id: string;
          created_at: string;
        }>(
          'SELECT stable_event_id,origin_seq,project_id,created_at FROM strategic_decisions WHERE id IN (?,?)',
          [from, to]
        )
      );
      expect(new Set(stamps.map((stamp) => stamp.stable_event_id)).size).toBe(2);
      expect(new Set(stamps.map((stamp) => stamp.origin_seq)).size).toBe(2);
      expect(stamps.every((stamp) => stamp.project_id === 'copy-target')).toBe(true);
      expect(stamps.map((stamp) => stamp.created_at).sort()).toEqual(
        rows.map((row) => row.values.created_at).sort()
      );
      expect(must(source.getMany('SELECT * FROM strategic_decisions ORDER BY id'))).toEqual(before);
      expect(must(target.getOne('PRAGMA integrity_check'))).toEqual({ integrity_check: 'ok' });
    } finally {
      source?.close();
      target?.close();
      original.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
