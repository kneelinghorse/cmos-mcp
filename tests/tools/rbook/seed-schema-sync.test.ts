// ABOUTME: Drift guard — fails when rbook-seed/db/schema.sql diverges from RBOOK_SCHEMA.
// ABOUTME: Run scripts/regenerate-seed-schema.ts to fix.

import * as fs from 'fs';
import * as path from 'path';
import { RBOOK_SCHEMA } from '../../../src/tools/rbook/schema';

describe('rbook-seed/db/schema.sql', () => {
  test('matches RBOOK_SCHEMA byte-for-byte', () => {
    const seedPath = path.resolve(__dirname, '../../../rbook-seed/db/schema.sql');
    const onDisk = fs.readFileSync(seedPath, 'utf-8');
    if (onDisk !== RBOOK_SCHEMA) {
      throw new Error(
        'rbook-seed/db/schema.sql is out of sync with RBOOK_SCHEMA. ' +
          'Run: npx ts-node scripts/regenerate-seed-schema.ts'
      );
    }
  });
});
