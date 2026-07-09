import { describe, expect, test } from '@jest/globals';
import {
  classifyAction,
  READ_ONLY_ACTIONS,
  READ_ONLY_TOOLS,
} from '../../../src/tools/cmos/action-taxonomy';
import { CMOS_CONTEXT_ACTIONS } from '../../../src/tools/cmos/cmos-context';
import { CMOS_DB_ACTIONS } from '../../../src/tools/cmos/cmos-db';
import { CMOS_DECISIONS_ACTIONS } from '../../../src/tools/cmos/cmos-decisions';
import { CMOS_FEEDBACK_ACTIONS } from '../../../src/tools/cmos/cmos-feedback';
import { CMOS_LEARNINGS_ACTIONS } from '../../../src/tools/cmos/cmos-learnings';
import { CMOS_MISSION_ACTIONS } from '../../../src/tools/cmos/cmos-mission';
import { CMOS_MISSION_TRANSITION_ACTIONS } from '../../../src/tools/cmos/cmos-mission-transition';
import { CMOS_PROJECT_ACTIONS } from '../../../src/tools/cmos/cmos-project';
import { CMOS_SESSION_ACTIONS } from '../../../src/tools/cmos/cmos-session';
import { CMOS_SPRINT_ACTIONS } from '../../../src/tools/cmos/cmos-sprint';
import { CMOS_AUTH_ACTIONS } from '../../../src/tools/cmos/cmos-auth';
import { CMOS_MESSAGE_ACTIONS } from '../../../src/tools/cmos/cmos-message';

// Every action-bearing CMOS tool, paired with its shipped action list. This IMPORTS
// the real CMOS_*_ACTIONS constants so a new action added to any tool without
// updating the taxonomy is caught here (it will classify 'write' — fail closed).
const TOOL_ACTIONS: Record<string, readonly string[]> = {
  cmos_context: CMOS_CONTEXT_ACTIONS,
  cmos_db: CMOS_DB_ACTIONS,
  cmos_decisions: CMOS_DECISIONS_ACTIONS,
  cmos_feedback: CMOS_FEEDBACK_ACTIONS,
  cmos_learnings: CMOS_LEARNINGS_ACTIONS,
  cmos_mission: CMOS_MISSION_ACTIONS,
  cmos_mission_transition: CMOS_MISSION_TRANSITION_ACTIONS,
  cmos_project: CMOS_PROJECT_ACTIONS,
  cmos_session: CMOS_SESSION_ACTIONS,
  cmos_sprint: CMOS_SPRINT_ACTIONS,
  cmos_auth: CMOS_AUTH_ACTIONS,
  cmos_message: CMOS_MESSAGE_ACTIONS,
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
    // Catches the client.ts isReadAction bug class (it lists cmos_context:'show',
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
    expect(classifyAction('cmos_nonexistent', 'list')).toBe('write');
    expect(classifyAction('cmos_mission', 'obliterate')).toBe('write');
    expect(classifyAction('cmos_mission', undefined)).toBe('write');
    // An action-less read tool name given a bogus action stays read (tool-level).
    expect(classifyAction('cmos_review', 'anything')).toBe('read');
  });

  test('cmos_agent_onboard is WRITE, not read (its handler mutates the store; s78-m04)', () => {
    // Regression guard for the adversarial-review finding: onboard persists owner/identity
    // and can INSERT agent_feedback, so it must never be on the read allowlist.
    expect(READ_ONLY_TOOLS.has('cmos_agent_onboard')).toBe(false);
    expect(classifyAction('cmos_agent_onboard', undefined)).toBe('write');
    expect(classifyAction('cmos_agent_onboard', 'anything')).toBe('write');
  });

  test('representative writes are classified write; representative reads read', () => {
    expect(classifyAction('cmos_mission_transition', 'complete')).toBe('write');
    expect(classifyAction('cmos_db', 'purge')).toBe('write');
    expect(classifyAction('cmos_context', 'update')).toBe('write');
    expect(classifyAction('cmos_sprint', 'complete')).toBe('write');
    expect(classifyAction('cmos_mission', 'status')).toBe('read');
    expect(classifyAction('cmos_context', 'view')).toBe('read');
  });
});
