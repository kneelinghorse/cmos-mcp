/**
 * Terminal-status module tests.
 *
 * Guards the single source of truth for terminal sprint/mission status sets and
 * the case-folded comparison helpers. The bug class these prevent shipped three
 * times from hand-written NOT-IN lists (s74-m02 currentSprint, c265768 'Reverted',
 * orphan-detection.ts): a terminal status omitted from one list, or a case-sensitive
 * compare a drifted-case status dodged. These tests fail if either regresses.
 *
 * @module tests/tools/cmos/terminal-status
 */

import {
  SPRINT_TERMINAL_STATUSES,
  SPRINT_NO_OPEN_WORK_STATUSES,
  MISSION_TERMINAL_STATUSES,
  statusNotInSql,
  isTerminalStatus,
} from '../../../src/tools/cmos/terminal-status';

describe('terminal-status', () => {
  describe('status sets', () => {
    it('SPRINT_TERMINAL_STATUSES is the dead set (Archived/Failed/Dropped/Reverted) and excludes Completed', () => {
      expect([...SPRINT_TERMINAL_STATUSES].sort()).toEqual(
        ['Archived', 'Dropped', 'Failed', 'Reverted'].sort()
      );
      expect(SPRINT_TERMINAL_STATUSES).not.toContain('Completed');
    });

    it('SPRINT_NO_OPEN_WORK_STATUSES is the dead set plus Completed', () => {
      expect([...SPRINT_NO_OPEN_WORK_STATUSES].sort()).toEqual(
        ['Archived', 'Completed', 'Dropped', 'Failed', 'Reverted'].sort()
      );
    });

    it('MISSION_TERMINAL_STATUSES is {Completed, Dropped, Deferred} — never Archived/Reverted/Failed', () => {
      // s87-m01: 'Failed' REMOVED. #839 assigns it to the SPRINT domain and carries an
      // implementation guardrail against exactly this copy — "do NOT blind-copy
      // DEAD_SPRINT_STATUSES onto the mission predicate — the two predicates operate in DIFFERENT
      // status domains" — and 'Failed' was never a key of VALID_STATE_TRANSITIONS, so the
      // constant asserted a mission state the state machine had no entry for.
      expect([...MISSION_TERMINAL_STATUSES].sort()).toEqual(
        ['Completed', 'Deferred', 'Dropped'].sort()
      );
      expect(MISSION_TERMINAL_STATUSES).not.toContain('Archived');
      expect(MISSION_TERMINAL_STATUSES).not.toContain('Reverted');
      expect(MISSION_TERMINAL_STATUSES).not.toContain('Failed');
      expect(MISSION_TERMINAL_STATUSES).toContain('Deferred');
    });

    it('the mission set and the sprint set do not overlap on Failed (#839, the drift this closes)', () => {
      // The regression this pins is not "an item was removed" but "the two domains were merged".
      // SPRINT_TERMINAL_STATUSES keeps Failed; MISSION_TERMINAL_STATUSES must not re-acquire it.
      expect(SPRINT_TERMINAL_STATUSES).toContain('Failed');
      expect(MISSION_TERMINAL_STATUSES).not.toContain('Failed');
    });
  });

  describe('statusNotInSql', () => {
    it('builds a case-folded UPPER(...) NOT IN (...) fragment', () => {
      expect(statusNotInSql('s.status', SPRINT_TERMINAL_STATUSES)).toBe(
        "UPPER(s.status) NOT IN ('ARCHIVED', 'FAILED', 'DROPPED', 'REVERTED')"
      );
    });

    it('upper-cases every status literal, so no drifted-case value can dodge it', () => {
      const frag = statusNotInSql('status', MISSION_TERMINAL_STATUSES);
      expect(frag).toContain("'COMPLETED'");
      expect(frag).toContain("'DEFERRED'");
      // No lowercase status literal survives that a case-sensitive compare would miss.
      expect(frag).not.toMatch(/'[a-z]/);
    });
  });

  describe('isTerminalStatus', () => {
    it('matches a terminal status regardless of case (the drift a case-sensitive compare misses)', () => {
      expect(isTerminalStatus('Failed', SPRINT_TERMINAL_STATUSES)).toBe(true);
      expect(isTerminalStatus('failed', SPRINT_TERMINAL_STATUSES)).toBe(true);
      expect(isTerminalStatus('REVERTED', SPRINT_TERMINAL_STATUSES)).toBe(true);
      expect(isTerminalStatus('deferred', MISSION_TERMINAL_STATUSES)).toBe(true);
    });

    it('returns false for live statuses and for null/undefined', () => {
      expect(isTerminalStatus('Active', SPRINT_TERMINAL_STATUSES)).toBe(false);
      expect(isTerminalStatus('In Progress', MISSION_TERMINAL_STATUSES)).toBe(false);
      expect(isTerminalStatus(null, SPRINT_TERMINAL_STATUSES)).toBe(false);
      expect(isTerminalStatus(undefined, MISSION_TERMINAL_STATUSES)).toBe(false);
    });

    it('treats Completed as no-open-work but not as a dead sprint status', () => {
      expect(isTerminalStatus('Completed', SPRINT_TERMINAL_STATUSES)).toBe(false);
      expect(isTerminalStatus('Completed', SPRINT_NO_OPEN_WORK_STATUSES)).toBe(true);
    });
  });
});
