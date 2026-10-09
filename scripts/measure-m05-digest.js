#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Render digest v2 from readonly SQLite backups and audit actual capped headlines.
// ABOUTME: Compare repeated bytes and store hashes; retain a report only at the requested path.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ts = require('typescript');
const Database = require('better-sqlite3');

async function main() {
  const [reportPath, ...roots] = process.argv.slice(2);
  if (!reportPath || !roots.length)
    throw new Error('Usage: measure-m05-digest.js <report.md> <project-root> ...');
  const previousLoader = require.extensions['.ts'];
  require.extensions['.ts'] = (mod, file) => {
    const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    });
    mod._compile(outputText, file);
  };
  const { readDigestV2 } = require('../src/tools/cmos/digest-v2-store.ts');
  const { renderDigestV2, digestHeadline } = require('../src/tools/cmos/digest-v2.ts');
  const { readProfile } = require('../src/tools/cmos/operator-profile.ts');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-m05-render-'));
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const report = [
    '# m05 real-store digest verification',
    '',
    `Measured ${new Date().toISOString().slice(0, 10)} using current TypeScript source.`,
    'Each input is SQLite-backed up from a readonly connection into an isolated temporary root.',
    'Two unchanged renders must match byte-for-byte and preserve the copied database hash.',
    'Decision counts below count all strategic_decisions rows; recent counts use the digest’s',
    'seven-day creation-or-review window and exclude superseded status/pointers before caps.',
    'Headline audit lists every selected decision and flags empty/label-only output. Human review',
    'must also inspect the actual shortened rows below; this check does not infer semantic quality.',
  ];
  const results = [];
  try {
    const config = path.join(temp, 'config');
    fs.mkdirSync(config);
    const profile = readProfile(process.env);
    if (profile) fs.writeFileSync(path.join(config, 'profile.md'), profile.text);
    for (const [index, input] of roots.entries()) {
      const original = path.resolve(input);
      const root = path.join(temp, String(index));
      const destination = path.join(root, 'cmos', 'db', 'cmos.sqlite');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const source = new Database(path.join(original, 'cmos', 'db', 'cmos.sqlite'), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        await source.backup(destination);
      } finally {
        source.close();
      }
      const before = hash(destination);
      const env = { ...process.env, CMOS_CONFIG_DIR: config };
      const model = await readDigestV2(root, env);
      const first = renderDigestV2(model);
      const second = renderDigestV2(await readDigestV2(root, env));
      if (first.text !== second.text || before !== hash(destination))
        throw new Error(`Unstable render or modified database: ${original}`);
      if (first.text.length > 4000) throw new Error(`Oversized digest: ${original}`);
      const db = new Database(destination, { readonly: true });
      let decisions;
      try {
        decisions = db.prepare('SELECT COUNT(*) AS n FROM strategic_decisions').get().n;
        const columns = db.prepare('PRAGMA table_info(strategic_decisions)').all();
        const pointer = columns.some((col) => col.name === 'superseded_by')
          ? ' OR superseded_by IS NOT NULL'
          : '';
        const excluded = new Set(
          db
            .prepare(`SELECT id FROM strategic_decisions WHERE status='superseded'${pointer}`)
            .all()
            .map((row) => `d:${row.id}`)
        );
        if (model.decisions.rows.some((row) => excluded.has(row.id)))
          throw new Error(`Superseded row rendered: ${original}`);
      } finally {
        db.close();
      }
      const audits = model.decisions.rows.map((row) => ({
        id: row.id,
        headline: digestHeadline(row.text),
      }));
      const exceptions = audits.filter(
        (row) => !row.headline || /^[\p{Lu}\d\p{P}\p{Zs}]+$/u.test(row.headline)
      );
      results.push({
        project: model.project.name,
        decisions,
        recent: model.decisions.total,
        shown: model.decisions.rows.length,
        characters: first.text.length,
        bytes: Buffer.byteLength(first.text),
        stable: true,
        unchanged: true,
        exceptions: exceptions.map((row) => row.id),
      });
      report.push(
        '',
        `## ${model.project.name}`,
        '',
        `Source: \`${original}\`. ${decisions} decision rows; ${model.decisions.rows.length} selected`,
        `of ${model.decisions.total} eligible recent decisions. ${first.text.length} characters,`,
        `${Buffer.byteLength(first.text)} UTF-8 bytes. Repeat bytes identical; backup hash unchanged.`,
        `Published-label exceptions: ${exceptions.length ? exceptions.map((row) => row.id).join(', ') : 'none'}.`,
        '',
        '```text',
        first.text,
        '```',
        '',
        'Selected decision headlines before section allocation:',
        '',
        ...audits.map((row) => `- ${row.id}: ${row.headline || '[no sentence; read in full]'}`)
      );
    }
    fs.writeFileSync(path.resolve(reportPath), report.join('\n') + '\n');
    console.log(JSON.stringify(results, null, 2));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    if (previousLoader) require.extensions['.ts'] = previousLoader;
    else delete require.extensions['.ts'];
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
