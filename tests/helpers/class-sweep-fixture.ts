// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Builds isolated public source and sweep ledgers with independent published predicates.
// ABOUTME: Each mutation starts from a valid Git fixture without private stores or historical objects.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
const { runClassSweeps } = require('../../scripts/class-sweeps');

export const step = (pattern: string, flags = '', op = 'include') => ({ op, pattern, flags });
const definitions = [
  {
    mission: 's92-m03',
    id: 'readers',
    count: 6,
    unit: 'lines',
    predicate: [step('FROM sessions'), step('status', 'i'), step('active', 'i')],
  },
  {
    mission: 's92-m09',
    id: 'inserts',
    count: 9,
    unit: 'files',
    predicate: [step('INSERT INTO context_snapshots')],
  },
  {
    mission: 's94-m11',
    id: 'literal',
    count: 38,
    unit: 'lines',
    predicate: [
      step('cmos-mcp [a-z]+'),
      step('project-root', '', 'exclude'),
      step('^\\s*(//|\\*|/\\*)', '', 'exclude'),
    ],
  },
  {
    mission: 's94-m11',
    id: 'variable',
    count: 1,
    unit: 'lines',
    predicate: [step('\\$\\{command\\} (init|ambient off)')],
  },
];

export function createClassSweepFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'class-sweep-'));
  const artifacts: any[] = [];
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  const put = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  const save = () =>
    artifacts.forEach((a) => put(`tests/sweeps/${a.mission}.json`, JSON.stringify(a)));
  const arm = (id = 'readers') => artifacts.flatMap((a) => a.arms).find((a) => a.id === id);
  const check = () => runClassSweeps(root);
  git('init', '-q');
  for (const d of definitions) {
    let artifact = artifacts.find((a) => a.mission === d.mission);
    if (!artifact) {
      artifact = {
        schemaVersion: 1,
        mission: d.mission,
        defectClass: 'Fixture defect',
        scopeSentence: 'Tracked UTF-8 src lines, every extension.',
        falseNegativeProfile: [
          'Untracked, binary, non-UTF-8 and non-src files; semantic correctness and chronology.',
        ],
        universe: 'tracked-src-utf8-lines',
        recordedAt: { sha: 'a'.repeat(40) },
        arms: [],
      };
      artifacts.push(artifact);
    }
    const predicate = JSON.parse(JSON.stringify(d.predicate));
    const a: any = {
      id: d.id,
      unit: d.unit,
      predicate,
      historical: { count: d.count, matches: [] },
      witnesses: [],
      residual: [...predicate, step('fixed', '', 'exclude')],
    };
    for (let i = 0; i < d.count; i++) {
      const file = `src/${d.id}-${i}.txt`;
      const old =
        d.id === 'readers'
          ? `SELECT ${i} FROM sessions WHERE status = 'active'`
          : d.id === 'inserts'
            ? `INSERT INTO context_snapshots (${i})`
            : d.id === 'literal'
              ? `const old${i} = 'cmos-mcp drafts list';`
              : '`${command} init`';
      const text =
        d.id === 'inserts' ? `${old} fixed storage.columns` : `const fixed_${d.id}_${i} = true;`;
      a.historical.matches.push({
        id: `h${i}`,
        file,
        line: i + 1,
        text: old,
        occurrence: 1,
        class: 'changed',
        reason: 'The old syntax selected the wrong scope.',
        resolution: { witnessIds: [`w${i}`] },
      });
      a.witnesses.push({
        id: `w${i}`,
        file,
        line: 1,
        text,
        occurrence: 1,
        class: 'fixed',
        reason: 'Required replacement syntax.',
      });
      put(file, `${text}\n`);
    }
    artifact.arms.push(a);
  }
  save();
  git('add', '.');
  return { root, artifacts, git, put, save, arm, check };
}
