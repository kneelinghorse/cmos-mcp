#!/usr/bin/env npx ts-node
// ABOUTME: One-shot backfill for the Sprint 66 m03 embedding pipeline. Embeds every
// existing row in strategic_decisions / learnings / missions and upserts into the
// matching vec0 virtual table. Resumable (skip-on-no-change via last_embedded_hash).

import { CmosDatabaseClient } from '../src/tools/cmos/client';
import { ensureVectorStorage } from '../src/tools/cmos/schema-migrations';
import {
  recordEmbedding,
  decisionEmbeddingInput,
  learningEmbeddingInput,
  missionEmbeddingInput,
  type RecordEmbeddingAction,
} from '../src/intelligence/embedding-pipeline';

const BATCH_SIZE = Number(process.env.CMOS_BACKFILL_BATCH_SIZE ?? 50);

interface Counts {
  embedded: number;
  skippedNoChange: number;
  failed: number;
}

function bump(counts: Counts, action: RecordEmbeddingAction): void {
  if (action === 'embedded') counts.embedded++;
  else if (action === 'skipped-no-change') counts.skippedNoChange++;
  else counts.failed++;
}

function logProgress(type: string, processed: number, total: number, counts: Counts): void {
  const pct = total > 0 ? Math.round((processed / total) * 100) : 100;
  process.stderr.write(
    `[backfill] ${type} ${processed}/${total} (${pct}%) — embedded=${counts.embedded} skipped=${counts.skippedNoChange} failed=${counts.failed}\n`
  );
}

async function backfillDecisions(client: CmosDatabaseClient): Promise<Counts> {
  const counts: Counts = { embedded: 0, skippedNoChange: 0, failed: 0 };
  const totalRow = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM strategic_decisions`,
    []
  );
  const total = totalRow.success && totalRow.data ? totalRow.data.count : 0;
  if (total === 0) {
    process.stderr.write('[backfill] decisions: no rows\n');
    return counts;
  }

  let lastId = 0;
  let processed = 0;
  for (;;) {
    const batch = client.getMany<{ id: number; decision_text: string }>(
      `SELECT id, decision_text FROM strategic_decisions
       WHERE id > ? ORDER BY id LIMIT ?`,
      [lastId, BATCH_SIZE]
    );
    if (!batch.success || !batch.data || batch.data.length === 0) break;

    for (const row of batch.data) {
      const result = await recordEmbedding(client, {
        type: 'decision',
        id: row.id,
        inputText: decisionEmbeddingInput(row.decision_text),
      });
      bump(counts, result.action);
      lastId = row.id;
      processed++;
    }

    logProgress('decisions', processed, total, counts);
  }

  return counts;
}

async function backfillLearnings(client: CmosDatabaseClient): Promise<Counts> {
  const counts: Counts = { embedded: 0, skippedNoChange: 0, failed: 0 };
  const totalRow = client.getOne<{ count: number }>(`SELECT COUNT(*) AS count FROM learnings`, []);
  const total = totalRow.success && totalRow.data ? totalRow.data.count : 0;
  if (total === 0) {
    process.stderr.write('[backfill] learnings: no rows\n');
    return counts;
  }

  let lastId = 0;
  let processed = 0;
  for (;;) {
    const batch = client.getMany<{ id: number; content: string }>(
      `SELECT id, content FROM learnings WHERE id > ? ORDER BY id LIMIT ?`,
      [lastId, BATCH_SIZE]
    );
    if (!batch.success || !batch.data || batch.data.length === 0) break;

    for (const row of batch.data) {
      const result = await recordEmbedding(client, {
        type: 'learning',
        id: row.id,
        inputText: learningEmbeddingInput(row.content),
      });
      bump(counts, result.action);
      lastId = row.id;
      processed++;
    }

    logProgress('learnings', processed, total, counts);
  }

  return counts;
}

async function backfillMissions(client: CmosDatabaseClient): Promise<Counts> {
  const counts: Counts = { embedded: 0, skippedNoChange: 0, failed: 0 };
  const totalRow = client.getOne<{ count: number }>(`SELECT COUNT(*) AS count FROM missions`, []);
  const total = totalRow.success && totalRow.data ? totalRow.data.count : 0;
  if (total === 0) {
    process.stderr.write('[backfill] missions: no rows\n');
    return counts;
  }

  // missions.id is TEXT — use rowid for the resume cursor since string comparison
  // doesn't sort cleanly across legacy + sNN-mMM ids.
  let lastRowid = 0;
  let processed = 0;
  for (;;) {
    const batch = client.getMany<{
      rowid: number;
      id: string;
      name: string;
      objective: string | null;
      notes: string | null;
      success_criteria: string | null;
    }>(
      `SELECT rowid, id, name, objective, notes, success_criteria FROM missions
       WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      [lastRowid, BATCH_SIZE]
    );
    if (!batch.success || !batch.data || batch.data.length === 0) break;

    for (const row of batch.data) {
      let criteria: string[] | null = null;
      if (row.success_criteria) {
        try {
          const parsed = JSON.parse(row.success_criteria);
          if (Array.isArray(parsed)) criteria = parsed.filter((s) => typeof s === 'string');
        } catch {
          // Malformed JSON in legacy rows — skip success_criteria for embedding.
        }
      }
      const result = await recordEmbedding(client, {
        type: 'mission',
        id: row.id,
        inputText: missionEmbeddingInput({
          name: row.name,
          objective: row.objective,
          notes: row.notes,
          successCriteria: criteria,
        }),
      });
      bump(counts, result.action);
      lastRowid = row.rowid;
      processed++;
    }

    logProgress('missions', processed, total, counts);
  }

  return counts;
}

async function main(): Promise<void> {
  const projectRoot = process.env.CMOS_PROJECT_ROOT ?? process.cwd();
  process.stderr.write(`[backfill] project root: ${projectRoot}\n`);

  const clientResult = await CmosDatabaseClient.create({ projectRoot });
  if (!clientResult.success || !clientResult.data) {
    process.stderr.write(`[backfill] failed to open client: ${clientResult.error?.message}\n`);
    process.exit(1);
  }
  const client = clientResult.data;

  try {
    process.stderr.write('[backfill] ensuring vector storage migration\n');
    ensureVectorStorage(client);

    process.stderr.write('[backfill] starting decisions\n');
    const decisions = await backfillDecisions(client);

    process.stderr.write('[backfill] starting learnings\n');
    const learnings = await backfillLearnings(client);

    process.stderr.write('[backfill] starting missions\n');
    const missions = await backfillMissions(client);

    process.stderr.write('\n[backfill] complete\n');
    process.stderr.write(
      `  decisions: embedded=${decisions.embedded} skipped=${decisions.skippedNoChange} failed=${decisions.failed}\n`
    );
    process.stderr.write(
      `  learnings: embedded=${learnings.embedded} skipped=${learnings.skippedNoChange} failed=${learnings.failed}\n`
    );
    process.stderr.write(
      `  missions:  embedded=${missions.embedded} skipped=${missions.skippedNoChange} failed=${missions.failed}\n`
    );

    const totalFailed = decisions.failed + learnings.failed + missions.failed;
    if (totalFailed > 0) {
      process.stderr.write(`\n[backfill] ${totalFailed} rows failed — see [WARN] lines above\n`);
      process.exit(2);
    }
  } finally {
    client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`[backfill] fatal: ${error instanceof Error ? error.stack : error}\n`);
  process.exit(1);
});
