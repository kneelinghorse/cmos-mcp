import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { CmosDetector } from '../../src/intelligence/cmos-detector';

async function createTempWorkspace(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function ensureSqliteFile(workspace: string): Promise<string> {
  const dbPath = path.join(workspace, 'cmos', 'db');
  await fs.mkdir(dbPath, { recursive: true });
  const sqlitePath = path.join(dbPath, 'cmos.sqlite');
  await fs.writeFile(sqlitePath, 'pragma user_version = 1;\n');
  return sqlitePath;
}

describe('CmosDetector', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await createTempWorkspace('cmos-detector-');
    CmosDetector.resetInstance();
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  test('reports missing cmos directory', async () => {
    const detector = CmosDetector.getInstance({ nowProvider: () => 0 });
    const result = await detector.detect(workspace);

    expect(result.hasCmosDirectory).toBe(false);
    expect(result.hasDatabase).toBe(false);
    expect(result.databasePath).toBeUndefined();
  });

  test('detects sqlite database when present', async () => {
    const sqlitePath = await ensureSqliteFile(workspace);
    const detector = CmosDetector.getInstance({ nowProvider: () => Date.now() });

    const result = await detector.detect(workspace);

    expect(result.hasCmosDirectory).toBe(true);
    expect(result.hasDatabase).toBe(true);
    expect(result.databasePath).toBe(sqlitePath);
  });

  test('caches results until TTL expires', async () => {
    let now = 1_000;
    const detector = CmosDetector.getInstance({ cacheTtlMs: 50, nowProvider: () => now });
    const sqlitePath = await ensureSqliteFile(workspace);

    const first = await detector.detect(workspace);
    expect(first.databasePath).toBe(sqlitePath);
    expect(first.hasDatabase).toBe(true);

    await fs.unlink(sqlitePath);

    const cached = await detector.detect(workspace);
    expect(cached.hasDatabase).toBe(true);

    now += 60;
    const refreshed = await detector.detect(workspace);
    expect(refreshed.hasDatabase).toBe(false);
  });

  test('forceRefresh bypasses cache', async () => {
    const detector = CmosDetector.getInstance({ nowProvider: () => Date.now() });
    const sqlitePath = await ensureSqliteFile(workspace);

    const initial = await detector.detect(workspace);
    expect(initial.databasePath).toBe(sqlitePath);

    await fs.unlink(sqlitePath);

    const refreshed = await detector.detect(workspace, { forceRefresh: true });
    expect(refreshed.hasDatabase).toBe(false);
  });
});
