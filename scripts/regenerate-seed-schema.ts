// ABOUTME: Regenerates cmos-seed/db/schema.sql from the live CMOS_SCHEMA constant.
// ABOUTME: Run after editing src/tools/cmos/schema.ts to keep the seed in lockstep.

import * as fs from 'fs';
import * as path from 'path';
import { CMOS_SCHEMA } from '../src/tools/cmos/schema';

const seedSchemaPath = path.resolve(__dirname, '..', 'cmos-seed', 'db', 'schema.sql');
fs.writeFileSync(seedSchemaPath, CMOS_SCHEMA, 'utf-8');
console.log(`[regenerate-seed-schema] wrote ${CMOS_SCHEMA.length} bytes to ${seedSchemaPath}`);
