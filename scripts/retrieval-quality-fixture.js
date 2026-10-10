// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Loads hash-pinned retrieval evidence and builds disposable historical SQLite slices.
// ABOUTME: Candidate and edge sources precede each query; production modules are loaded without dist.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const ts = require('typescript');
const Database = require('better-sqlite3');

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function checkedJson(file, expected) {
  const bytes = fs.readFileSync(file);
  if (!expected || sha(bytes) !== expected) throw new Error(`fixture hash changed: ${file}`);
  return JSON.parse(bytes.toString('utf8'));
}

// Same accepted UTC spellings as storedTimeMs; a parity test guards this standalone reader.
function timeMs(value) {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const raw = value.trim();
  const zoneless = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(raw);
  return Date.parse(zoneless ? `${zoneless[1]}T${zoneless[2]}Z` : raw);
}

function priorLocalRows(rows, cutoff, projectId, excludedId) {
  return rows.filter(
    (row) =>
      row.id !== excludedId &&
      (row.project_id == null || row.project_id === projectId) &&
      timeMs(row.created_at) < cutoff
  );
}

// Unknown chronology blocks bare-ID guessing even though it can never supply a candidate.
function priorOrUnknown(row, cutoff) {
  const time = timeMs(row.created_at);
  return !Number.isFinite(time) || time < cutoff;
}

function stateAt(row, cutoff, decisions, sprints) {
  const pointerTime = timeMs(decisions.get(row.superseded_by)?.created_at);
  const closure = timeMs(sprints.get(row.sprint_id)?.end_date);
  const inactiveAt = row.superseded_by == null ? closure : pointerTime;
  return {
    status: row.status === 'superseded' && !(inactiveAt < cutoff) ? 'active' : row.status,
    supersededBy: row.superseded_by != null && pointerTime < cutoff ? row.superseded_by : null,
  };
}

function loadSource(root) {
  root = fs.realpathSync(root);
  const previous = require.extensions['.ts'];
  const loaded = new Map();
  const expected = new Set();
  require.extensions['.ts'] = (mod, file) => {
    const bytes = fs.readFileSync(file);
    if (file.startsWith(path.join(root, 'src') + path.sep)) loaded.set(file, sha(bytes));
    mod._compile(
      ts.transpileModule(bytes.toString('utf8'), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
          esModuleInterop: true,
        },
      }).outputText,
      file
    );
  };
  const moduleAt = (name) => {
    const file = fs.realpathSync(path.join(root, 'src', name + '.ts'));
    expected.add(file);
    return require(file);
  };
  const retrieval = moduleAt('tools/cmos/fts5-retriever');
  const oldEmbed = retrieval.HybridRetriever.prototype.embedQuery;
  // Explicit deterministic keyword-only mode, never an optional-model availability fallback.
  retrieval.HybridRetriever.prototype.embedQuery = async () => null;
  return {
    ...moduleAt('tools/cmos/client'),
    ...moduleAt('tools/cmos/schema'),
    ...moduleAt('tools/cmos/schema-migrations'),
    ...retrieval,
    retrieval,
    ...moduleAt('tools/cmos/relevance-surfacing'),
    ...moduleAt('tools/cmos/first-prompt-recall'),
    ...moduleAt('tools/cmos/tool-call-context'),
    ...moduleAt('cli'),
    moduleAt,
    verify() {
      if (!loaded.size || [...expected].some((file) => !loaded.has(file))) {
        throw new Error('loaded source inventory is empty or incomplete; use a fresh process');
      }
      for (const [file, hash] of loaded) {
        if (sha(fs.readFileSync(file)) !== hash) throw new Error(`loaded source changed: ${file}`);
      }
      return Object.fromEntries(
        [...loaded].map(([file, hash]) => [path.relative(root, file), hash])
      );
    },
    restore() {
      retrieval.HybridRetriever.prototype.embedQuery = oldEmbed;
      if (previous) require.extensions['.ts'] = previous;
      else delete require.extensions['.ts'];
    },
  };
}

