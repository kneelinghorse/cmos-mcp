// ABOUTME: Sprint 70 m03 — ADR pre-acceptance live-schema verification gate (#751). Asserts every
// ABOUTME: Accepted ADR carries a non-empty "Live-schema verification" section with a concrete check.

import * as fs from 'fs';
import * as path from 'path';
import { requiresPrivateEvidence } from '../helpers/public-mirror';

/**
 * The canonical section heading — defined ONCE here and referenced verbatim by the
 * ADRs (cmos/planning/adr/*.md) and by the "Process Hardening" convention in
 * cmos/docs/build-session-prompt.md. The drift guard below asserts the convention
 * names this exact string, so the three places cannot silently diverge.
 */
const LIVE_SCHEMA_VERIFICATION_HEADING = 'Live-schema verification';

const PRIVATE = requiresPrivateEvidence({
  reason: 'private ADR corpus and build-session process convention',
  paths: {
    adrDir: 'cmos/planning/adr',
    buildSessionPrompt: 'cmos/docs/build-session-prompt.md',
  },
});

/**
 * A NON-EMPTY section must carry at least one concrete live check — a PRAGMA, a
 * sqlite_master query, or a pragma_table_info() probe — not merely the heading.
 */
const CONCRETE_CHECK_RE = /PRAGMA\b|sqlite_master|pragma_table_info/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse the `**Status:** X` front-matter marker. */
function statusOf(content: string): string | null {
  const m = content.match(/^\*\*Status:\*\*\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

/**
 * Return the body text under a `##`/`###` heading, up to the next level-1/2 heading
 * (or EOF). null when the heading is absent.
 */
function extractSection(content: string, heading: string): string | null {
  const lines = content.split('\n');
  const headingRe = new RegExp(`^#{2,3}\\s+${escapeRegExp(heading)}\\s*$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;

  const body: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (/^#{1,2}\s+/.test(lines[i])) break; // next level-1/2 heading ends the section
    body.push(lines[i]);
  }
  return body.join('\n');
}

interface AdrCompliance {
  status: string | null;
  accepted: boolean;
  hasSection: boolean;
  hasConcreteCheck: boolean;
  compliant: boolean;
}

/** Pure predicate exercised by both the live ADRs and the mutation-proof fixture. */
function evaluateAdrCompliance(content: string): AdrCompliance {
  const status = statusOf(content);
  const accepted = (status ?? '').toLowerCase() === 'accepted';
  const section = extractSection(content, LIVE_SCHEMA_VERIFICATION_HEADING);
  const hasSection = section != null && section.trim().length > 0;
  const hasConcreteCheck = section != null && CONCRETE_CHECK_RE.test(section);
  // Non-Accepted ADRs are exempt (the gate is pre-ACCEPTANCE); Accepted ADRs must comply.
  const compliant = !accepted || (hasSection && hasConcreteCheck);
  return { status, accepted, hasSection, hasConcreteCheck, compliant };
}

function readAdrs(adrDir: string): Array<{ rel: string; content: string }> {
  return fs
    .readdirSync(adrDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({
      rel: name,
      content: fs.readFileSync(path.join(adrDir, name), 'utf8'),
    }));
}

PRIVATE.describe('ADR verification gate private corpus (Sprint 70 m03)', () => {
  const adrs = readAdrs(PRIVATE.paths.adrDir);

  it('finds the known ADR set (sanity floor — the test is not vacuous)', () => {
    expect(adrs.length).toBeGreaterThanOrEqual(2);
    const accepted = adrs.filter((a) => evaluateAdrCompliance(a.content).accepted);
    expect(accepted.length).toBeGreaterThanOrEqual(1);
  });

  it('every Accepted ADR carries a non-empty Live-schema verification section with a concrete check', () => {
    const violations: string[] = [];
    for (const adr of adrs) {
      const c = evaluateAdrCompliance(adr.content);
      if (!c.accepted) continue;
      if (!c.hasSection) {
        violations.push(
          `${adr.rel}: Accepted ADR is missing a "## ${LIVE_SCHEMA_VERIFICATION_HEADING}" section`
        );
      } else if (!c.hasConcreteCheck) {
        violations.push(
          `${adr.rel}: "${LIVE_SCHEMA_VERIFICATION_HEADING}" section has no concrete check (PRAGMA / sqlite_master / pragma_table_info)`
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps the canonical heading in sync with the build-session-prompt convention (drift guard)', () => {
    const convention = fs.readFileSync(PRIVATE.paths.buildSessionPrompt, 'utf8');
    expect(convention).toContain(LIVE_SCHEMA_VERIFICATION_HEADING);
  });
});

describe('ADR verification gate mutation proofs (Sprint 70 m03)', () => {
  it('FAILS for an Accepted ADR that is missing the section (mutation proof — the gate can fail)', () => {
    const acceptedButBare = [
      '# ADR — Fixture',
      '',
      '**Status:** Accepted',
      '',
      '## Context',
      '',
      'No verification section here.',
      '',
    ].join('\n');

    const c = evaluateAdrCompliance(acceptedButBare);
    expect(c.accepted).toBe(true);
    expect(c.hasSection).toBe(false);
    expect(c.compliant).toBe(false);
  });

  it('FAILS for an Accepted ADR whose section has only the heading (no concrete check)', () => {
    const headingOnly = [
      '# ADR — Fixture',
      '',
      '**Status:** Accepted',
      '',
      `## ${LIVE_SCHEMA_VERIFICATION_HEADING}`,
      '',
      'We verified everything, trust us.',
      '',
      '## Context',
      '',
    ].join('\n');

    const c = evaluateAdrCompliance(headingOnly);
    expect(c.accepted).toBe(true);
    expect(c.hasSection).toBe(true);
    expect(c.hasConcreteCheck).toBe(false);
    expect(c.compliant).toBe(false);
  });

  it('EXEMPTS a non-Accepted (e.g. Proposed) ADR from the requirement', () => {
    const proposed = ['# ADR — Fixture', '', '**Status:** Proposed', '', '## Context', ''].join(
      '\n'
    );
    const c = evaluateAdrCompliance(proposed);
    expect(c.accepted).toBe(false);
    expect(c.compliant).toBe(true);
  });
});
