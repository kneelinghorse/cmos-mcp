// SPDX-License-Identifier: Apache-2.0
// ABOUTME: New settings must affect the same guarded behavior as their legacy spellings.
// ABOUTME: Consumer tests catch an accessor that exists but is bypassed at runtime.
import { spawnSync } from 'child_process';
import { readAmbient } from '../../src/cli/core';
import { applyOfflineTransformersEnv } from '../../src/intelligence/transformers-offline-env';
import { isReadOnlyAgentSession } from '../../src/tools/rbook/read-only-agent-guard';

test('new settings control ambient mode, offline model loading and reviewer write protection', () => {
  expect(readAmbient('/absent/store.sqlite', { RBOOK_AMBIENT: 'off', CMOS_AMBIENT: 'on' })).toBe(
    'off'
  );
  expect(isReadOnlyAgentSession({ RBOOK_AGENT_ROLE: 'review' })).toBe(true);
  expect(isReadOnlyAgentSession({ RBOOK_AGENT_ROLE: '', CMOS_AGENT_ROLE: 'review' })).toBe(false);
  const model = { allowRemoteModels: true, cacheDir: '', localModelPath: '' };
  applyOfflineTransformersEnv(model, {
    RBOOK_OFFLINE_EMBEDDINGS: '1',
    CMOS_OFFLINE_EMBEDDINGS: '0',
    RBOOK_MODEL_CACHE_DIR: '/new/cache',
    CMOS_MODEL_CACHE_DIR: '/old/cache',
  });
  expect(model).toEqual({
    allowRemoteModels: false,
    cacheDir: '/new/cache',
    localModelPath: '/new/cache',
  });
});

// No git command runs: only the hook parses this JSON and accepts/rejects it.
test.each([
  [{ RBOOK_AGENT_ROLE: 'review' }, 2],
  [{ CMOS_AGENT_ROLE: 'review' }, 2],
  [{ RBOOK_AGENT_ROLE: '', CMOS_AGENT_ROLE: 'review' }, 0],
] as const)(
  'shell reviewer guard follows the same override contract for %j',
  (settings, status) => {
    const result = spawnSync('bash', ['scripts/hooks/block-git-mutations.sh'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...settings },
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git reset --hard' } }),
    });
    expect(result.status).toBe(status);
  }
);
