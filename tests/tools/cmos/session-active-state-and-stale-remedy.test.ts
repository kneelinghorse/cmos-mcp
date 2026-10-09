// ABOUTME: s88-m04 — an active-session refusal must carry the state needed to act.
// ABOUTME: Stale-runtime guidance uses the host-session lever the operator actually owns.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cmosAgentOnboard } from '../../../src/tools/cmos/cmos-agent-onboard';
import {
  cmosSessionStart,
  formatSessionStartForLLM,
} from '../../../src/tools/cmos/cmos-session-start';
import {
  getServerHealth,
  initServerHealth,
  resetServerHealth,
  type BuildManifest,
} from '../../../src/server-health';
import { seedCmosDb } from '../../helpers/seedCmosDb';

describe('s88-m04 active-session refusal state', () => {
  let projectRoot: string;
  let dbPath: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s88-m04-active-session-'));
    dbPath = seedCmosDb(projectRoot, { projectName: 's88-m04 active session' });
  });

  afterEach(() => {
    resetServerHealth();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  /**
   * s92-m03: started NOW. A start closes an explicit blocker idle past 12 h with a receipt, so
   * the refusal this suite pins is the refusal by a live session.
   */
  function insertActiveSession(captures: string): string {
    const startedAt = new Date().toISOString();
    const db = new Database(dbPath);
    try {
      db.prepare(
        `INSERT INTO sessions
           (id, type, title, started_at, agent, status, captures, project_id)
         VALUES ('PS-ACTIVE', 'review', 'Existing review',
                 ?, 'tester', 'active', ?, 's88-m04-active-session')`
      ).run(startedAt, captures);
    } finally {
      db.close();
    }
    return startedAt;
  }

  it('returns and renders the active session type, title, start time, and capture count', async () => {
    const startedAt = insertActiveSession(
      JSON.stringify([
        { category: 'decision', content: 'one' },
        { category: 'next-step', content: 'two' },
      ])
    );

    const result = await cmosSessionStart({
      type: 'planning',
      title: 'Must refuse',
      projectRoot,
    });

    expect(result.success).toBe(false);
    expect(result.error?.currentState).toEqual({
      id: 'PS-ACTIVE',
      type: 'review',
      title: 'Existing review',
      startedAt,
      captureCount: 2,
    });
    const rendered = formatSessionStartForLLM(result);
    expect(rendered).toContain('PS-ACTIVE');
    expect(rendered).toContain('review');
    expect(rendered).toContain('Existing review');
    expect(rendered).toContain(startedAt);
    expect(rendered).toMatch(/2 capture/i);
  });

  it('reports an unknown capture count for malformed stored capture JSON', async () => {
    insertActiveSession('{not-json');

    const result = await cmosSessionStart({
      type: 'planning',
      title: 'Must refuse',
      projectRoot,
    });

    expect(result.success).toBe(false);
    expect(result.error?.currentState).toEqual(
      expect.objectContaining({ id: 'PS-ACTIVE', captureCount: null })
    );
    expect(formatSessionStartForLLM(result)).toMatch(/capture count.*unknown/i);
  });
});

describe('s88-m04 stale-runtime remedy', () => {
  let projectRoot: string;
  let dbPath: string;

  const manifest = (buildHash: string, buildTime: string): BuildManifest => ({
    buildHash,
    buildTime,
    fileCount: 1,
  });

  function writeManifest(value: BuildManifest): void {
    const distDir = path.join(projectRoot, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, '.build-manifest.json'), JSON.stringify(value));
  }

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s88-m04-stale-remedy-'));
    dbPath = seedCmosDb(projectRoot, { projectName: 's88-m04 stale remedy' });
    resetServerHealth();
  });

  afterEach(() => {
    resetServerHealth();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  // s93-m11 (the contract critic): the message states the fact and prescribes nothing, never an
  // operator-owned child restart (s88-m04's rule). The remedy depends on where the session runs, so
  // the opener's action names it (the host session here, the checkout's script in this repository),
  // and a fixed remedy in this message no longer contradicts that action.
  it('server health states the stale fact and prescribes no remedy of its own', () => {
    writeManifest(manifest('old-build', '2026-08-28T20:00:00Z'));
    initServerHealth(projectRoot);
    writeManifest(manifest('new-build', '2026-08-28T20:12:00Z'));

    const health = getServerHealth();

    expect(health.codeIsCurrent).toBe(false);
    expect(health.stalenessMessage).toMatch(/running stale code/i);
    expect(health.stalenessMessage).not.toMatch(/restart|new .*host session|reconnect/i);
  });

  it('onboard promotes the same available host-session lever', async () => {
    const db = new Database(dbPath);
    try {
      db.prepare(
        `INSERT INTO sprints (id, title, status, start_date)
         VALUES ('sprint-1', 'Open', 'Active', '2026-08-28')`
      ).run();
    } finally {
      db.close();
    }
    writeManifest(manifest('old-build', '2026-08-28T20:00:00Z'));
    initServerHealth(projectRoot);
    writeManifest(manifest('new-build', '2026-08-28T20:12:00Z'));

    const result = await cmosAgentOnboard({ projectRoot });

    expect(result.success).toBe(true);
    const staleAction = result.data?.suggestedActions.find(
      (action) =>
        /stale code|latest build/i.test(action.action) || /stale code/i.test(action.command)
    );
    expect(staleAction).toBeDefined();
    expect(`${staleAction?.action} ${staleAction?.command}`).toMatch(
      /new .*host session|reconnect/i
    );
    expect(`${staleAction?.action} ${staleAction?.command}`).not.toMatch(
      /restart.*(?:mcp|server)|restart required/i
    );
  });
});
