// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The CLI and session-start hook read the same bounded local digest as MCP review.
// ABOUTME: Fleet feedback counts are bounded; no migrations or dashboard work runs and typed spans measure delivery.

import { readDigestV2 } from '../tools/cmos/digest-v2-store';
import { renderDigestV2 } from '../tools/cmos/digest-v2';
import { CliStoreError, type CliIo } from './core';
import { observeRenderedContext } from './telemetry';

export async function buildDigest(
  projectRoot: string,
  io?: CliIo,
  deadlineAtMs = Infinity
): Promise<string> {
  try {
    const context = renderDigestV2(await readDigestV2(projectRoot, io?.env, deadlineAtMs - 20));
    observeRenderedContext(io, context);
    return context.text;
  } catch (error) {
    throw new CliStoreError(
      error instanceof Error ? error.message : 'The digest could not be read.'
    );
  }
}