async function createSlice(source, corpus, includeLinks = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-retrieval-slice-'));
  const dbPath = path.join(root, 'cmos/db/cmos.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(source.CMOS_SCHEMA);
  db.pragma('foreign_keys = OFF');
  db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(
    'project_id',
    corpus.projectId
  );
  db.exec(
    'CREATE TABLE IF NOT EXISTS agent_feedback(id INTEGER PRIMARY KEY,created_at TEXT,project_id TEXT)'
  );
  const opened = await source.CmosDatabaseClient.create({ dbPath });
  if (!opened.success || !opened.data) throw new Error('slice open failed');
  const client = opened.data;
  const substrate = source.ensureVectorStorage(client);
  if (substrate.warnings?.length)
    throw new Error(`slice substrate: ${substrate.warnings.join('; ')}`);
  const links = includeLinks ? source.moduleAt('tools/cmos/record-links') : null;
  if (links) {
    const ready = links.ensureRecordLinks(client);
    if (!ready.ready) throw new Error(`slice link schema: ${JSON.stringify(ready)}`);
  }
  const insertD = db.prepare(`INSERT INTO strategic_decisions
    (id,decision_text,context_text,alternatives,consequences,deciders,status,created_at,sprint_id,superseded_by,project_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const insertL = db.prepare(`INSERT INTO learnings
    (id,content,status,created_at,sprint_id,project_id) VALUES(?,?,?,?,?,?)`);
  const decisions = new Map(corpus.decisions.map((row) => [row.id, row]));
  const sprints = new Map(corpus.sprints.map((row) => [row.id, row]));
  const fill = db.transaction((query) => {
    if (links) db.exec('DELETE FROM record_links');
    db.exec('DELETE FROM strategic_decisions; DELETE FROM learnings');
    const inserted = [];
    for (const [kind, rows] of [
      ['decision', corpus.decisions],
      ['learning', corpus.learnings],
    ]) {
      const candidates = new Set();
      for (const row of priorLocalRows(
        rows,
        query.cutoff,
        corpus.projectId,
        query.kind === kind ? query.rowId : undefined
      )) {
        const state = stateAt(row, query.cutoff, decisions, sprints);
        if (kind === 'decision') {
          insertD.run(
            row.id,
            row.decision_text,
            row.context_text,
            row.alternatives,
            row.consequences,
            row.deciders,
            state.status,
            row.created_at,
            row.sprint_id,
            state.supersededBy,
            row.project_id
          );
        } else
          insertL.run(
            row.id,
            row.content,
            state.status,
            row.created_at,
            row.sprint_id,
            row.project_id
          );
        inserted.push({ kind, id: row.id });
        candidates.add(row.id);
      }
      const table = kind === 'decision' ? 'strategic_decisions' : 'learnings';
      for (const row of corpus.collisionInventory[table]) {
        if (
          candidates.has(row.id) ||
          (query.kind === kind && query.rowId === row.id) ||
          !priorOrUnknown(row, query.cutoff)
        )
          continue;
        // Keep identity for production graph reads, never foreign/unknown source text or an
        // eligible candidate. Empty time satisfies the seed's NOT NULL while remaining unknown.
        if (kind === 'decision')
          insertD.run(
            row.id,
            '',
            null,
            null,
            null,
            null,
            'superseded',
            row.created_at ?? '',
            null,
            null,
            row.project_id
          );
        else insertL.run(row.id, '', 'superseded', row.created_at ?? '', null, row.project_id);
      }
    }
    for (const table of ['constraints', 'next_steps', 'agent_feedback']) {
      db.exec(`DELETE FROM ${table}`);
      const columns =
        table === 'agent_feedback'
          ? 'id,created_at,project_id'
          : 'id,created_at,project_id,content';
      const statement = db.prepare(
        `INSERT INTO ${table}(${columns}) VALUES(${columns
          .split(',')
          .map(() => '?')
          .join(',')})`
      );
      for (const row of corpus.collisionInventory[table]) {
        if (!priorOrUnknown(row, query.cutoff)) continue;
        const values = [row.id, row.created_at ?? '', row.project_id];
        if (table !== 'agent_feedback') values.push('');
        statement.run(...values);
      }
    }
    db.exec(
      "INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild'); INSERT INTO learnings_fts(learnings_fts) VALUES('rebuild')"
    );
    return inserted;
  });
  return {
    root,
    dbPath,
    db,
    client,
    fill(query) {
      const inserted = fill(query);
      if (links) {
        const result = client.transaction(() => {
          const repaired = links.repairRecordLinksBatch(client, inserted);
          if (!repaired.success) throw new Error(JSON.stringify(repaired.error));
        });
        if (!result.success) throw new Error(`slice link repair: ${JSON.stringify(result.error)}`);
      }
    },
    close() {
      client.close();
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

module.exports = { sha, checkedJson, timeMs, priorLocalRows, stateAt, loadSource, createSlice };
