/**
 * Caller-side sprint-close protocol contract.
 *
 * The assertion deliberately lives in this test: s88-m04 requires callers to reject
 * receipts from an already-running pre-m02 process without adding another production
 * export to cmos-sprint-complete.ts.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { requiresPrivateEvidence } from '../helpers/public-mirror';

const ROOT = path.resolve(__dirname, '../..');
const CLOSE_SOURCE = 'src/tools/cmos/cmos-sprint-complete.ts';
const PRE_M02_PARENT = '7843dfcc9aaebe7eeb482b5dbf9566eab425e4e8';
const PRIVATE = requiresPrivateEvidence({
  reason: 'private closeout instructions and private source-history boundary',
  paths: {
    agents: 'agents.md',
    buildSessionPrompt: 'cmos/docs/build-session-prompt.md',
  },
  revisions: {
    preM02Parent: '188d9e3^',
  },
});

type FrozenReceipt = Readonly<{
  success: true;
  data: Readonly<{
    lifecycle: Readonly<Record<string, unknown>>;
  }>;
}>;

function frozenReceipt(lifecycle: Record<string, unknown>): FrozenReceipt {
  return Object.freeze({
    success: true as const,
    data: Object.freeze({ lifecycle: Object.freeze({ ...lifecycle }) }),
  });
}

/** The protocol a close caller applies before claiming the receipt is auditable. */
function assertAuditableSprintCloseReceipt(receipt: unknown): asserts receipt is FrozenReceipt {
  const lifecycle =
    typeof receipt === 'object' &&
    receipt !== null &&
    'data' in receipt &&
    typeof receipt.data === 'object' &&
    receipt.data !== null &&
    'lifecycle' in receipt.data &&
    typeof receipt.data.lifecycle === 'object' &&
    receipt.data.lifecycle !== null
      ? (receipt.data.lifecycle as Record<string, unknown>)
      : undefined;

  for (const field of ['archivedDecisionIds', 'learningIds'] as const) {
    if (!Array.isArray(lifecycle?.[field])) {
      throw new Error(
        `Unauditable sprint close: lifecycle.${field} must be an array. ` +
          'This receipt may come from a pre-m02 running process; start a new host session ' +
          'or reconnect before claiming the sprint close is audited.'
      );
    }
  }
}

function extractSection(document: string, heading: string): string {
  const start = document.indexOf(heading);
  if (start < 0) return '';
  const remainder = document.slice(start + heading.length);
  const nextHeading = remainder.search(/^###\s+/m);
  return nextHeading < 0 ? remainder : remainder.slice(0, nextHeading);
}

function closeoutProtocolIssues(section: string): string[] {
  const issues: string[] = [];
  if (!/archivedDecisionIds/.test(section)) issues.push('missing archivedDecisionIds check');
  if (!/learningIds/.test(section)) issues.push('missing learningIds check');
  if (!/Array\.isArray|must (?:both )?be arrays?/i.test(section)) {
    issues.push('missing non-array rejection rule');
  }
  if (!/pre-m02/i.test(section)) issues.push('missing pre-m02 process diagnosis');
  if (!/fail loudly|stop|unauditable/i.test(section)) issues.push('missing fail-loud instruction');
  if (!/new host session|reconnect/i.test(section)) {
    issues.push('missing available new-host-session/reconnect lever');
  }
  if (
    /\bmay restart\b|\brestarting\b[^.\n]*\boptimization\b|\brestart (?:the )?MCP\b[^.\n]*(?:pick up|load fresh|recommended)/i.test(
      section
    )
  ) {
    issues.push('contains a stale-process restart prescription');
  }
  return issues;
}

describe('sprint-close caller protocol', () => {
  it.each([
    ['missing', 'archivedDecisionIds', { learningIds: [] }],
    ['null', 'archivedDecisionIds', { archivedDecisionIds: null, learningIds: [] }],
    ['non-array', 'archivedDecisionIds', { archivedDecisionIds: '#41', learningIds: [] }],
    ['missing', 'learningIds', { archivedDecisionIds: [] }],
    ['null', 'learningIds', { archivedDecisionIds: [], learningIds: null }],
    ['non-array', 'learningIds', { archivedDecisionIds: [], learningIds: { 0: 41 } }],
  ])('rejects a %s lifecycle.%s receipt', (_shape, field, lifecycle) => {
    const receipt = frozenReceipt(lifecycle);

    expect(() => assertAuditableSprintCloseReceipt(receipt)).toThrow(
      new RegExp(`Unauditable sprint close: lifecycle\\.${field} must be an array`, 'i')
    );
    try {
      assertAuditableSprintCloseReceipt(receipt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/pre-m02/i);
      expect(message).toMatch(/new host session|reconnect/i);
      expect(message).not.toMatch(/restart/i);
    }
  });

  it('accepts a current receipt only when both lifecycle id arrays are present', () => {
    const receipt = frozenReceipt({ archivedDecisionIds: [41, 42], learningIds: [] });
    expect(() => assertAuditableSprintCloseReceipt(receipt)).not.toThrow();
  });
});

PRIVATE.describe('private sprint-close caller protocol evidence', () => {
  it('pins 7843dfc as the pre-m02 parent and proves the old/current source boundary', () => {
    expect(PRIVATE.revisions.preM02Parent).toBe(PRE_M02_PARENT);

    const oldSource = execFileSync(
      'git',
      ['show', `${PRIVATE.revisions.preM02Parent}:${CLOSE_SOURCE}`],
      {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      }
    );
    expect(oldSource).not.toMatch(/\barchivedDecisionIds\b/);
    expect(oldSource).not.toMatch(/\blearningIds\b/);

    const currentSource = fs.readFileSync(path.join(ROOT, CLOSE_SOURCE), 'utf8');
    expect(currentSource).toMatch(/\barchivedDecisionIds\b/);
    expect(currentSource).toMatch(/\blearningIds\b/);
  });

  it.each([
    [PRIVATE.paths.agents, '### Sprint Closeout Discipline (advisory build-freshness)'],
    [PRIVATE.paths.buildSessionPrompt, '### Sprint Closeout (advisory build-freshness)'],
  ])('documents fail-loud pre-m02 receipt handling in %s', (documentPath, heading) => {
    const document = fs.readFileSync(documentPath, 'utf8');
    const section = extractSection(document, heading);

    expect(section).not.toBe('');
    expect(closeoutProtocolIssues(section)).toStrictEqual([]);
  });
});
