// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Records an owned transient compact marker without producing hook output.
// ABOUTME: A compact SessionStart consumes it only after successful digest delivery.

import type { HookVerbContext } from '../cli';
import { hookRuntimeIdentity } from './hook-runtime';
import { markPreCompact } from './lifecycle-runtime';

export async function run(ctx: HookVerbContext): Promise<null> {
  markPreCompact(hookRuntimeIdentity(ctx.input, ctx.io.env), ctx.io.env);
  return null;
}
