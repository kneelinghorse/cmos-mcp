import { describe, expect, test } from '@jest/globals';
import {
  assertReadOnlyAgentAllowed,
  isReadOnlyAgentSession,
  ReadOnlyAgentGuardError,
  READ_ONLY_AGENT_ENV,
} from '../../../src/tools/rbook/read-only-agent-guard';

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
      assertReadOnlyAgentAllowed('rbook_mission_transition', 'complete', UNSET)
    ).not.toThrow();
    expect(() => assertReadOnlyAgentAllowed('rbook_db', 'purge', UNSET)).not.toThrow();
    expect(() => assertReadOnlyAgentAllowed('rbook_nonexistent', 'whatever', UNSET)).not.toThrow();
  });

  test('strict no-op for any non-review role value', () => {
    expect(() => assertReadOnlyAgentAllowed('rbook_db', 'purge', OTHER)).not.toThrow();
  });

  test('under review role, write actions throw ReadOnlyAgentGuardError', () => {
    for (const [tool, action] of [
      ['rbook_mission_transition', 'complete'],
      ['rbook_sprint', 'complete'],
      ['rbook_context', 'update'],
      ['rbook_db', 'purge'],
      ['rbook_session', 'capture'],
    ] as const) {
      expect(() => assertReadOnlyAgentAllowed(tool, action, REVIEW)).toThrow(
        ReadOnlyAgentGuardError
      );
    }
  });

  test('under review role, read actions and read tools are allowed', () => {
    expect(() => assertReadOnlyAgentAllowed('rbook_mission', 'status', REVIEW)).not.toThrow();
    expect(() => assertReadOnlyAgentAllowed('rbook_context', 'view', REVIEW)).not.toThrow();
    expect(() => assertReadOnlyAgentAllowed('rbook_decisions', 'list', REVIEW)).not.toThrow();
    expect(() => assertReadOnlyAgentAllowed('rbook_review', undefined, REVIEW)).not.toThrow();
    expect(() => assertReadOnlyAgentAllowed('rbook_status', undefined, REVIEW)).not.toThrow();
  });

  test('under review role, rbook_agent_onboard is blocked (write-bearing handler; s78-m04)', () => {
    expect(() => assertReadOnlyAgentAllowed('rbook_agent_onboard', undefined, REVIEW)).toThrow(
      ReadOnlyAgentGuardError
    );
  });

  test('the standalone guard keeps unknown tools/actions fail-closed as write-classified', () => {
    // Dispatcher schema/protocol validation runs before this primitive. These assertions preserve
    // the guard's own fail-closed fallback if a caller invokes it without that outer validation.
    expect(() => assertReadOnlyAgentAllowed('rbook_nonexistent', 'list', REVIEW)).toThrow(
      ReadOnlyAgentGuardError
    );
    expect(() => assertReadOnlyAgentAllowed('rbook_mission', 'obliterate', REVIEW)).toThrow(
      ReadOnlyAgentGuardError
    );
    expect(() => assertReadOnlyAgentAllowed('rbook_mission', undefined, REVIEW)).toThrow(
      ReadOnlyAgentGuardError
    );
  });

  test('the error carries tool/action context and a clear read-only message', () => {
    try {
      assertReadOnlyAgentAllowed('rbook_db', 'purge', REVIEW);
      throw new Error('expected ReadOnlyAgentGuardError');
    } catch (error) {
      expect(error).toBeInstanceOf(ReadOnlyAgentGuardError);
      const guard = error as ReadOnlyAgentGuardError;
      expect(guard.toolName).toBe('rbook_db');
      expect(guard.action).toBe('purge');
      expect(guard.message).toContain('read-only');
      expect(guard.message).toContain('rbook_db');
      expect(guard.message).toContain(READ_ONLY_AGENT_ENV);
    }
  });

  test('defaults to process.env when no env is passed', () => {
    const saved = process.env[READ_ONLY_AGENT_ENV];
    try {
      delete process.env[READ_ONLY_AGENT_ENV];
      expect(() => assertReadOnlyAgentAllowed('rbook_db', 'purge')).not.toThrow();
      process.env[READ_ONLY_AGENT_ENV] = 'review';
      expect(() => assertReadOnlyAgentAllowed('rbook_db', 'purge')).toThrow(
        ReadOnlyAgentGuardError
      );
    } finally {
      if (saved === undefined) delete process.env[READ_ONLY_AGENT_ENV];
      else process.env[READ_ONLY_AGENT_ENV] = saved;
    }
  });
});
