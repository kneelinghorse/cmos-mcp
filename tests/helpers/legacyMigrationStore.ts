// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Builds a deliberate legacy-name store even after the ordinary seed helper creates rbook.
// ABOUTME: Rename compatibility tests must keep exercising the old filesystem contract after the scrub.
import fs from 'fs';
import path from 'path';
import { LEGACY } from '../../src/intelligence/legacy-compat';
import { seedRbookDb } from './seedRbookDb';

export function seedLegacyMigrationStore(root: string): string {
  const created = seedRbookDb(root);
  const directory = path.dirname(path.dirname(created));
  const legacy = path.join(root, LEGACY.recordDirectory);
  if (directory !== legacy) fs.renameSync(directory, legacy);
  const file = path.join(legacy, 'db', path.basename(created));
  const target = path.join(legacy, 'db', LEGACY.databaseFile);
  if (file !== target) fs.renameSync(file, target);
  return target;
}
