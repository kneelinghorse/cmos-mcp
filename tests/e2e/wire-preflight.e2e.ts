// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s90-m04 — exhaustive first-run and wrong-projectRoot checks over real MCP stdio
// ABOUTME: against the BUILT dist, with the wire universe derived from tools/list at runtime.

/**
 * Sprint 90 m04 — prove the front-door classifications at the boundary callers use.
 *
 * This suite deliberately derives every (tool, action) pair from the built server's own
 * `tools/list` response. A router-only test is the wrong universe: src/index.ts consumes
 * projectRoot before router dispatch, which is how 2.8.1's otherwise-correct router guard
 * left the wire class open. The independent arithmetic, uniqueness, and tool-coverage checks
 * below make a short or duplicated walk fail rather than silently shrinking the census.
 *
 * The test has no private evidence and no live-store dependency. It uses isolated temp fixtures
 * for literal first-run, initialized-project, wrong-root, and missing-database states. Every
 * server gets a literal environment whitelist with isolated HOME + CMOS_CONFIG_DIR and pins
 * CMOS_PROJECT_ROOT to its own scratch cwd so the repository .env cannot enter the process.
 * The sweeps that exercise runnable auth actions use a 127.0.0.1 dashboard double. The dedicated
 * auth harness leaves CMOS_DASHBOARD_URL unset and preloads a strict baked-host redirect, so the
 * built artifact proves default resolution without permitting a live-network request.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { startDashboardDouble, type DashboardDouble } from '../helpers/suggestion-axes-external';
import { connectStdioServer, type StdioHarness, type ToolResult } from './stdio-harness';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
const DASHBOARD_DEFAULT_REDIRECT_PRELOAD = path.join(
  __dirname,
  'fixtures',
  'dashboard-default-redirect.cjs'
);
const INVALID_ACTION = '__s90_m04_invalid_action__';
const UNKNOWN_TOOL = '__s90_m04_unknown_tool__';
const REQUEST_TIMEOUT_MS = 5_000;
const AUTH_LOOPBACK_PAIR_KEYS = new Set(['cmos_auth\0login', 'cmos_auth\0login_init']);
const LOGIN_COMPLETE_PAIR_KEY = 'cmos_auth\0login_complete';
const WIRE_DASHBOARD_PROJECT_ID = '823c15ea-8a9b-4a70-bc54-444b4e8b2f45';

const WRONG_PROJECT_ROOTS = [
  { label: 'integer-12345', value: 12_345 },
  { label: 'boolean-true', value: true },
  { label: 'array-empty', value: [] },
  { label: 'object-empty', value: {} },
  { label: 'number-zero', value: 0 },
  { label: 'number-fractional-1.5', value: 1.5 },
] as const;

interface PublishedTool {
  name: string;
  inputSchema: {
    properties?: Record<string, unknown>;
  };
}

interface PublishedPair {
  tool: string;
  action: string | null;
}

interface WireEnvironment extends Record<string, string> {
  HOME: string;
  CMOS_CONFIG_DIR: string;
  CMOS_PROJECT_ROOT: string;
  PATH: string;
  NODE_ENV: string;
}

interface ObservedFailure {
  specimen?: string;
  pair: string;
  isError: boolean;
  code: string | null;
  field: string | null;
  text: string;
}

const tmpDirs: string[] = [];
const harnesses: StdioHarness[] = [];
const environments: Array<{
  cwd: string;
  environment: WireEnvironment;
  dashboardUrl?: string;
}> = [];

function mkTmp(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(directory);
  return directory;
}

function isolatedEnvironment(prefix: string, cwd: string, dashboardUrl?: string): WireEnvironment {
  // This object is intentionally a literal whitelist. In particular, do not spread
  // process.env: dashboard credentials would invalidate the fixture. CMOS_PROJECT_ROOT
  // is deliberately pinned to cwd so dist/index.js cannot bootstrap the repository .env.
  const environment: WireEnvironment = {
    HOME: mkTmp(`${prefix}-home-`),
    CMOS_CONFIG_DIR: mkTmp(`${prefix}-config-`),
    CMOS_PROJECT_ROOT: cwd,
    PATH: process.env.PATH ?? path.dirname(process.execPath),
    NODE_ENV: 'test',
  };
  if (dashboardUrl !== undefined) {
    environment.CMOS_DASHBOARD_URL = dashboardUrl;
    environment.NODE_OPTIONS = `--require=${DASHBOARD_DEFAULT_REDIRECT_PRELOAD}`;
    environment.CMOS_TEST_DASHBOARD_REDIRECT_ORIGIN = dashboardUrl;
  }
  environments.push({ cwd, environment, dashboardUrl });
  return environment;
}

/** Give the initialized fixture the identity facts required by the strict sender boundary. */
function seedValidSenderIdentity(projectRoot: string): void {
  const databasePath = path.join(projectRoot, 'cmos', 'db', 'cmos.sqlite');
  const db = new Database(databasePath);
  const now = new Date().toISOString();
  const identity = {
    project_id: 's90-m04-wire-fixture',
    project_name: 's90-m04-wire-fixture',
    cmos_address: 'cmos://wire-e2e/s90-m04-wire-fixture',
  };

  try {
    db.transaction(() => {
      db.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)`).run(
        'dashboard_project_id',
        WIRE_DASHBOARD_PROJECT_ID
      );
      db.prepare(
        `INSERT OR REPLACE INTO contexts (id, source_path, content, updated_at)
         VALUES ('project_identity', 'cmos/contexts/project-identity.json', ?, ?)`
      ).run(JSON.stringify(identity), now);
    })();
  } finally {
    db.close();
  }
}

function actionEnum(tool: PublishedTool): string[] | null {
  const properties = tool.inputSchema.properties;
  if (!properties || !Object.prototype.hasOwnProperty.call(properties, 'action')) return null;

  const actionSchema = properties.action;
  const value =
    actionSchema !== null && typeof actionSchema === 'object'
      ? (actionSchema as Record<string, unknown>).enum
      : undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw new Error(
      `tools/list published a malformed action schema for ${tool.name}: ${JSON.stringify(actionSchema)}`
    );
  }
  return value;
}

function derivePairs(tools: readonly PublishedTool[]): PublishedPair[] {
  const pairs: PublishedPair[] = [];
  for (const tool of tools) {
    const actions = actionEnum(tool);
    if (actions === null) pairs.push({ tool: tool.name, action: null });
    else for (const action of actions) pairs.push({ tool: tool.name, action });
  }
  return pairs;
}

function pairKey(pair: PublishedPair): string {
  return `${pair.tool}\0${pair.action ?? '<actionless>'}`;
}

function displayPair(pair: PublishedPair): string {
  return `${pair.tool}(${pair.action ?? 'actionless'})`;
}

function argsFor(
  pair: PublishedPair,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return pair.action === null ? { ...extra } : { action: pair.action, ...extra };
}

async function callBounded(
  harness: StdioHarness,
  pair: PublishedPair,
  args: Record<string, unknown>
): Promise<ToolResult> {
  return (await harness.client.callTool({ name: pair.tool, arguments: args }, undefined, {
    timeout: REQUEST_TIMEOUT_MS,
  })) as ToolResult;
}

function textOf(result: ToolResult): string {
  return (result.content ?? []).map((part) => part.text ?? '').join('\n');
}

function prescribedInitRoot(result: ToolResult): string {
  const suggestion = result.structuredContent?.error?.suggestion;
  if (typeof suggestion !== 'string') {
    throw new Error(`Expected an init prescription, received ${JSON.stringify(suggestion)}`);
  }
  const match = suggestion.match(/cmos_project\(action="init", projectRoot=("(?:\\.|[^"\\])*")\)/);
  if (!match) {
    throw new Error(`Init prescription does not carry a JSON-string projectRoot: ${suggestion}`);
  }
  const projectRoot: unknown = JSON.parse(match[1]);
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new Error(`Init prescription carries an invalid projectRoot: ${match[1]}`);
  }
  return projectRoot;
}

function observedFailure(
  pair: PublishedPair,
  result: ToolResult,
  specimen?: string
): ObservedFailure {
  const error = result.structuredContent?.error;
  return {
    specimen,
    pair: displayPair(pair),
    isError: result.isError === true,
    code: typeof error?.code === 'string' ? error.code : null,
    field: typeof error?.field === 'string' ? error.field : null,
    text: textOf(result).slice(0, 500),
  };
}

function hasCatchAllDisclosure(result: ToolResult): boolean {
  const rendered = JSON.stringify(result);
  return (
    rendered.includes('TOOL_EXECUTION_ERROR') ||
    rendered.includes('capture the tool inputs and report this') ||
    rendered.includes('correlationId')
  );
}

function sortedCounts(counts: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))
  );
}

function normalizeWireString(value: string, environment: WireEnvironment): string {
  const fixturePaths: Array<[string, string]> = [
    [environment.CMOS_PROJECT_ROOT, '<PROJECT_ROOT>'],
    [environment.CMOS_CONFIG_DIR, '<CONFIG_DIR>'],
    [environment.HOME, '<HOME>'],
  ];
  let normalized = value;
  for (const [fixturePath, token] of fixturePaths) {
    normalized = normalized.split(fixturePath).join(token);
  }
  return normalized
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      '<UUID>'
    )
    .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, '<ULID>')
    .replace(/\bsnapshot-\d{8}T\d{9}Z-[0-9a-f]+\b/gi, '<SNAPSHOT_ID>')
    .replace(/\bpid=\d+\b/g, 'pid=<PID>')
    .replace(/\bmem=\d+(?:\.\d+)?MB\b/g, 'mem=<MEMORY_MB>')
    .replace(/\buptime=\d+(?:\.\d+)?s\b/g, 'uptime=<UPTIME>')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<TIMESTAMP>');
}

function normalizeWireValue(value: unknown, environment: WireEnvironment): unknown {
  if (typeof value === 'string') return normalizeWireString(value, environment);
  if (Array.isArray(value)) {
    return value.map((item) => normalizeWireValue(item, environment));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (key === 'pid') return [key, '<PID>'];
        if (key === 'memoryUsageMb') return [key, '<MEMORY_MB>'];
        if (key === 'uptimeSeconds') return [key, '<UPTIME_SECONDS>'];
        return [key, normalizeWireValue(item, environment)];
      })
    );
  }
  return value;
}

async function sweepProjectRootSemantics(
  harness: StdioHarness,
  environment: WireEnvironment,
  publishedPairs: readonly PublishedPair[],
  projectRoot: 'omitted' | 'null'
): Promise<Map<string, unknown>> {
  const observations = new Map<string, unknown>();
  const catchAllPairs: string[] = [];

  for (const pair of publishedPairs) {
    const args = argsFor(pair, projectRoot === 'null' ? { projectRoot: null } : {});
    const result = await callBounded(harness, pair, args);
    if (hasCatchAllDisclosure(result)) catchAllPairs.push(pairKey(pair));
    observations.set(pairKey(pair), normalizeWireValue(result, environment));
  }

  expect(observations.size).toBe(publishedPairs.length);
  for (const authPair of AUTH_LOOPBACK_PAIR_KEYS) expect(observations.has(authPair)).toBe(true);
  expect(catchAllPairs).toEqual([]);
  return observations;
}

function expectHermeticDeviceFlowRequests(
  dashboard: DashboardDouble,
  expectedTokenRequests = 1
): void {
  const requests = [...dashboard.requests];
  expect(requests).toHaveLength(2 + expectedTokenRequests);
  expect(requests.every((request) => request.matchedScenario)).toBe(true);
  expect(requests.every((request) => request.authorization === '')).toBe(true);
  expect(requests.map(({ method, url }) => `${method} ${url}`).sort()).toEqual([
    'POST /api/auth/device/code',
    'POST /api/auth/device/code',
    ...Array.from({ length: expectedTokenRequests }, () => 'POST /api/auth/device/token'),
  ]);
}

describe('s90-m04 wire preflight and first-run classification over built stdio', () => {
  let tools: PublishedTool[];
  let pairs: PublishedPair[];
  let firstRunHarness: StdioHarness;
  let authBoundaryHarness: StdioHarness;
  let initializedHarness: StdioHarness;
  let missingDbHarness: StdioHarness;
  let omittedRootHarness: StdioHarness;
  let nullRootHarness: StdioHarness;
  let omittedRootEnvironment: WireEnvironment;
  let nullRootEnvironment: WireEnvironment;
  let firstRunRoot: string;
  let initializedRoot: string;
  let missingDbRoot: string;
  let dashboardDouble: DashboardDouble;

  beforeAll(async () => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/index.js not found at ${DIST_ENTRY}. This suite drives the BUILT server; ` +
          'run `npm run build` first. It must never skip when the artifact is absent.'
      );
    }

    // login is deliberately terminated by the double before it can persist a credential.
    // That keeps later first-run actions credential-free while still driving both RFC endpoints.
    dashboardDouble = await startDashboardDouble({
      kind: 'device-terminal',
      expectedAuthorization: '',
      outcome: 'expired_token',
      errorDescription: 'wire preflight terminal fixture',
    });

    const authBoundaryRoot = mkTmp('cmos-s90-m04-auth-boundary-');
    const authBoundaryEnvironment = isolatedEnvironment(
      'cmos-s90-m04-auth-boundary',
      authBoundaryRoot
    );
    authBoundaryEnvironment.NODE_OPTIONS = `--require=${DASHBOARD_DEFAULT_REDIRECT_PRELOAD}`;
    authBoundaryEnvironment.CMOS_TEST_DASHBOARD_REDIRECT_ORIGIN = dashboardDouble.origin;
    authBoundaryHarness = await connectStdioServer({
      serverPath: DIST_ENTRY,
      cwd: authBoundaryRoot,
      env: authBoundaryEnvironment,
      clientName: 's90-m04-auth-boundary-wire',
    });
    harnesses.push(authBoundaryHarness);
    await authBoundaryHarness.callOk('cmos_project', {
      action: 'init',
      projectRoot: authBoundaryRoot,
      projectName: 's90-m04-auth-loopback-fixture',
    });

    firstRunRoot = mkTmp('cmos-s90-m04-first-run-');
    firstRunHarness = await connectStdioServer({
      serverPath: DIST_ENTRY,
      cwd: firstRunRoot,
      env: isolatedEnvironment('cmos-s90-m04-first-run', firstRunRoot, dashboardDouble.origin),
      clientName: 's90-m04-first-run-wire',
    });
    harnesses.push(firstRunHarness);

    const listed = await firstRunHarness.client.listTools();
    tools = listed.tools as PublishedTool[];
    pairs = derivePairs(tools);

    initializedRoot = mkTmp('cmos-s90-m04-initialized-');
    initializedHarness = await connectStdioServer({
      serverPath: DIST_ENTRY,
      cwd: initializedRoot,
      env: isolatedEnvironment('cmos-s90-m04-initialized', initializedRoot),
      clientName: 's90-m04-wrong-root-wire',
    });
    harnesses.push(initializedHarness);
    await initializedHarness.callOk('cmos_project', {
      action: 'init',
      projectRoot: initializedRoot,
      projectName: 's90-m04-wire-fixture',
    });
    seedValidSenderIdentity(initializedRoot);

    missingDbRoot = mkTmp('cmos-s90-m04-missing-db-');
    fs.mkdirSync(path.join(missingDbRoot, 'cmos', 'db'), { recursive: true });
    missingDbHarness = await connectStdioServer({
      serverPath: DIST_ENTRY,
      cwd: missingDbRoot,
      env: isolatedEnvironment('cmos-s90-m04-missing-db', missingDbRoot),
      clientName: 's90-m04-missing-db-wire',
    });
    harnesses.push(missingDbHarness);

    const omittedRoot = mkTmp('cmos-s90-m04-omitted-root-');
    omittedRootEnvironment = isolatedEnvironment(
      'cmos-s90-m04-omitted-root',
      omittedRoot,
      dashboardDouble.origin
    );
    omittedRootHarness = await connectStdioServer({
      serverPath: DIST_ENTRY,
      cwd: omittedRoot,
      env: omittedRootEnvironment,
      clientName: 's90-m04-omitted-root-wire',
    });
    harnesses.push(omittedRootHarness);
    await omittedRootHarness.callOk('cmos_project', {
      action: 'init',
      projectRoot: omittedRoot,
      projectName: 's90-m04-null-semantics',
    });

    const nullRoot = mkTmp('cmos-s90-m04-null-root-');
    nullRootEnvironment = isolatedEnvironment(
      'cmos-s90-m04-null-root',
      nullRoot,
      dashboardDouble.origin
    );
    nullRootHarness = await connectStdioServer({
      serverPath: DIST_ENTRY,
      cwd: nullRoot,
      env: nullRootEnvironment,
      clientName: 's90-m04-null-root-wire',
    });
    harnesses.push(nullRootHarness);
    await nullRootHarness.callOk('cmos_project', {
      action: 'init',
      projectRoot: nullRoot,
      projectName: 's90-m04-null-semantics',
    });
  }, 120_000);

  afterAll(async () => {
    for (const harness of harnesses) await harness.close();
    if (dashboardDouble) await dashboardDouble.close();
    for (const directory of tmpDirs) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('derives one complete, unique pair universe from tools/list and uses only isolated env keys', () => {
    expect(actionEnum({ name: 'actionless-probe', inputSchema: { properties: {} } })).toBeNull();
    expect(() =>
      actionEnum({
        name: 'malformed-action-probe',
        inputSchema: { properties: { action: {} } },
      })
    ).toThrow('tools/list published a malformed action schema for malformed-action-probe');

    const toolNames = tools.map((tool) => tool.name);
    const actionlessTools = tools.filter((tool) => actionEnum(tool) === null);
    const enumActionCount = tools.reduce(
      (total, tool) => total + (actionEnum(tool)?.length ?? 0),
      0
    );
    const independentlyExpectedPairs = enumActionCount + actionlessTools.length;
    const keys = pairs.map(pairKey);

    expect(new Set(toolNames).size).toBe(toolNames.length);
    expect(new Set(keys).size).toBe(keys.length);
    expect(pairs).toHaveLength(independentlyExpectedPairs);
    expect([...new Set(pairs.map((pair) => pair.tool))].sort()).toEqual([...toolNames].sort());
    for (const tool of tools) {
      const actions = actionEnum(tool);
      if (actions !== null) expect(new Set(actions).size).toBe(actions.length);
    }

    const loopbackAuthPairs = pairs.filter((pair) => AUTH_LOOPBACK_PAIR_KEYS.has(pairKey(pair)));
    expect(loopbackAuthPairs).toHaveLength(AUTH_LOOPBACK_PAIR_KEYS.size);
    expect(pairs.map(pairKey)).toContain(LOGIN_COMPLETE_PAIR_KEY);
    expect(pairs.length).toBeGreaterThan(tools.length);

    for (const { cwd, environment, dashboardUrl } of environments) {
      const expectedKeys = ['CMOS_CONFIG_DIR', 'CMOS_PROJECT_ROOT', 'HOME', 'NODE_ENV', 'PATH'];
      if (dashboardUrl !== undefined) expectedKeys.push('CMOS_DASHBOARD_URL');
      if (environment.NODE_OPTIONS !== undefined) {
        expectedKeys.push('NODE_OPTIONS', 'CMOS_TEST_DASHBOARD_REDIRECT_ORIGIN');
      }
      expect(Object.keys(environment).sort()).toEqual(expectedKeys.sort());
      expect(environment.CMOS_PROJECT_ROOT).toBe(cwd);
      if (dashboardUrl === undefined) expect(environment).not.toHaveProperty('CMOS_DASHBOARD_URL');
      else expect(environment.CMOS_DASHBOARD_URL).toBe(dashboardUrl);
      if (environment.NODE_OPTIONS !== undefined) {
        expect(environment.NODE_OPTIONS).toBe(`--require=${DASHBOARD_DEFAULT_REDIRECT_PRELOAD}`);
        expect(environment.CMOS_TEST_DASHBOARD_REDIRECT_ORIGIN).toBe(dashboardDouble.origin);
      }
      expect(environment).not.toHaveProperty('CMOS_DASHBOARD_API_KEY');
    }

    console.log(
      `[s90-m04 wire universe] tools=${tools.length} enum-actions=${enumActionCount} ` +
        `actionless=${actionlessTools.length} pairs=${pairs.length}; ` +
        `auth loopback rule=${loopbackAuthPairs.map(displayPair).join(',')}; ` +
        `${displayPair({ tool: 'cmos_auth', action: 'login_complete' })}=local validation + loopback poll`
    );
  });

  it('normalizes uptime text and structured fields before omitted/null comparison', () => {
    expect(normalizeWireString('uptime=0s uptime=1.25s', omittedRootEnvironment)).toBe(
      'uptime=<UPTIME> uptime=<UPTIME>'
    );
    expect(
      normalizeWireValue({ uptimeSeconds: 1.25, nested: 'uptime=9s' }, omittedRootEnvironment)
    ).toEqual({ uptimeSeconds: '<UPTIME_SECONDS>', nested: 'uptime=<UPTIME>' });
  });

  it('classifies every literal first-run pair and separately drives network-bearing auth on loopback', async () => {
    const failures: ObservedFailure[] = [];
    const codes = new Map<string, number>();
    const codeByPair = new Map<string, string>();
    const driven = new Set<string>();
    const excluded: string[] = [];
    const loopbackDriven = new Set<string>();

    dashboardDouble.clearRequests();

    for (const pair of pairs) {
      const key = pairKey(pair);
      const result = await callBounded(firstRunHarness, pair, argsFor(pair));
      const observed = observedFailure(pair, result);
      const code = observed.code;
      driven.add(key);
      if (code !== null) {
        codes.set(code, (codes.get(code) ?? 0) + 1);
        codeByPair.set(key, code);
      }
      if (hasCatchAllDisclosure(result) || (result.isError === true && code === null)) {
        failures.push(observed);
      }
    }

    // The literal first-run calls above fail at project resolution and therefore cannot prove
    // the auth handler itself is hermetic. Re-drive exactly the two network-bearing no-argument
    // actions on an initialized scratch root whose only dashboard URL is the loopback double.
    for (const pair of pairs.filter((candidate) =>
      AUTH_LOOPBACK_PAIR_KEYS.has(pairKey(candidate))
    )) {
      loopbackDriven.add(pairKey(pair));
      await callBounded(authBoundaryHarness, pair, argsFor(pair));
    }
    const loginComplete = pairs.find((pair) => pairKey(pair) === LOGIN_COMPLETE_PAIR_KEY);
    expect(loginComplete).toBeDefined();
    const loginCompleteResult = await callBounded(
      authBoundaryHarness,
      loginComplete!,
      argsFor(loginComplete!)
    );
    const loginCompleteWithCode = await callBounded(
      authBoundaryHarness,
      loginComplete!,
      argsFor(loginComplete!, {
        deviceCode: 'wire-preflight-device-code',
        maxWaitSeconds: 2,
        pollIntervalSeconds: 1,
      })
    );

    expect(excluded).toEqual([]);
    expect(driven.size).toBe(pairs.length - excluded.length);
    expect([...loopbackDriven].sort()).toEqual([...AUTH_LOOPBACK_PAIR_KEYS].sort());
    expectHermeticDeviceFlowRequests(dashboardDouble, 2);
    expect(failures).toEqual([]);
    expect(codeByPair.get('cmos_review\0<actionless>')).toBe('CMOS_NOT_DETECTED');
    expect(loginCompleteResult.structuredContent?.error?.code).toBe('MISSING_PARAMETER');
    expect(loginCompleteWithCode.structuredContent?.success).toBe(true);
    expect(loginCompleteWithCode.structuredContent?.data).toMatchObject({ status: 'expired' });
    expect(codes.get('CMOS_NOT_DETECTED') ?? 0).toBeGreaterThan(0);
    expect(codes.get('TOOL_EXECUTION_ERROR') ?? 0).toBe(0);

    console.log(
      `[s90-m04 first-run wire] published=${pairs.length} driven=${driven.size} ` +
        `excluded=${excluded.length} auth-loopback=${loopbackDriven.size} ` +
        `codes=${JSON.stringify(sortedCounts(codes))}`
    );
  }, 180_000);

  it('refuses all six wrong projectRoot specimens on every published pair before dispatch', async () => {
    const failures: ObservedFailure[] = [];
    const driven = new Set<string>();

    for (const specimen of WRONG_PROJECT_ROOTS) {
      for (const pair of pairs) {
        const result = await callBounded(
          initializedHarness,
          pair,
          argsFor(pair, { projectRoot: specimen.value })
        );
        driven.add(`${specimen.label}\0${pairKey(pair)}`);
        const error = result.structuredContent?.error;
        if (
          result.isError !== true ||
          error?.code !== 'INVALID_PARAMETER' ||
          error.field !== 'projectRoot' ||
          hasCatchAllDisclosure(result)
        ) {
          failures.push(observedFailure(pair, result, specimen.label));
        }
      }
    }

    expect(driven.size).toBe(pairs.length * WRONG_PROJECT_ROOTS.length);
    for (const specimen of WRONG_PROJECT_ROOTS) {
      expect(driven).toContain(`${specimen.label}\0cmos_auth\0login`);
    }
    expect(failures).toEqual([]);
    expect(fs.existsSync(path.join(initializedRoot, 'cmos', 'db', 'cmos.sqlite'))).toBe(true);

    console.log(
      `[s90-m04 wrong-root wire] specimens=${WRONG_PROJECT_ROOTS.length} ` +
        `pairs=${pairs.length} calls=${driven.size} INVALID_PARAMETER=${driven.size}`
    );
  }, 180_000);

  it('preserves omitted/null projectRoot semantics across two isolated all-pair sweeps', async () => {
    dashboardDouble.clearRequests();
    const omitted = await sweepProjectRootSemantics(
      omittedRootHarness,
      omittedRootEnvironment,
      pairs,
      'omitted'
    );
    expectHermeticDeviceFlowRequests(dashboardDouble);

    dashboardDouble.clearRequests();
    const nullRoot = await sweepProjectRootSemantics(
      nullRootHarness,
      nullRootEnvironment,
      pairs,
      'null'
    );
    expectHermeticDeviceFlowRequests(dashboardDouble);

    expect([...nullRoot.entries()]).toEqual([...omitted.entries()]);
    console.log(`[s90-m04 null semantics] omitted=${omitted.size} null=${nullRoot.size}`);
  }, 180_000);

  it('preserves INVALID_ACTION precedence for every action-bearing published tool', async () => {
    const actionBearing = tools.filter((tool) => actionEnum(tool) !== null);
    const failures: ObservedFailure[] = [];

    for (const tool of actionBearing) {
      const actions = actionEnum(tool) ?? [];
      expect(actions).not.toContain(INVALID_ACTION);
      const pair = { tool: tool.name, action: INVALID_ACTION } satisfies PublishedPair;
      const result = await callBounded(initializedHarness, pair, {
        action: INVALID_ACTION,
        projectRoot: 12_345,
      });
      if (
        result.isError !== true ||
        result.structuredContent?.error?.code !== 'INVALID_ACTION' ||
        hasCatchAllDisclosure(result)
      ) {
        failures.push(observedFailure(pair, result));
      }
    }

    expect(failures).toEqual([]);
    console.log(`[s90-m04 invalid-action precedence] tools=${actionBearing.length}`);
  });

  it('leaves an unknown tool to the MCP MethodNotFound protocol error', async () => {
    let rejection: unknown;
    try {
      await initializedHarness.client.callTool(
        { name: UNKNOWN_TOOL, arguments: { projectRoot: 12_345 } },
        undefined,
        { timeout: REQUEST_TIMEOUT_MS }
      );
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toMatchObject({ code: ErrorCode.MethodNotFound });
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain(`Unknown tool: ${UNKNOWN_TOOL}`);
  });

  it('extracts and executes the DB_NOT_FOUND init prescription on the same root', async () => {
    const pair = { tool: 'cmos_review', action: null } satisfies PublishedPair;
    const triggers = [
      await callBounded(missingDbHarness, pair, {}),
      await callBounded(missingDbHarness, pair, { projectRoot: missingDbRoot }),
    ];

    for (const trigger of triggers) {
      expect(trigger.isError).toBe(true);
      expect(trigger.structuredContent?.error?.code).toBe('DB_NOT_FOUND');
      expect(hasCatchAllDisclosure(trigger)).toBe(false);
    }
    const prescribedRoots = triggers.map(prescribedInitRoot);
    expect([...new Set(prescribedRoots.map((root) => fs.realpathSync(root)))]).toEqual([
      fs.realpathSync(missingDbRoot),
    ]);

    await missingDbHarness.callOk('cmos_project', {
      action: 'init',
      projectRoot: prescribedRoots[0],
    });
    const remedies = [
      await callBounded(missingDbHarness, pair, {}),
      await callBounded(missingDbHarness, pair, { projectRoot: missingDbRoot }),
    ];

    for (const remedy of remedies) {
      expect(remedy.isError).not.toBe(true);
      expect(remedy.structuredContent?.success).toBe(true);
      expect(remedy.structuredContent?.error?.code).not.toBe('DB_NOT_FOUND');
    }
  });

  it('proves the SENDER_UNRESOLVABLE projectRoot prescription succeeds on a valid root', async () => {
    const pair = { tool: 'cmos_message', action: 'whoami' } satisfies PublishedPair;
    const trigger = await callBounded(firstRunHarness, pair, argsFor(pair));
    const triggerError = trigger.structuredContent?.error;

    expect(trigger.isError).toBe(true);
    expect(triggerError?.code).toBe('SENDER_UNRESOLVABLE');
    expect(triggerError?.suggestion).toContain('Pass projectRoot explicitly');

    const remedy = await callBounded(
      initializedHarness,
      pair,
      argsFor(pair, { projectRoot: initializedRoot })
    );
    const remedyData = remedy.structuredContent?.data as
      | { resolved?: { projectRoot?: string; source?: string } }
      | undefined;

    expect(remedy.isError).not.toBe(true);
    expect(remedy.structuredContent?.success).toBe(true);
    expect(remedy.structuredContent?.error?.code).not.toBe(triggerError?.code);
    expect(remedyData?.resolved).toMatchObject({
      projectRoot: initializedRoot,
      source: 'explicit',
    });
  });

  it('extracts every CMOS_NOT_DETECTED init prescription and executes its same root', async () => {
    const reviewPair = { tool: 'cmos_review', action: null } satisfies PublishedPair;
    const healthPair = { tool: 'cmos_db', action: 'health' } satisfies PublishedPair;
    const registerPair = { tool: 'cmos_project', action: 'register' } satisfies PublishedPair;
    const triggers = [
      await callBounded(firstRunHarness, reviewPair, {}),
      await callBounded(firstRunHarness, reviewPair, { projectRoot: firstRunRoot }),
      await callBounded(firstRunHarness, healthPair, {
        action: 'health',
        projectRoot: firstRunRoot,
      }),
      await callBounded(firstRunHarness, registerPair, {
        action: 'register',
        projectRoot: firstRunRoot,
      }),
    ];

    for (const trigger of triggers) {
      expect(trigger.isError).toBe(true);
      expect(trigger.structuredContent?.error?.code).toBe('CMOS_NOT_DETECTED');
      expect(hasCatchAllDisclosure(trigger)).toBe(false);
    }
    const prescribedRoots = triggers.map(prescribedInitRoot);
    expect([...new Set(prescribedRoots.map((root) => fs.realpathSync(root)))]).toEqual([
      fs.realpathSync(firstRunRoot),
    ]);

    await firstRunHarness.callOk('cmos_project', {
      action: 'init',
      projectRoot: prescribedRoots[0],
    });
    const remedies = [
      await callBounded(firstRunHarness, reviewPair, {}),
      await callBounded(firstRunHarness, reviewPair, { projectRoot: firstRunRoot }),
      await callBounded(firstRunHarness, healthPair, {
        action: 'health',
        projectRoot: firstRunRoot,
      }),
      await callBounded(firstRunHarness, registerPair, {
        action: 'register',
        projectRoot: firstRunRoot,
      }),
    ];

    for (const remedy of remedies) {
      expect(remedy.isError).not.toBe(true);
      expect(remedy.structuredContent?.success).toBe(true);
      expect(remedy.structuredContent?.error?.code).not.toBe('CMOS_NOT_DETECTED');
    }
  });
});
