// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Checks that unfinished transcript bytes cannot be reported as fully scanned.
// ABOUTME: The next scan resumes at the last whole line and can still discover outside content.

import { afterEach, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanFile } from '../../src/cli/transcript-scan';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('leaves an incomplete final line unknown, then reads it once the writer finishes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-transcript-partial-'));
  dirs.push(dir);
  const file = path.join(dir, 'transcript.jsonl');
  const first = JSON.stringify({ type: 'assistant', message: { content: 'Local work.' } }) + '\n';
  const outside = JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: 'WebFetch', input: { url: 'https://example.com' } }],
    },
  });
  fs.writeFileSync(file, first + outside);
  const partial = scanFile(file, 0, 4096);
  expect(partial).toMatchObject({
    scanned: Buffer.byteLength(first),
    outside: false,
    complete: false,
  });
  fs.appendFileSync(file, '\n');
  expect(scanFile(file, partial.scanned, 4096)).toMatchObject({
    scanned: fs.statSync(file).size,
    outside: true,
    complete: true,
  });
});
