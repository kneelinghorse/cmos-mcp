// ABOUTME: Sprint 70 m03 — guard test (#751/#752): the firehose-write discipline's machinery must
// ABOUTME: survive. Keyed on file existence + exported-symbol name (stable), not brittle full-text.

import * as fs from 'fs';
import * as path from 'path';
import { genesisColumns } from '../../src/tools/cmos/genesis-columns';

const COVERAGE_TEST = path.resolve(__dirname, '../tools/cmos/event-type-coverage.test.ts');
const GENESIS_HELPER = path.resolve(__dirname, '../../src/tools/cmos/genesis-columns.ts');

describe('mission discipline guard (Sprint 70 m03)', () => {
  it('keeps the event_type coverage test present and non-trivial', () => {
    expect(fs.existsSync(COVERAGE_TEST)).toBe(true);
    const content = fs.readFileSync(COVERAGE_TEST, 'utf8');
    // Non-trivial: it must still walk the firehose tables and assert the genesis stamp.
    // Keyed on stable structural anchors, not exact wording.
    expect(content).toContain('FIREHOSE_TABLES');
    expect(content).toContain('INSERT'); // the INSERT-INTO sweep
    expect(content).toMatch(/event_type|genesisColumns|g\.columns/);
    expect(content.length).toBeGreaterThan(1000);
  });

  it('keeps genesisColumns as the single exported firehose-write helper', () => {
    // The strongest "exported-symbol name" check: import it and assert the callable
    // exists. A rename/removal breaks compilation (red), not just an assertion.
    expect(typeof genesisColumns).toBe('function');

    expect(fs.existsSync(GENESIS_HELPER)).toBe(true);
    const content = fs.readFileSync(GENESIS_HELPER, 'utf8');
    expect(content).toMatch(/export function genesisColumns\b/);
  });
});
