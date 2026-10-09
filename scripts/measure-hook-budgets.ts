// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m01 — time each CLI verb from a cold process (the built dist/bin.js) on a COPY of this repo's
// ABOUTME: store, and list the modules prompt and stop load. Prints a markdown table with the load average.

/**
 * Usage: npm run build && npx ts-node scripts/measure-hook-budgets.ts [runs]
 *
 * Never touches the live store: it copies cmos/db/cmos.sqlite into a temp project first, and runs
 * every verb with a temp CMOS_CONFIG_DIR. Each run is a fresh `node` process, so module loading
 * is measured the way a hook pays for it.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..');
const BIN = path.join(REPO, 'dist', 'bin.js');
const RUNS = Number(process.argv[2] ?? 5);

const BUDGETS_MS: Record<string, number> = {
  'hook session-start': 3000,
  'hook prompt': 800,
  'hook stop': 500,
  'hook pre-compact': 1000,
  'hook session-end': 1000,
};

function main(): void {
  if (!fs.existsSync(BIN)) throw new Error('Build first: dist/bin.js is missing.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-hook-budgets-'));
  const project = path.join(tmp, 'project');
  fs.mkdirSync(path.join(project, 'cmos', 'db'), { recursive: true });
  const live = path.join(REPO, 'cmos', 'db', 'cmos.sqlite');
  fs.copyFileSync(live, path.join(project, 'cmos', 'db', 'cmos.sqlite'));
  const sizeMb = fs.statSync(live).size / 1024 / 1024;
  const config = path.join(tmp, 'config');
  const preload = path.join(tmp, 'record-modules.js');
  fs.writeFileSync(
    preload,
    `process.on('exit', () => require('fs').writeFileSync(process.env.MODULES_OUT, JSON.stringify(Object.keys(require.cache))));\n`
  );

  const env = {
    ...process.env,
    CMOS_CONFIG_DIR: config,
    CLAUDE_PROJECT_DIR: project,
    CLAUDE_PID: '999999',
    CMOS_AMBIENT: '',
  };
  const load = os.loadavg().map((n) => n.toFixed(2));

  const verbs: Array<{ name: string; args: string[]; stdin?: object }> = [
    {
      name: 'hook session-start',
      args: ['hook', 'session-start'],
      stdin: { session_id: 'budget-run', source: 'startup', cwd: project },
    },
    {
      name: 'hook prompt',
      args: ['hook', 'prompt'],
      stdin: {
        session_id: 'budget-run',
        prompt: 'How does the staleness repair work?',
        cwd: project,
      },
    },
    {
      name: 'hook stop',
      args: ['hook', 'stop'],
      stdin: { session_id: 'budget-run', cwd: project },
    },
    {
      name: 'hook pre-compact',
      args: ['hook', 'pre-compact'],
      stdin: { session_id: 'budget-run', cwd: project },
    },
    {
      name: 'hook session-end',
      args: ['hook', 'session-end'],
      stdin: { session_id: 'budget-run', reason: 'other', cwd: project },
    },
    { name: 'review --format=context', args: ['review', '--format=context'] },
    { name: 'relevant --query', args: ['relevant', '--query', 'staleness repair ledger'] },
    { name: 'ambient', args: ['ambient'] },
  ];

  const rows: string[] = [];
  const closures: Record<string, string[]> = {};
  for (const verb of verbs) {
    const times: number[] = [];
    let stdoutChars = 0;
    for (let i = 0; i < RUNS; i++) {
      const modulesOut = path.join(tmp, `modules-${verb.name.replace(/\W+/g, '-')}.json`);
      const started = process.hrtime.bigint();
      const ran = spawnSync(process.execPath, ['-r', preload, BIN, ...verb.args], {
        cwd: project,
        env: { ...env, MODULES_OUT: modulesOut },
        input: verb.stdin ? JSON.stringify(verb.stdin) : '',
        encoding: 'utf8',
      });
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
      stdoutChars = ran.stdout.length;
      if (i === 0 && fs.existsSync(modulesOut)) {
        closures[verb.name] = JSON.parse(fs.readFileSync(modulesOut, 'utf8')) as string[];
      }
      if (ran.status !== 0 && verb.name.startsWith('hook')) {
        throw new Error(`${verb.name} exited ${ran.status}: ${ran.stderr}`);
      }
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    const max = times[times.length - 1];
    const budget = BUDGETS_MS[verb.name];
    rows.push(
      `| ${verb.name} | ${median.toFixed(0)} | ${max.toFixed(0)} | ${budget ?? '—'} | ${
        budget === undefined ? '—' : max <= budget ? 'yes' : 'NO'
      } | ${stdoutChars} |`
    );
  }

  const ours = (files: string[]) =>
    files
      .filter((f) => f.startsWith(path.join(REPO, 'dist')))
      .map((f) => path.relative(path.join(REPO, 'dist'), f))
      .sort();
  const external = (files: string[]) =>
    [
      ...new Set(
        files
          .filter((f) => f.includes(`${path.sep}node_modules${path.sep}`))
          .map((f) => f.split(`node_modules${path.sep}`).pop()!.split(path.sep)[0])
      ),
    ].sort();

  process.stdout.write(
    `Hook CLI budgets, ${RUNS} cold runs each, on a copy of this repo's store (${sizeMb.toFixed(
      1
    )} MB), node ${process.version}, ${os.cpus().length} CPUs, load average ${load.join(' / ')} ` +
      `at ${new Date().toISOString()}.\n\n` +
      '| Verb | Median ms | Max ms | Budget ms | Within | Stdout chars |\n' +
      '| --- | --- | --- | --- | --- | --- |\n' +
      `${rows.join('\n')}\n\n` +
      `Modules loaded by hook prompt (dist): ${ours(closures['hook prompt'] ?? []).join(', ')}\n` +
      `Packages loaded by hook prompt: ${external(closures['hook prompt'] ?? []).join(', ')}\n` +
      `Modules loaded by hook stop (dist): ${ours(closures['hook stop'] ?? []).join(', ')}\n` +
      `Packages loaded by hook stop: ${external(closures['hook stop'] ?? []).join(', ')}\n` +
      `Modules loaded by hook session-start (dist): ${ours(closures['hook session-start'] ?? []).length}\n`
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

main();
