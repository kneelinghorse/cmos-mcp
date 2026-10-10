// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Final source marks, drop audits and provenance pointers form one indivisible transaction.
// ABOUTME: Retain historical text and terminal status while default readers follow the committed ledger.
import type { CmosDatabaseClient } from './client';
import { cmosMissionDropOnClient } from './cmos-mission-drop';
import { requireSpinOut } from './spin-out-store';
import {
  operationKey,
  writeSpinOutMetadata,
  writeSpinOutRow,
  type SpinOutOperation,
} from './spin-out-ledger';
import { SPIN_OUT_ROW_PREFIX } from './spin-out-types';
import { SPIN_OUT_TABLES } from './spin-out-columns';
import { fingerprintSpinOutPayload } from './spin-out-manifest';
function jsonRecord(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : { original: value };
  } catch {
    return { original: value };
  }
}
export function markSpinOutSource(client: CmosDatabaseClient, operation: SpinOutOperation): void {
  const expected: { table: string; id: string | number; fields: Record<string, unknown> }[] = [];
  for (const provenance of operation.plan.provenance) {
    const table = SPIN_OUT_TABLES[provenance.kind];
    const original = requireSpinOut(
      client.getOne<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id=?`, [
        provenance.sourceId,
      ]),
      'Read original source payload'
    );
    if (!original) throw new Error('Source record disappeared');
    const fields = { ...original };
    expected.push({ table, id: provenance.sourceId, fields });
    const note = `Spun out from ${operation.source.root} to ${operation.target.root}: ${provenance.kind} ${provenance.targetId} (operation ${operation.operationId})`;
    if (provenance.kind === 'mission') {
      const row = requireSpinOut(
        client.getOne<{ status: string; metadata: string | null }>(
          'SELECT status,metadata FROM missions WHERE id=?',
          [provenance.sourceId]
        ),
        'Read source mission'
      );
      if (!row) throw new Error('Source mission disappeared');
      if (!['Completed', 'Dropped'].includes(row.status))
        requireSpinOut(
          cmosMissionDropOnClient(client, { missionId: String(provenance.sourceId), reason: note }),
          'Drop transferred mission'
        );
      const afterDrop = requireSpinOut(
        client.getOne<Record<string, unknown>>('SELECT * FROM missions WHERE id=?', [
          provenance.sourceId,
        ]),
        'Read audited source drop'
      );
      if (!afterDrop) throw new Error('Source mission disappeared after drop');
      for (const key of ['status', 'domain_fields', 'notes', 'updated_at'])
        fields[key] = afterDrop[key];
      fields.status = ['Completed', 'Dropped'].includes(row.status) ? row.status : 'Dropped';
      fields.metadata = JSON.stringify({ ...jsonRecord(row.metadata), spunOutTo: provenance });
      fields.notes = (afterDrop.notes == null ? '' : `${afterDrop.notes} | `) + note;
      writeSpinOutRow(
        client,
        "UPDATE missions SET metadata=?,notes=COALESCE(notes || ' | ','') || ? WHERE id=?",
        [fields.metadata, note, provenance.sourceId],
        'Mark source mission'
      );
    } else if (provenance.kind === 'decision') {
      const row = requireSpinOut(
        client.getOne<{ evidence: string | null }>(
          'SELECT evidence FROM strategic_decisions WHERE id=?',
          [provenance.sourceId]
        ),
        'Read source decision'
      );
      let evidence: unknown[] = [];
      try {
        const parsed = JSON.parse(row?.evidence ?? '[]');
        evidence = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        evidence = [row?.evidence ?? null];
      }
      evidence.push({
        type: 'cmos',
        id: `${operation.target.address}#decision-${provenance.targetId}`,
        description: note,
      });
      fields.status = 'archived';
      fields.evidence = JSON.stringify(evidence);
      writeSpinOutRow(
        client,
        "UPDATE strategic_decisions SET status='archived',evidence=? WHERE id=?",
        [fields.evidence, provenance.sourceId],
        'Archive transferred decision'
      );
    } else {
      const table = provenance.kind === 'learning' ? 'learnings' : 'next_steps';
      const status = provenance.kind === 'learning' ? 'archived' : 'dropped';
      fields.status = status;
      writeSpinOutRow(
        client,
        `UPDATE ${table} SET status=? WHERE id=?`,
        [status, provenance.sourceId],
        `Mark transferred ${provenance.kind}`
      );
    }
    writeSpinOutMetadata(
      client,
      `${SPIN_OUT_ROW_PREFIX}${provenance.kind}:${provenance.sourceId}`,
      provenance
    );
  }
  writeSpinOutMetadata(client, operationKey(operation.operationId), {
    ...operation,
    phase: 'marked',
  });
  for (const row of expected) {
    const stored = requireSpinOut(
      client.getOne(`SELECT * FROM ${row.table} WHERE id=?`, [row.id]),
      'Verify source postcondition'
    );
    if (fingerprintSpinOutPayload(stored ?? null) !== fingerprintSpinOutPayload(row.fields))
      throw new Error(`Source postcondition failed for ${row.table}:${row.id}`);
  }
}
