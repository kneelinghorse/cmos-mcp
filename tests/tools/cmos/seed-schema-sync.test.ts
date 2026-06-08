// ABOUTME: Drift guard — fails when cmos-seed/db/schema.sql diverges from CMOS_SCHEMA.
// ABOUTME: Run scripts/regenerate-seed-schema.ts to fix.

import * as fs from 'fs';
import * as path from 'path';
import { CMOS_SCHEMA } from '../../../src/tools/cmos/schema';

describe('cmos-seed/db/schema.sql', () => {
  test('matches CMOS_SCHEMA byte-for-byte', () => {
    const seedPath = path.resolve(__dirname, '../../../cmos-seed/db/schema.sql');
    const onDisk = fs.readFileSync(seedPath, 'utf-8');
    if (onDisk !== CMOS_SCHEMA) {
      throw new Error(
        'cmos-seed/db/schema.sql is out of sync with CMOS_SCHEMA. ' +
          'Run: npx ts-node scripts/regenerate-seed-schema.ts'
      );
    }
  });
});
