// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Hook receipts follow synchronous output completion, not an asynchronous stream enqueue.
// ABOUTME: Bounded byte writes handle partial output and interrupts; pipe/backpressure errors abort delivery.

import * as fs from 'fs';

type WriteBytes = (buffer: Buffer, offset: number, length: number) => number;

/** Hooks emit at most 6000 context characters; even escaped JSON stays within this byte bound. */
export function writeHookOutput(
  text: string,
  deadlineAtMs: number,
  write: WriteBytes = (buffer, offset, length) =>
    fs.writeSync(process.stdout.fd, buffer, offset, length)
): void {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length > 64 * 1024) throw new Error('hook output exceeds its byte bound');
  let offset = 0;
  while (offset < buffer.length) {
    if (Date.now() >= deadlineAtMs) throw new Error('hook output deadline exceeded');
    try {
      const count = write(buffer, offset, Math.min(4096, buffer.length - offset));
      if (!Number.isInteger(count) || count <= 0 || count > buffer.length - offset)
        throw new Error('hook output made no valid progress');
      offset += count;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EINTR') continue;
      // EAGAIN is deliberately not retried: waiting on a stalled reader would consume the hook.
      throw error;
    }
  }
}
