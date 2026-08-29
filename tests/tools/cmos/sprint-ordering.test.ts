// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Locks the shared sprint-ID SQL order across numeric, legacy, and NULL values.
// ABOUTME: Proves the fragment rejects untrusted SQL expressions and directions.

import Database from 'better-sqlite3';

import { sprintIdOrderSql } from '../../../src/tools/cmos/sprint-ordering';

describe('sprintIdOrderSql', () => {
  it('orders canonical IDs numerically before deterministic legacy and NULL buckets', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE values_to_order (sprint_id TEXT)');
    const insert = db.prepare('INSERT INTO values_to_order (sprint_id) VALUES (?)');
    [null, 'iso-final', 'PT-SP1', 'sprint-100', 'sprint-99', 'sprint-1', 'sprint-01'].forEach(
      (id) => insert.run(id)
    );

    const ordered = (direction: 'ASC' | 'DESC'): Array<string | null> =>
      db
        .prepare(
          `SELECT sprint_id FROM values_to_order ORDER BY ${sprintIdOrderSql('sprint_id', direction)}`
        )
        .all()
        .map((row) => (row as { sprint_id: string | null }).sprint_id);

    expect(ordered('ASC')).toEqual([
      'sprint-01',
      'sprint-1',
      'sprint-99',
      'sprint-100',
      'PT-SP1',
      'iso-final',
      null,
    ]);
    expect(ordered('DESC')).toEqual([
      'sprint-100',
      'sprint-99',
      'sprint-1',
      'sprint-01',
      'iso-final',
      'PT-SP1',
      null,
    ]);
    db.close();
  });

  it('rejects SQL text outside the trusted identifier and direction grammar', () => {
    expect(() => sprintIdOrderSql('sprint_id; DROP TABLE sprints', 'ASC')).toThrow(
      'Invalid sprint-ID SQL expression'
    );
    expect(() => sprintIdOrderSql('activity.sprint_id', 'SIDEWAYS' as 'ASC')).toThrow(
      'Invalid sprint-ID sort direction'
    );
  });
});
