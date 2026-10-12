import { describe, expect, test } from '@jest/globals';
import {
  classifyAction,
  READ_ONLY_ACTIONS,
  READ_ONLY_TOOLS,
} from '../../../src/tools/rbook/action-taxonomy';
import { RBOOK_CONTEXT_ACTIONS } from '../../../src/tools/rbook/rbook-context';
import { RBOOK_DB_ACTIONS } from '../../../src/tools/rbook/rbook-db';
import { RBOOK_DECISIONS_ACTIONS } from '../../../src/tools/rbook/rbook-decisions';
import { RBOOK_FEEDBACK_ACTIONS } from '../../../src/tools/rbook/rbook-feedback';
import { RBOOK_LEARNINGS_ACTIONS } from '../../../src/tools/rbook/rbook-learnings';
import { RBOOK_MISSION_ACTIONS } from '../../../src/tools/rbook/rbook-mission';
import { RBOOK_MISSION_TRANSITION_ACTIONS } from '../../../src/tools/rbook/rbook-mission-transition';
import { RBOOK_PROJECT_ACTIONS } from '../../../src/tools/rbook/rbook-project';
import { RBOOK_SESSION_ACTIONS } from '../../../src/tools/rbook/rbook-session';
import { RBOOK_SPRINT_ACTIONS } from '../../../src/tools/rbook/rbook-sprint';
import { RBOOK_AUTH_ACTIONS } from '../../../src/tools/rbook/rbook-auth';
import { RBOOK_MESSAGE_ACTIONS } from '../../../src/tools/rbook/rbook-message';

// Every action-bearing Reasonbook tool, paired with its shipped action list. This IMPORTS
// the real RBOOK_*_ACTIONS constants so a new action added to any tool without
// updating the taxonomy is caught here (it will classify 'write' — fail closed).
const TOOL_ACTIONS: Record<string, readonly string[]> = {
  rbook_context: RBOOK_CONTEXT_ACTIONS,
  rbook_db: RBOOK_DB_ACTIONS,
  rbook_decisions: RBOOK_DECISIONS_ACTIONS,
  rbook_feedback: RBOOK_FEEDBACK_ACTIONS,
  rbook_learnings: RBOOK_LEARNINGS_ACTIONS,
  rbook_mission: RBOOK_MISSION_ACTIONS,
  rbook_mission_transition: RBOOK_MISSION_TRANSITION_ACTIONS,
  rbook_project: RBOOK_PROJECT_ACTIONS,
  rbook_session: RBOOK_SESSION_ACTIONS,
  rbook_sprint: RBOOK_SPRINT_ACTIONS,
  rbook_auth: RBOOK_AUTH_ACTIONS,
  rbook_message: RBOOK_MESSAGE_ACTIONS,
};

describe('action taxonomy (fail-closed read/write classification)', () => {
  test('every shipped action of every tool classifies to read or write', () => {
    for (const [tool, actions] of Object.entries(TOOL_ACTIONS)) {
      for (const action of actions) {
        expect(['read', 'write']).toContain(classifyAction(tool, action));
      }
    }
  });

  test('an action is read IFF it is in the tool read-allowlist (drift guard)', () => {
    for (const [tool, actions] of Object.entries(TOOL_ACTIONS)) {
      const allow = new Set(READ_ONLY_ACTIONS[tool] ?? []);
      for (const action of actions) {
        const expected = allow.has(action) ? 'read' : 'write';
        expect(classifyAction(tool, action)).toBe(expected);
      }
    }
  });

  test('the read-allowlist contains NO stale/typo entries (each is a real shipped action)', () => {
    // Catches the client.ts isReadAction bug class (it lists rbook_context:'show',
    // which is not a real action). Every allowlisted read must exist in the tool.
    for (const [tool, reads] of Object.entries(READ_ONLY_ACTIONS)) {
      const shipped = new Set(TOOL_ACTIONS[tool] ?? []);
      expect(TOOL_ACTIONS[tool]).toBeDefined();
      for (const action of reads) {
        expect(shipped.has(action)).toBe(true);
      }
    }
  });

  test('the read-allowlist covers exactly the action-bearing tools', () => {
    expect(new Set(Object.keys(READ_ONLY_ACTIONS))).toEqual(new Set(Object.keys(TOOL_ACTIONS)));
  });

  test('action-less digest tools are always read', () => {
    for (const tool of READ_ONLY_TOOLS) {
      expect(classifyAction(tool, undefined)).toBe('read');
    }
  });

  test('unknown tool, unknown action, and missing action all fail closed to write', () => {
    expect(classifyAction('rbook_nonexistent', 'list')).toBe('write');
    expect(classifyAction('rbook_mission', 'obliterate')).toBe('write');
    expect(classifyAction('rbook_mission', undefined)).toBe('write');
    // An action-less read tool name given a bogus action stays read (tool-level).
    expect(classifyAction('rbook_review', 'anything')).toBe('read');
  });

  test('rbook_agent_onboard is WRITE, not read (its handler mutates the store; s78-m04)', () => {
    // Regression guard for the adversarial-review finding: onboard persists owner/identity
    // and can INSERT agent_feedback, so it must never be on the read allowlist.
    expect(READ_ONLY_TOOLS.has('rbook_agent_onboard')).toBe(false);
    expect(classifyAction('rbook_agent_onboard', undefined)).toBe('write');
    expect(classifyAction('rbook_agent_onboard', 'anything')).toBe('write');
  });

  test('representative writes are classified write; representative reads read', () => {
    expect(classifyAction('rbook_mission_transition', 'complete')).toBe('write');
    expect(classifyAction('rbook_db', 'purge')).toBe('write');
    expect(classifyAction('rbook_context', 'update')).toBe('write');
    expect(classifyAction('rbook_sprint', 'complete')).toBe('write');
    expect(classifyAction('rbook_mission', 'status')).toBe('read');
    expect(classifyAction('rbook_context', 'view')).toBe('read');
  });
});
