// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Hook delivery acknowledges actual synchronous bytes, including partial writes and pipe errors.
// ABOUTME: A real child with a closed stdout pipe proves failed output cannot commit recall state.

import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeHookOutput } from '../../src/cli/hook-output';
import { recallStatePath } from '../../src/cli/recall-runtime';
import { seedCmosDb } from '../helpers/seedCmosDb';

it('retries partial byte writes and EINTR without splitting or losing UTF-8 output', () => {
  const chunks: Buffer[] = [];
  let interrupted = false;
  writeHookOutput('hello • world', Date.now() + 1000, (buffer, offset, length) => {
    if (!interrupted) {
      interrupted = true;
      throw Object.assign(new Error('interrupted'), { code: 'EINTR' });
    }
    const count = Math.min(2, length);
    chunks.push(buffer.subarray(offset, offset + count));
    return count;
  });
  expect(Buffer.concat(chunks).toString('utf8')).toBe('hello • world');
});

it.each(['EPIPE', 'EAGAIN'])(
  'propagates %s so delivery rolls back rather than acknowledging it',
  (code) => {
    const error = Object.assign(new Error(code), { code });
    expect(() =>
      writeHookOutput('context', Date.now() + 1000, () => {
        throw error;
      })
    ).toThrow(error);
  }
);

it('refuses expired output and zero-progress writes', () => {
  const write = jest.fn(() => 1);
  expect(() => writeHookOutput('context', Date.now() - 1, write)).toThrow(/deadline/);
  expect(write).not.toHaveBeenCalled();
  expect(() => writeHookOutput('context', Date.now() + 1000, () => 0)).toThrow(/progress/);
});

it('a real broken stdout pipe leaves no completed runtime receipt', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-hook-pipe-'));
  const dbPath = seedCmosDb(path.join(tmp, 'project'));
  const env = { ...process.env, CMOS_CONFIG_DIR: path.join(tmp, 'config') };
  const sourceRoot = path.resolve(__dirname, '../../src');
  // Only transpile the child's source modules in memory. No build or dist writes.
  const program = `
    const fs = require('fs');
    const ts = require(${JSON.stringify(require.resolve('typescript'))});
    require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(
      fs.readFileSync(filename,'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename);
    const { deliverFirstPrompt } = require(${JSON.stringify(path.join(sourceRoot, 'cli/recall-runtime.ts'))});
    const { processIo } = require(${JSON.stringify(path.join(sourceRoot, 'cli/core.ts'))});
    const io = processIo();
    process.on('message', () => {
      let error = null;
      try {
        const text = '  • d:1 A concrete decision.';
        deliverFirstPrompt({ dbPath: ${JSON.stringify(dbPath)}, rawSessionId:'pipe-session',
          env: process.env, deadlineAtMs: Date.now()+5000 },
          () => ({ text, returnedIds:['d:1'], items:[{typedId:'d:1',start:0,end:text.length}] }),
          (context) => { io.hookStdout(context.text, Date.now()+5000); return context.text; });
      } catch (caught) { error = caught.code || caught.message; }
      process.send({error}, () => process.exit(0));
    });
    process.send({ready:true});
  `;
  const child = spawn(process.execPath, ['-e', program], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  try {
    const result = await new Promise<{ error: string | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pipe child timeout')), 15000);
      child.once('error', reject);
      child.on('message', (message: { ready?: boolean; error?: string | null }) => {
        if (message.ready) {
          child.stdout!.destroy();
          child.send('write');
        } else {
          clearTimeout(timer);
          resolve({ error: message.error ?? null });
        }
      });
      child.stderr!.resume();
    });
    expect(result.error).toBe('EPIPE');
    const db = new Database(recallStatePath('pipe-session', env), { readonly: true });
    try {
      expect(db.prepare('SELECT * FROM delivery').all()).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, 20000);
