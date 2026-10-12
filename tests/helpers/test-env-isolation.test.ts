// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Jest isolation must keep explicit run controls without retaining real settings as fallbacks.
// ABOUTME: Synthetic environments prove both name families without touching the operator's environment.
import {
  captureRunControls,
  cleanBeforeTest,
  clearProductSettings,
  CURRENT_SETTING_PREFIX,
  restoreRunControls,
} from './test-env-isolation';
import { getSetting, LEGACY, settingNames } from '../../src/intelligence/legacy-compat';

const current = (suffix: string): string => `${CURRENT_SETTING_PREFIX}${suffix}`;
const old = (suffix: string): string => `${LEGACY.envPrefix}${suffix}`;

test('file boundaries retain neutral keys and explicit controls, but discard both inherited setting families', () => {
  const env = {
    RBOOK_CHECKPOINT_SYNC: 'on',
    [old('CHECKPOINT_SYNC')]: 'off',
    RBOOK_PROJECT_ROOT: '/real/new',
    [old('PROJECT_ROOT')]: '/real/old',
    RBOOK_DASHBOARD_API_KEY: 'secret-new',
    [old('DASHBOARD_API_KEY')]: 'secret-old',
    JEST_RECORD_CONFIG_DIR_CANONICAL: '/isolated',
    JEST_RECORD_DIST_MANIFEST_SHA256: 'fingerprint',
  };
  const controls = captureRunControls(env);
  clearProductSettings(env);
  restoreRunControls(env, controls, '/isolated/worker');
  expect(getSetting('CHECKPOINT_SYNC', env)).toBe('on');
  expect(getSetting('PROJECT_ROOT', env)).toBeUndefined();
  expect(getSetting('DASHBOARD_API_KEY', env)).toBeUndefined();
  expect(getSetting('CONFIG_DIR', env)).toBe('/isolated/worker');
  expect(env.JEST_RECORD_DIST_MANIFEST_SHA256).toBe('fingerprint');
  expect(env.JEST_RECORD_CONFIG_DIR_CANONICAL).toBe('/isolated');
  delete (env as NodeJS.ProcessEnv)[current('CHECKPOINT_SYNC')];
  expect(getSetting('CHECKPOINT_SYNC', env)).toBeUndefined();
});

test('beforeEach keeps current beforeAll fixtures while stripping imported fallback and credentials', () => {
  const other = settingNames('').find((prefix) => prefix !== CURRENT_SETTING_PREFIX)!;
  const env: NodeJS.ProcessEnv = {
    [current('DASHBOARD_URL')]: 'http://127.0.0.1:3123',
    [current('AGENT_ROLE')]: 'review',
    [current('LIVE_DASHBOARD')]: '1',
    [current('DASHBOARD_API_KEY')]: 'imported-secret',
    [`${other}PROJECT_ROOT`]: '/real/old',
    [`${other}DASHBOARD_API_KEY`]: 'fallback-secret',
  };
  cleanBeforeTest(env, { CHECKPOINT_SYNC: 'off' });
  expect(env[current('DASHBOARD_URL')]).toBe('http://127.0.0.1:3123');
  expect(env[current('AGENT_ROLE')]).toBe('review');
  expect(getSetting('PROJECT_ROOT', env)).toBeUndefined();
  expect(getSetting('DASHBOARD_API_KEY', env)).toBeUndefined();
  expect(getSetting('LIVE_DASHBOARD', env)).toBeUndefined();
});

test('explicit live runs and other test controls survive cleanup and afterEach restoration', () => {
  const controls = captureRunControls({
    [old('LIVE_DASHBOARD')]: '1',
    [old('DASHBOARD_URL')]: 'https://live.example.test',
    [old('LIVE_PROJECT_ID')]: 'chosen-project',
    [old('ANSWER_SHAPE_SOURCE_ROOT')]: '/candidate/src',
    [old('UPLOAD_FIXTURE')]: '/copied/store.sqlite',
  });
  const env: NodeJS.ProcessEnv = {};
  restoreRunControls(env, controls, '/isolated');
  cleanBeforeTest(env, controls);
  expect(getSetting('LIVE_DASHBOARD', env)).toBe('1');
  expect(getSetting('DASHBOARD_URL', env)).toBe('https://live.example.test');
  expect(getSetting('LIVE_PROJECT_ID', env)).toBe('chosen-project');
  expect(getSetting('ANSWER_SHAPE_SOURCE_ROOT', env)).toBe('/candidate/src');
  expect(getSetting('UPLOAD_FIXTURE', env)).toBe('/copied/store.sqlite');
  env[current('CHECKPOINT_SYNC')] = 'on';
  restoreRunControls(env, controls, '/isolated');
  expect(getSetting('CHECKPOINT_SYNC', env)).toBe('off');
});

test('an explicitly empty new run control does not revive its legacy value', () => {
  expect(
    captureRunControls({ RBOOK_CHECKPOINT_SYNC: '', [old('CHECKPOINT_SYNC')]: 'on' })
      .CHECKPOINT_SYNC
  ).toBe('');
});
