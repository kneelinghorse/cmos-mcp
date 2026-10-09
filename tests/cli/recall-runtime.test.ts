// SPDX-License-Identifier: Apache-2.0
// ABOUTME: First-prompt ownership stays locked through output and records only successful delivery.
// ABOUTME: Real temporary SQLite files prove retries, concurrent claims, privacy and store isolation.

import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  deliverFirstPrompt,
  deliverPromptRecall,
  recallStatePath,
} from '../../src/cli/recall-runtime';
import { seedCmosDb } from '../helpers/seedCmosDb';

let tmp: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
const rendered = {
  text: 'Relevant context:\n  • d:1 Keep database reads read-only.',
  returnedIds: ['d:1'],
  items: [{ typedId: 'd:1', start: 18, end: 54 }],
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-recall-runtime-'));
  dbPath = seedCmosDb(path.join(tmp, 'project'), { projectId: 'runtime-test' });
  env = { CMOS_CONFIG_DIR: path.join(tmp, 'config') };
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function options(rawSessionId = 'secret-session') {
  return { dbPath, rawSessionId, env, deadlineAtMs: Date.now() + 10_000 };
}

function state() {
  const db = new Database(recallStatePath('secret-session', env), { readonly: true });
  try {
    return db.prepare('SELECT completed, ids FROM delivery').all();
  } finally {
    db.close();
  }
}

it('commits only after synchronous stdout succeeds and dedupes the session/store', () => {
  const emit = jest.fn((context) => context.text);
  deliverFirstPrompt(options(), () => rendered, emit);
  deliverFirstPrompt(options(), () => rendered, emit);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(state()).toEqual([{ completed: 1, ids: '["d:1"]' }]);
  const bytes = fs.readFileSync(recallStatePath('secret-session', env)).toString('utf8');
  expect(bytes).not.toContain('secret-session');
  expect(bytes).not.toContain('Keep database reads');
});

it('keeps first delivery and seen IDs when the same session changes a store spelling', () => {
  const aliasRoot = path.join(fs.realpathSync.native(tmp), 'PROJECT');
  if (!fs.existsSync(aliasRoot)) fs.symlinkSync(path.join(tmp, 'project'), aliasRoot, 'dir');
  const aliasPath = path.join(aliasRoot, 'cmos', 'db', 'cmos.sqlite');
  const original = fs.realpathSync;
  // Native resolution is real; the non-native double models macOS on case-sensitive CI too.
  const nonNative = jest
    .spyOn(require('fs') as typeof fs, 'realpathSync')
    .mockImplementation((...args) => {
      if (args[0] === aliasPath) return aliasPath;
      return original(...args);
    });
  Object.assign(nonNative, { native: original.native });
  expect(fs.realpathSync(aliasPath)).not.toBe(fs.realpathSync.native(aliasPath));
  expect(fs.realpathSync.native(aliasPath)).toBe(fs.realpathSync.native(dbPath));

  const emit = jest.fn((context) => context.text);
  deliverFirstPrompt({ ...options(), dbPath: aliasPath }, () => rendered, emit);
  const later = jest.fn((first: boolean, seen: readonly string[]) => {
    expect(first).toBe(false);
    expect(seen).toEqual(['d:1']);
    return null;
  });
  deliverPromptRecall(options(), later, emit);
  deliverFirstPrompt(options(), () => rendered, emit);
  expect(later).toHaveBeenCalledTimes(1);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(state()).toEqual([{ completed: 1, ids: '["d:1"]' }]);
});

it('holds an immediate transaction across stdout, so another connection cannot claim', () => {
  deliverFirstPrompt(
    options(),
    () => rendered,
    (context) => {
      const second = new Database(recallStatePath('secret-session', env), { timeout: 0 });
      try {
        expect(() => second.exec('BEGIN IMMEDIATE')).toThrow(/locked/);
      } finally {
        second.close();
      }
      return context.text;
    }
  );
});

it('a separate process cannot take delivery ownership while stdout is in progress', () => {
  deliverFirstPrompt(
    options(),
    () => rendered,
    (context) => {
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          `
      const DB = require('better-sqlite3');
      const db = new DB(process.argv[1], {timeout: 0});
      try { db.exec('BEGIN IMMEDIATE'); process.stdout.write('claimed'); }
      catch (error) { process.stdout.write(error.code); }
      finally { db.close(); }
    `,
          recallStatePath('secret-session', env),
        ],
        { encoding: 'utf8', timeout: 5000 }
      );
      expect(child.status).toBe(0);
      expect(child.stdout).toBe('SQLITE_BUSY');
      return context.text;
    }
  );
});

it('rolls back failed output and allows retry without marking delivered', () => {
  expect(() =>
    deliverFirstPrompt(
      options(),
      () => rendered,
      () => {
        throw new Error('stdout failed');
      }
    )
  ).toThrow('stdout failed');
  expect(state()).toEqual([]);
  const emit = jest.fn((context) => context.text);
  deliverFirstPrompt(options(), () => rendered, emit);
  expect(emit).toHaveBeenCalledTimes(1);
});

