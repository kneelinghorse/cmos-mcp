// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s88-m08 fail-loud real-store FIRE for the former review/read identity mint.
// ABOUTME: Requires an explicit source root and routes writes only into a hashed tmpdir copy.

/**
 * This is deliberately NOT part of default Jest discovery. Run it through
 * `npm run test:identity-real-store` with CMOS_IDENTITYLESS_REAL_STORE_ROOT set to a real,
 * identity-less CMOS project. The command fails when the source is absent or unsuitable; public
 * CI keeps the portable fixture gates without silently claiming it ran this private fleet proof.
 */

import { createHash } from 'crypto';
import { afterEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../src/index';
import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { READ_ONLY_AGENT_ENV } from '../../src/tools/cmos/read-only-agent-guard';

const REAL_STORE_ROOT_ENV = 'CMOS_IDENTITYLESS_REAL_STORE_ROOT';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DB_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;

interface FileFingerprint {
  readonly exists: boolean;
  readonly size?: number;
  readonly mtimeMs?: number;
  readonly sha256?: string;
}

const tmpDirs: string[] = [];

function fingerprintBundle(dbPath: string): Record<string, FileFingerprint> {
  return Object.fromEntries(
    DB_SUFFIXES.map((suffix) => {
      const file = `${dbPath}${suffix}`;
      if (!fs.existsSync(file)) return [suffix || 'main', { exists: false }];
      const stat = fs.statSync(file);
      return [
        suffix || 'main',
        {
          exists: true,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        },
      ];
    })
  );
}

function recordedProjectId(dbPath: string): string | null {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'project_id'").get() as
      | { value: string }
      | undefined;
    const value = row?.value?.trim() ?? '';
    return value.length > 0 ? value : null;
  } finally {
    db.close();
  }
}

function fallbackIdentity(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const read = (key: string): string => {
      const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row?.value?.trim() ?? '';
    };
    const missionCount = (
      db.prepare('SELECT COUNT(*) AS count FROM missions').get() as { count: number }
    ).count;
    expect(missionCount).toBeGreaterThan(0);
    return (
      read('project_id') || read('dashboard_slug') || read('project_name') || 'unknown-project'
    );
  } finally {
    db.close();
  }
}

function copyBundle(sourceDbPath: string): { projectRoot: string; dbPath: string } {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s88m08-real-store-'));
  tmpDirs.push(projectRoot);
  const dbDir = path.join(projectRoot, 'cmos', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'cmos.sqlite');
  for (const suffix of DB_SUFFIXES) {
    const source = `${sourceDbPath}${suffix}`;
    if (fs.existsSync(source)) fs.copyFileSync(source, `${dbPath}${suffix}`);
  }
  return { projectRoot, dbPath };
}

afterEach(() => {
  ProjectGraphRegistry.resetInstance();
  CmosDetector.resetInstance();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('s88-m08 dedicated identity registration real-store FIRE', () => {
  it('turns the old review/read positive fire negative, then mints only on copy registration', async () => {
    const sourceRoot = process.env[REAL_STORE_ROOT_ENV];
    expect(sourceRoot).toBeTruthy();
    const resolvedSourceRoot = path.resolve(sourceRoot!);
    const sourceDbPath = path.join(resolvedSourceRoot, 'cmos', 'db', 'cmos.sqlite');
    expect(fs.existsSync(sourceDbPath)).toBe(true);
    const sourceBefore = fingerprintBundle(sourceDbPath);
    let operationError: unknown;
    try {
      const { projectRoot, dbPath } = copyBundle(sourceDbPath);
      // Suitability is checked ONLY on the disposable OS-level copy. Even a readonly SQLite open
      // can update or create WAL/SHM bookkeeping, so sourceDbPath is never given to SQLite.
      expect(fingerprintBundle(sourceDbPath)).toEqual(sourceBefore);
      expect(fallbackIdentity(dbPath)).toBe('unknown-project');

      const configDir = path.join(projectRoot, 'config');
      const tmpRealPath = fs.realpathSync(os.tmpdir()) + path.sep;
      expect(fs.realpathSync(projectRoot).startsWith(tmpRealPath)).toBe(true);

      const originalCwd = process.cwd;
      const savedConfigDir = process.env.CMOS_CONFIG_DIR;
      const savedRole = process.env[READ_ONLY_AGENT_ENV];
      process.cwd = () => projectRoot;
      process.env.CMOS_CONFIG_DIR = configDir;
      process.env[READ_ONLY_AGENT_ENV] = 'review';
      ProjectGraphRegistry.resetInstance();
      CmosDetector.resetInstance();

      try {
        const context = await buildMissionProtocolContext();
        const readResult = await executeMissionProtocolTool(
          'cmos_mission',
          { action: 'status', acrossProjects: true },
          context
        );

        expect(readResult.isError).not.toBe(true);
        expect(recordedProjectId(dbPath)).toBeNull();
        const readGraph = await ProjectGraphRegistry.create();
        expect(readGraph.getByStorePath(projectRoot)).toBeNull();

        const structured = readResult.structuredContent as { warnings?: unknown[] } | undefined;
        const warnings = (structured?.warnings ?? []).filter(
          (warning): warning is string =>
            typeof warning === 'string' && warning.includes('NO RECORDED project identity')
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(dbPath);
        expect(readResult.content[0]?.type).toBe('text');
        const answerText = readResult.content[0]?.type === 'text' ? readResult.content[0].text : '';
        expect(answerText.match(/NO RECORDED project identity/g)).toHaveLength(1);
        expect(answerText).toContain(dbPath);
        expect(JSON.stringify(readResult)).not.toContain(resolvedSourceRoot);
        expect(JSON.stringify(readResult)).not.toContain(sourceDbPath);

        delete process.env[READ_ONLY_AGENT_ENV];
        const registration = await executeMissionProtocolTool(
          'cmos_project',
          { action: 'register', projectRoot, name: 's88-m08 real-store copy' },
          context
        );
        expect(registration.isError).not.toBe(true);
        expect(JSON.stringify(registration)).not.toContain(resolvedSourceRoot);
        expect(JSON.stringify(registration)).not.toContain(sourceDbPath);
        const minted = recordedProjectId(dbPath);
        expect(minted).toMatch(UUID_RE);
        const writeGraph = await ProjectGraphRegistry.create();
        expect(writeGraph.getByStorePath(projectRoot)).toBe(minted);
      } finally {
        process.cwd = originalCwd;
        if (savedConfigDir === undefined) delete process.env.CMOS_CONFIG_DIR;
        else process.env.CMOS_CONFIG_DIR = savedConfigDir;
        if (savedRole === undefined) delete process.env[READ_ONLY_AGENT_ENV];
        else process.env[READ_ONLY_AGENT_ENV] = savedRole;
        ProjectGraphRegistry.resetInstance();
        CmosDetector.resetInstance();
      }
    } catch (error) {
      operationError = error;
    }

    let integrityError: unknown;
    try {
      expect(fingerprintBundle(sourceDbPath)).toEqual(sourceBefore);
    } catch (error) {
      integrityError = error;
    }
    if (operationError && integrityError) {
      throw new Error(
        `Real-store FIRE failed and source integrity also changed.\n` +
          `Operation: ${String(operationError)}\nIntegrity: ${String(integrityError)}`
      );
    }
    if (integrityError) throw integrityError;
    if (operationError) throw operationError;
  }, 60_000);
});
