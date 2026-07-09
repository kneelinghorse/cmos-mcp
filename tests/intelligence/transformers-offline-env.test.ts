import { describe, expect, test } from '@jest/globals';
import {
  applyOfflineTransformersEnv,
  isOfflineEmbeddingsEnabled,
  type TransformersEnv,
} from '../../src/intelligence/transformers-offline-env';

// s78-m03: the offline env hook is applied inside loadXenovaEmbedder / loadClaudeTokenizer
// AFTER the (production-only) ESM import of @xenova — which cannot run under jest's CJS. So the
// hook logic is unit-tested here in isolation against a fake env; the wiring + real fast-fail are
// exercised by the ts-node runtime verify (see the mission verify).

function freshEnv(): TransformersEnv {
  return { allowRemoteModels: true };
}

describe('applyOfflineTransformersEnv (s78-m03)', () => {
  test('isOfflineEmbeddingsEnabled recognizes 1 / true only', () => {
    expect(isOfflineEmbeddingsEnabled({ CMOS_OFFLINE_EMBEDDINGS: '1' } as NodeJS.ProcessEnv)).toBe(
      true
    );
    expect(
      isOfflineEmbeddingsEnabled({ CMOS_OFFLINE_EMBEDDINGS: 'true' } as NodeJS.ProcessEnv)
    ).toBe(true);
    expect(isOfflineEmbeddingsEnabled({ CMOS_OFFLINE_EMBEDDINGS: '0' } as NodeJS.ProcessEnv)).toBe(
      false
    );
    expect(isOfflineEmbeddingsEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test('offline flag forces allowRemoteModels=false', () => {
    const env = freshEnv();
    applyOfflineTransformersEnv(env, { CMOS_OFFLINE_EMBEDDINGS: '1' } as NodeJS.ProcessEnv);
    expect(env.allowRemoteModels).toBe(false);
  });

  test('cache dir sets both cacheDir and localModelPath', () => {
    const env = freshEnv();
    applyOfflineTransformersEnv(env, {
      CMOS_MODEL_CACHE_DIR: '/models/cache',
    } as NodeJS.ProcessEnv);
    expect(env.cacheDir).toBe('/models/cache');
    expect(env.localModelPath).toBe('/models/cache');
  });

  test('no env → no mutation (remote allowed, dirs untouched)', () => {
    const env = freshEnv();
    applyOfflineTransformersEnv(env, {} as NodeJS.ProcessEnv);
    expect(env.allowRemoteModels).toBe(true);
    expect(env.cacheDir).toBeUndefined();
    expect(env.localModelPath).toBeUndefined();
  });

  test('blank cache dir is ignored', () => {
    const env = freshEnv();
    applyOfflineTransformersEnv(env, { CMOS_MODEL_CACHE_DIR: '   ' } as NodeJS.ProcessEnv);
    expect(env.cacheDir).toBeUndefined();
  });

  test('both flags together', () => {
    const env = freshEnv();
    applyOfflineTransformersEnv(env, {
      CMOS_OFFLINE_EMBEDDINGS: 'true',
      CMOS_MODEL_CACHE_DIR: '/pre/seeded/models',
    } as NodeJS.ProcessEnv);
    expect(env.allowRemoteModels).toBe(false);
    expect(env.cacheDir).toBe('/pre/seeded/models');
    expect(env.localModelPath).toBe('/pre/seeded/models');
  });
});
