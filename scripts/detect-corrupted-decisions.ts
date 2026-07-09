// ABOUTME: Reports (does NOT fix) CMOS rows containing XML marshalling artifacts from past corruption events.
// ABOUTME: Sprint 56 m02 — audit-only companion to content-sanitizer.ts; operator runs it to triage historical damage.

import * as path from 'path';
import Database from 'better-sqlite3';
import { ProjectGraphRegistry } from '../src/intelligence/project-graph-registry';
import { sanitizeContentField } from '../src/intelligence/content-sanitizer';

interface CorruptionEntry {
  table: string;
  rowId: number | string;
  column: string;
  snippet: string;
  fullLength: number;
  stripsToLength: number;
}

interface TableScan {
  table: string;
  idColumn: string;
  textColumns: string[];
}

const SCANS: TableScan[] = [
  { table: 'strategic_decisions', idColumn: 'id', textColumns: ['decision_text'] },
  { table: 'learnings', idColumn: 'id', textColumns: ['content'] },
  { table: 'constraints', idColumn: 'id', textColumns: ['content'] },
  { table: 'next_steps', idColumn: 'id', textColumns: ['content'] },
  {
    table: 'missions',
    idColumn: 'id',
    textColumns: ['objective', 'context', 'notes'],
  },
  { table: 'sessions', idColumn: 'id', textColumns: ['summary'] },
];

function scanTable(db: InstanceType<typeof Database>, scan: TableScan): CorruptionEntry[] {
  const out: CorruptionEntry[] = [];
  const selectCols = [scan.idColumn, ...scan.textColumns].join(', ');
  const rows = db.prepare(`SELECT ${selectCols} FROM ${scan.table}`).all() as Record<
    string,
    unknown
  >[];
  for (const row of rows) {
    for (const col of scan.textColumns) {
      const value = row[col];
      if (typeof value !== 'string' || value.length === 0) continue;
      const result = sanitizeContentField(value);
      if (!result.wasModified) continue;
      out.push({
        table: scan.table,
        rowId: row[scan.idColumn] as number | string,
        column: col,
        snippet: value.slice(0, 120).replace(/\n/g, ' \\n '),
        fullLength: value.length,
        stripsToLength: result.cleaned.length,
      });
    }
  }
  return out;
}

async function resolveDbPath(): Promise<string> {
  // s80-m02: resolve the default project via the project-graph registry (the JSON
  // ProjectRegistry was deleted; the graph is the single discovery source).
  const graph = await ProjectGraphRegistry.create();
  const defaultProject = graph.getDefault();
  if (defaultProject) {
    return path.join(defaultProject.store_path, 'cmos', 'db', 'cmos.sqlite');
  }
  return path.resolve(process.cwd(), 'cmos', 'db', 'cmos.sqlite');
}

async function main(): Promise<number> {
  const dbPath = process.env['CMOS_DB_PATH'] ?? (await resolveDbPath());
  console.log(`[detect] scanning ${dbPath}`);

  const db = new Database(dbPath, { readonly: true });
  const findings: CorruptionEntry[] = [];
  try {
    for (const scan of SCANS) {
      const tableExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(scan.table);
      if (!tableExists) {
        console.log(`[detect] skipping ${scan.table} — table not present`);
        continue;
      }
      const rows = scanTable(db, scan);
      findings.push(...rows);
      console.log(`[detect] ${scan.table}: ${rows.length} corrupted row(s)`);
    }
  } finally {
    db.close();
  }

  if (findings.length === 0) {
    console.log('[detect] no corruption detected');
    return 0;
  }

  console.log(
    `\n[detect] ${findings.length} corrupted row(s) total — REPORT ONLY, no changes made`
  );
  for (const f of findings.slice(0, 40)) {
    console.log(`  - ${f.table}#${f.rowId}.${f.column}  len ${f.fullLength} → ${f.stripsToLength}`);
    console.log(`      ${f.snippet}${f.snippet.length >= 120 ? '…' : ''}`);
  }
  if (findings.length > 40) {
    console.log(`  ... and ${findings.length - 40} more`);
  }
  console.log(
    '\nTo fix, run targeted SQL UPDATEs after review. This script intentionally does not auto-fix.'
  );
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[detect] failed:', err);
      process.exit(1);
    });
}

export { main as detectCorruptedDecisions };