it('releases failed queries and late work; neither calls stdout nor commits', () => {
  const emit = jest.fn((context) => context.text);
  expect(() =>
    deliverFirstPrompt(
      options(),
      () => {
        throw new Error('query failed');
      },
      emit
    )
  ).toThrow('query failed');
  const late = options();
  expect(() =>
    deliverFirstPrompt(
      late,
      () => {
        late.deadlineAtMs = Date.now() - 1;
        return rendered;
      },
      emit
    )
  ).toThrow(/deadline/);
  expect(emit).not.toHaveBeenCalled();
  expect(state()).toEqual([]);
});

it('an available empty search consumes the first attempt without stdout', () => {
  const emit = jest.fn((context) => context.text);
  deliverFirstPrompt(options(), () => ({ text: '', returnedIds: [], items: [] }), emit);
  deliverFirstPrompt(options(), () => rendered, emit);
  expect(emit).not.toHaveBeenCalled();
  expect(state()).toEqual([{ completed: 1, ids: '[]' }]);
});

it('stores only complete emitted spans, and different stores/sessions can each deliver', () => {
  const emit = jest.fn((context) => context.text.slice(0, 30));
  deliverFirstPrompt(options(), () => rendered, emit);
  expect(state()).toEqual([{ completed: 1, ids: '[]' }]);
  deliverFirstPrompt(options('other-session'), () => rendered, emit);
  const otherPath = seedCmosDb(path.join(tmp, 'other'), { projectId: 'runtime-test' });
  deliverFirstPrompt({ ...options(), dbPath: otherPath }, () => rendered, emit);
  expect(emit).toHaveBeenCalledTimes(3);
});

it.each([
  'config-in-project',
  'linked-directory',
  'linked-file',
  'hardlinked-file',
  'linked-journal',
])('rejects %s before a project write and leaves a safe retry possible', (kind) => {
  const project = path.dirname(path.dirname(path.dirname(dbPath)));
  const unsafe = { ...env };
  if (kind === 'config-in-project') unsafe.CMOS_CONFIG_DIR = project;
  else {
    const file = recallStatePath('secret-session', unsafe);
    fs.mkdirSync(path.dirname(path.dirname(file)), { recursive: true });
    if (kind === 'linked-directory') fs.symlinkSync(project, path.dirname(file));
    else {
      fs.mkdirSync(path.dirname(file));
      if (kind === 'linked-journal') fs.symlinkSync(dbPath, `${file}-journal`);
      else if (kind === 'linked-file') fs.symlinkSync(dbPath, file);
      else fs.linkSync(dbPath, file);
    }
  }
  const before = fs.readFileSync(dbPath);
  const files = fs.readdirSync(project).sort();
  const emit = jest.fn((context) => context.text);
  expect(() => deliverFirstPrompt({ ...options(), env: unsafe }, () => rendered, emit)).toThrow(
    /unsafe|outside|linked/
  );
  expect(emit).not.toHaveBeenCalled();
  expect(fs.readFileSync(dbPath)).toEqual(before);
  expect(fs.readdirSync(project).sort()).toEqual(files);
  const safe = { CMOS_CONFIG_DIR: path.join(tmp, 'safe-config') };
  deliverFirstPrompt({ ...options(), env: safe }, () => rendered, emit);
  expect(emit).toHaveBeenCalledTimes(1);
});

it('keeps complete digest and recall spans as seen without consuming the first prompt', () => {
  const { deliverPromptRecall, deliverRecallContext } = require('../../src/cli/recall-runtime');
  const prepare = jest.fn((first: boolean, seen: string[]) => {
    expect(first).toBe(true);
    expect(seen).toEqual(['d:1']);
    return {
      text: '  • d:2 Decision two.',
      returnedIds: ['d:2'],
      items: [{ typedId: 'd:2', start: 0, end: 20 }],
    };
  });
  deliverRecallContext(options(), rendered, (context: typeof rendered) => context.text);
  deliverPromptRecall(options(), prepare, (context: typeof rendered) => context.text);
  const later = jest.fn((first: boolean, seen: string[]) => {
    expect(first).toBe(false);
    expect(seen).toEqual(['d:1', 'd:2']);
    return null;
  });
  deliverPromptRecall(options(), later, (context: typeof rendered) => context.text);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(later).toHaveBeenCalledTimes(1);
});

it('never marks clipped or failed digest spans seen and later output failure remains retryable', () => {
  const { deliverPromptRecall, deliverRecallContext } = require('../../src/cli/recall-runtime');
  deliverRecallContext(options(), rendered, () => rendered.text.slice(0, 30));
  expect(() =>
    deliverRecallContext(options(), rendered, () => {
      throw new Error('closed output');
    })
  ).toThrow('closed output');
  deliverPromptRecall(
    options(),
    () => ({ text: '', returnedIds: [], items: [] }),
    () => ''
  );
  const prepare = jest.fn((first: boolean, seen: string[]) => {
    expect(first).toBe(false);
    expect(seen).toEqual([]);
    return rendered;
  });
  expect(() =>
    deliverPromptRecall(options(), prepare, () => {
      throw new Error('closed output');
    })
  ).toThrow('closed output');
  deliverPromptRecall(options(), prepare, (context: typeof rendered) => context.text);
  expect(prepare).toHaveBeenCalledTimes(2);
});
