import { describe, expect, test } from '@jest/globals';
import {
  assertReadOnlyAgentAllowed,
  isReadOnlyAgentSession,
  ReadOnlyAgentGuardError,
  READ_ONLY_AGENT_ENV,
} from '../../../src/tools/cmos/read-only-agent-guard';

const REVIEW = { [READ_ONLY_AGENT_ENV]: 'review' } as NodeJS.ProcessEnv;
const UNSET = {} as NodeJS.ProcessEnv;
const OTHER = { [READ_ONLY_AGENT_ENV]: 'builder' } as NodeJS.ProcessEnv;

describe('read-only-agent-guard', () => {
  test('isReadOnlyAgentSession is true ONLY for the exact review role value', () => {
    expect(isReadOnlyAgentSession(REVIEW)).toBe(true);
    expect(isReadOnlyAgentSession(UNSET)).toBe(false);
    expect(isReadOnlyAgentSession(OTHER)).toBe(false);
    expect(isReadOnlyAgentSession({ [READ_ONLY_AGENT_ENV]: 'Review' } as NodeJS.ProcessEnv)).toBe(
      false
    );
  });

  test('strict no-op when the env is unset — even writes pass', () => {
    expect(() =>
      assertReadOnlyAgentAllowed('cmos_mission_transition', 'complete', UNSET)
    ).not.toThrow();
    expect(() => assertReadOnlyAgentAllowed('cmos_db', 'purge', UNSET)).not.toThrow();
    expect(() => assertReadOnlyAgentAllowed('cmos_nonexistent', 'whatever', UNSET)).not.toThrow();
  });

  test('strict no-op for any non-review role value', () => {
    expect(() => assertReadOnlyAgentAllowed('cmos_db', 'purge', OTHER)).not.toThrow();
  });

  test('under review role, write actions throw ReadOnlyAgentGuardError', () => {
    for (const [tool, action] of [
      ['cmos_mission_transition', 'complete'],
      ['cmos_sprint', 'complete'],
      ['cmos_context', 'update'],
      ['cmos_db', 'purge'],
      ['cmos_session', 'capture'],
    ] as const) {
      expect(() => assertReadOnlyAgentAllowed(tool, action, REVIEW)).toThrow(
        ReadOnlyAgentGuardError
      );
    }
  });

  test('under review role, read actions and read tools are allowed', () => {
    expect(() => assertReadOnlyAgentAllowed('cmos_mission', 'status', REVIEW)).not.toThrow();
    expect(() => assertReadOnlyAgentAllowed('cmos_context', 'view', REVIEW)).not.toThrow();
    expect(() => assertReadOnlyAgentAllowed('cmos_decisions', 'list', REVIEW)).not.toThrow();
    expect(() => assertReadOnlyAgentAllowed('cmos_review', undefined, REVIEW)).not.toThrow();
    expect(() => assertReadOnlyAgentAllowed('cmos_status', undefined, REVIEW)).not.toThrow();
  });

  test('under review role, cmos_agent_onboard is blocked (write-bearing handler; s78-m04)', () => {
    expect(() => assertReadOnlyAgentAllowed('cmos_agent_onboard', undefined, REVIEW)).toThrow(
      ReadOnlyAgentGuardError
    );
  });

  test('the standalone guard keeps unknown tools/actions fail-closed as write-classified', () => {
    // Dispatcher schema/protocol validation runs before this primitive. These assertions preserve
    // the guard's own fail-closed fallback if a caller invokes it without that outer validation.
    expect(() => assertReadOnlyAgentAllowed('cmos_nonexistent', 'list', REVIEW)).toThrow(
      ReadOnlyAgentGuardError
    );
    expect(() => assertReadOnlyAgentAllowed('cmos_mission', 'obliterate', REVIEW)).toThrow(
      ReadOnlyAgentGuardError
    );
    expect(() => assertReadOnlyAgentAllowed('cmos_mission', undefined, REVIEW)).toThrow(
      ReadOnlyAgentGuardError
    );
  });

  test('the error carries tool/action context and a clear read-only message', () => {
    try {
      assertReadOnlyAgentAllowed('cmos_db', 'purge', REVIEW);
      throw new Error('expected ReadOnlyAgentGuardError');
    } catch (error) {
      expect(error).toBeInstanceOf(ReadOnlyAgentGuardError);
      const guard = error as ReadOnlyAgentGuardError;
      expect(guard.toolName).toBe('cmos_db');
      expect(guard.action).toBe('purge');
      expect(guard.message).toContain('read-only');
      expect(guard.message).toContain('cmos_db');
      expect(guard.message).toContain(READ_ONLY_AGENT_ENV);
    }
  });

  test('defaults to process.env when no env is passed', () => {
    const saved = process.env[READ_ONLY_AGENT_ENV];
    try {
      delete process.env[READ_ONLY_AGENT_ENV];
      expect(() => assertReadOnlyAgentAllowed('cmos_db', 'purge')).not.toThrow();
      process.env[READ_ONLY_AGENT_ENV] = 'review';
      expect(() => assertReadOnlyAgentAllowed('cmos_db', 'purge')).toThrow(ReadOnlyAgentGuardError);
    } finally {
      if (saved === undefined) delete process.env[READ_ONLY_AGENT_ENV];
      else process.env[READ_ONLY_AGENT_ENV] = saved;
    }
  });
});
