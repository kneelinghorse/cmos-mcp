// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Shared @xenova/transformers offline env hooks (Sprint 78 m03). Applied before
// ABOUTME: pipeline()/from_pretrained() so a local-forever install never hard-requires an HF fetch.

/** The subset of the @xenova/transformers `env` object we mutate. */
export interface TransformersEnv {
  allowRemoteModels: boolean;
  localModelPath?: string;
  cacheDir?: string;
}

/** True when the operator has pinned embeddings/tokenizers to local-only. */
export function isOfflineEmbeddingsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CMOS_OFFLINE_EMBEDDINGS;
  return v === '1' || v === 'true';
}

/**
 * Apply CMOS_OFFLINE_EMBEDDINGS / CMOS_MODEL_CACHE_DIR to the transformers `env`
 * singleton BEFORE a model load. Idempotent and safe to call from every loader:
 *
 * - CMOS_OFFLINE_EMBEDDINGS=1|true → `allowRemoteModels=false`, so a missing local
 *   model fails fast (→ the caller's negative-cache + BM25-only degrade) instead of
 *   blocking on a HuggingFace fetch/timeout.
 * - CMOS_MODEL_CACHE_DIR=<dir> → point both the remote-cache dir and the local-model
 *   lookup at an operator-provisioned directory (e.g. a pre-seeded models folder).
 */
export function applyOfflineTransformersEnv(
  transformersEnv: TransformersEnv,
  processEnv: NodeJS.ProcessEnv = process.env
): void {
  if (isOfflineEmbeddingsEnabled(processEnv)) {
    transformersEnv.allowRemoteModels = false;
  }
  const cacheDir = processEnv.CMOS_MODEL_CACHE_DIR;
  if (cacheDir && cacheDir.trim().length > 0) {
    transformersEnv.cacheDir = cacheDir;
    transformersEnv.localModelPath = cacheDir;
  }
}
