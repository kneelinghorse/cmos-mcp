// ABOUTME: Regenerates rbook-seed/db/schema.sql from the live RBOOK_SCHEMA constant.
// ABOUTME: Run after editing src/tools/rbook/schema.ts to keep the seed in lockstep.

import * as fs from 'fs';
import * as path from 'path';
import { RBOOK_SCHEMA } from '../src/tools/rbook/schema';

const seedSchemaPath = path.resolve(__dirname, '..', 'rbook-seed', 'db', 'schema.sql');
fs.writeFileSync(seedSchemaPath, RBOOK_SCHEMA, 'utf-8');
console.log(`[regenerate-seed-schema] wrote ${RBOOK_SCHEMA.length} bytes to ${seedSchemaPath}`);
