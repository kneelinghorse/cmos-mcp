// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The one strategic_decisions write path shared by session capture and decisions record:
// ABOUTME: dedup lookup, genesis-stamped INSERT, then supersession detection and embedding.

import type { CmosDatabaseClient } from './client';
import { genesisColumns, getProjectId } from './genesis-columns';
import { recordEmbedding, decisionEmbeddingInput } from '../../intelligence/embedding-pipeline';
import { checkWrite, type WriteSink } from './write-guard';

/**
 * s91-m04 — extracted from the decision arm of `cmosSessionCapture` so `cmos_decisions(record)`
 * writes a decision through the SAME dedup, genesis stamp, detection and embedding as capture.
 *
 * Split into a SYNC half (lookup + INSERT, safe inside `client.transaction`) and an ASYNC half
 * (detection + embedding, which must run after the write commits). Sprint resolution stays with
 * each caller because the two resolve differently (capture: mission -> session -> active work;
 * record: mission -> explicit sprintId -> open-sprint write resolver).
 *
 * NOT LOOKED AT: `captureDecisions` in cmos-mission-complete.ts is a third copy (no dedup, no
 * detection) and stays untouched this sprint.
 */

export interface DecisionRowInput {
  readonly content: string;
  readonly now: string;
  readonly sprintId: string | null;
  /** The authoring session, or `null` when record runs with no active session. */
  readonly authorSessionId: string | null;
  readonly missionId?: string;
  readonly evidence?: ReadonlyArray<{ type: string; id: string }>;
  /** Overrides metadata.project_domain when the caller names a domain (record only). */
  readonly projectDomain?: string;
}

export type DecisionRowOutcome =
  | { readonly kind: 'materialized'; readonly decisionId: number | undefined }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * The id of an identical decision already written by the same author session (NULL matches
 * NULL, so a session-less `record` retry is idempotent), or `undefined`.
 */
export function findExistingDecisionId(
  client: CmosDatabaseClient,
  content: string,
  authorSessionId: string | null
): number | undefined {
  const existing = client.getOne<{ id: number }>(
    'SELECT id FROM strategic_decisions WHERE decision_text = ? AND author_session_id IS ?',
    [content, authorSessionId]
  );
  return existing.success && existing.data ? existing.data.id : undefined;
}

/** Genesis-stamped INSERT. A rejected INSERT is recorded into `writeSink` and returned as failed. */
export function insertDecisionRow(
  client: CmosDatabaseClient,
  input: DecisionRowInput,
  writeSink: WriteSink
): DecisionRowOutcome {
  const domainResult = client.getOne<{ value: string }>(
    "SELECT value FROM metadata WHERE key = 'project_domain'",
    []
  );
  const projectDomain =
    input.projectDomain ?? (domainResult.success ? (domainResult.data?.value ?? null) : null);

  const columns = [
    'decision_text',
    'created_at',
    'sprint_id',
    'project_domain',
    'author_session_id',
  ];
  const insertParams: unknown[] = [
    input.content,
    input.now,
    input.sprintId,
    projectDomain,
    input.authorSessionId,
  ];

  if (input.missionId) {
    columns.push('mission_id');
    insertParams.push(input.missionId);
  }

  if (input.evidence && input.evidence.length > 0) {
    columns.push('evidence');
    insertParams.push(JSON.stringify(input.evidence));
  }

  // s69-m03 — stamp the per-row genesis columns into the dynamic list.
  const genesis = genesisColumns(client, 'strategic_decisions', getProjectId(client));
  columns.push(...genesis.columns);
  insertParams.push(...genesis.values);

  const insertColumns = columns.join(', ');
  const insertPlaceholders = columns.map(() => '?').join(', ');
  const insertResult = client.execute(
    `INSERT INTO strategic_decisions (${insertColumns}) VALUES (${insertPlaceholders})`,
    insertParams
  );

  if (!checkWrite(insertResult, writeSink, 'strategic_decisions.insert')) {
    return {
      kind: 'failed',
      message: `${insertResult.error?.code ?? 'DB_ERROR'}: ${insertResult.error?.message ?? 'unknown'}`,
    };
  }

  const lastId = insertResult.data?.lastInsertRowid;
  const decisionId =
    typeof lastId === 'number' ? lastId : typeof lastId === 'bigint' ? Number(lastId) : undefined;
  return { kind: 'materialized', decisionId };
}

/**
 * After a committed INSERT: record the decision's embedding.
 *
 * s92-m04 retired the automatic supersession offer that used to run here. Replayed over every
 * historical capture, 69 of 9,035 offers were true, and 28-61% of real supersessions cross sprints,
 * where a same-sprint detector cannot see them (retrieval study §5, R4). A correction names what it
 * replaces at write time: cmos_decisions(action="record", supersedes=[...]).
 */
export async function followDecisionInsert(
  client: CmosDatabaseClient,
  content: string,
  decisionId: number | undefined,
  warnings: string[]
): Promise<void> {
  // Sprint 66 m03 — write-path embedding hook
  if (decisionId !== undefined) {
    const embedResult = await recordEmbedding(client, {
      type: 'decision',
      id: decisionId,
      inputText: decisionEmbeddingInput(content),
    });
    warnings.push(...(embedResult.warnings ?? []));
  }
}
