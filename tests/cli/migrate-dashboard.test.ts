// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Migration updates a verified dashboard identity's local path without creating a new project.
// ABOUTME: Real loopback HTTP proves auth, form, refusal, redirect validation and durable retry.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import http from 'http';
import { once } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { DashboardClient } from '../../src/tools/rbook/dashboard-client';
import { migrateProject } from '../../src/cli/migrate';
import { PENDING } from '../../src/cli/migrate-store';
import { seedLegacyMigrationStore } from '../helpers/legacyMigrationStore';

let tmp: string;
let root: string;
let home: string;
let server: http.Server;
let client: DashboardClient;
let requests: Array<{ url: string; method: string; auth: string | undefined; body: string }>;
let response: { status: number; location?: string };
let incumbent: { id: string; name: string; slug: string; isOwner: boolean };
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-migrate-dashboard-'));
  root = path.join(tmp, 'project');
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  const db = new Database(seedLegacyMigrationStore(root));
  const set = db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)');
  for (const [key, value] of Object.entries({
    project_id: 'local-stable-id',
    project_name: 'Human display name',
    dashboard_project_id: 'dashboard-stable-id',
    dashboard_slug: 'custom-incumbent-slug',
    dashboard_registered: 'true',
  }))
    set.run(key, value);
  db.close();
  incumbent = {
    id: 'dashboard-stable-id',
    name: 'Human display name',
    slug: 'custom-incumbent-slug',
    isOwner: true,
  };
  requests = [];
  response = { status: 302, location: '/projects/dashboard-stable-id/shares?status=path_updated' };
  server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (s) => {
      body += s;
    });
    req.on('end', () => {
      requests.push({ url: req.url!, method: req.method!, auth: req.headers.authorization, body });
      if (req.url === '/api/projects/me') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, data: { projects: [incumbent] } }));
        return;
      }
      res.statusCode = response.status;
      if (response.location) res.setHeader('Location', response.location);
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  client = new DashboardClient({
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    apiKey: 'cmk_fixture_only',
  });
  jest.spyOn(DashboardClient, 'fromEnvForProject').mockResolvedValue({
    success: true,
    data: { client, keySource: 'project-scoped', matchedProjectRoot: root },
  });
});
afterEach(async () => {
  jest.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});
const options = () => ({
  projectRoot: root,
  env: { HOME: home },
  apply: true,
  checkProcesses: false,
});

describe('the dashboard local-path receipt', () => {
  it('uses the incumbent dashboard id and leaves name, slug and local id untouched through failure and retry', async () => {
    const config = path.join(home, '.config/rbook');
    fs.mkdirSync(config, { recursive: true });
    const registry = new Database(path.join(config, 'project-graph.sqlite'));
    registry.exec(
      'CREATE TABLE projects(store_path TEXT,last_seen_at INTEGER,archived_at INTEGER)'
    );
    registry.prepare('INSERT INTO projects VALUES (?,1,2)').run(root);
    registry.prepare('INSERT INTO projects VALUES (?,1,2)').run(path.join(tmp, 'other'));
    registry.close();
    response = { status: 503 };
    const first = await migrateProject(options());
    expect(first.success).toBe(false);
    expect(first.error?.message).toContain('Dashboard path update remains pending');
    expect(fs.existsSync(path.join(root, PENDING))).toBe(true);
    response = {
      status: 302,
      location: '/projects/dashboard-stable-id/shares?status=path_updated',
    };
    expect((await migrateProject(options())).success).toBe(true);
    const posts = requests.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      expect(post.url).toBe('/projects/dashboard-stable-id/local-path');
      expect(post.auth).toBe('Bearer cmk_fixture_only');
      expect(new URLSearchParams(post.body).get('localDbPath')).toBe(
        path.join(root, 'rbook/db/rbook.sqlite')
      );
      expect(new URLSearchParams(post.body).has('projectName')).toBe(false);
    }
    expect(requests.every((r) => !r.url.includes('shares') && !r.url.includes('register'))).toBe(
      true
    );
    expect(fs.existsSync(path.join(root, PENDING))).toBe(false);
    const read = new Database(path.join(config, 'project-graph.sqlite'), { readonly: true });
    expect(read.prepare('SELECT archived_at FROM projects WHERE store_path=?').get(root)).toEqual({
      archived_at: null,
    });
    expect(
      read.prepare('SELECT last_seen_at,archived_at FROM projects WHERE store_path!=?').get(root)
    ).toEqual({ last_seen_at: 1, archived_at: 2 });
    read.close();
  });
  it.each([{ slug: 'another-project' }, { id: 'another-id' }, { isOwner: false }])(
    'refuses an unconfirmed incumbent %j before any dashboard write',
    async (change) => {
      incumbent = { ...incumbent, ...change };
      const result = await migrateProject(options());
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('incumbent');
      expect(requests.every((r) => r.method === 'GET')).toBe(true);
      expect(fs.existsSync(path.join(root, PENDING))).toBe(true);
    }
  );
  it.each([
    { status: 302, location: '/login' },
    {
      status: 302,
      location: 'https://other.example/projects/dashboard-stable-id/shares?status=path_updated',
    },
    { status: 401 },
    { status: 200 },
  ])('never counts an auth/redirect/nonreceipt response as success: %j', async (next) => {
    response = next;
    const result = await client.updateLocalProjectPath('dashboard-stable-id', '/tmp/record.sqlite');
    expect(result.success).toBe(false);
    expect(requests).toHaveLength(1);
  });
});
