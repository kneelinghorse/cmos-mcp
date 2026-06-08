import { describe, expect, test } from '@jest/globals';
import { getToolDefinitions } from '../../src/index';

function sanitize(value: unknown): unknown {
  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item));
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
      .reduce<Record<string, unknown>>((acc, [key, val]) => {
        acc[key] = sanitize(val);
        return acc;
      }, {});
  }

  return value;
}

const DEPRECATED_TOOL_NAMES = [
  'get_available_domains',
  'create_mission',
  'get_mission_quality_score',
  'create_mission_splits',
  'cmos_sprint_list',
  'cmos_sprint_show',
  'cmos_sprint_add',
  'cmos_sprint_update',
  'cmos_sprint_complete',
  'cmos_mission_list',
  'cmos_mission_show',
  'cmos_mission_status',
  'cmos_mission_start',
  'cmos_mission_complete',
  'cmos_mission_block',
  'cmos_mission_unblock',
  'cmos_mission_update',
  'cmos_mission_add',
  'cmos_mission_depends',
  'cmos_context_view',
  'cmos_context_update',
  'cmos_context_condense',
  'cmos_context_snapshot',
  'cmos_context_history',
  'cmos_session_start',
  'cmos_session_capture',
  'cmos_session_complete',
  'cmos_session_list',
  'cmos_decisions_list',
  'cmos_decisions_search',
  'cmos_db_health',
  'cmos_db_snapshot',
  'cmos_db_restore',
  'cmos_project_register',
  'cmos_project_list',
  'cmos_project_unregister',
  'cmos_project_validate',
  'cmos_project_init',
] as const;

describe('Tool definitions contract', () => {
  test('registered tool schema stays stable', () => {
    const normalized = getToolDefinitions()
      .map((definition) => sanitize(definition))
      .sort((a, b) =>
        String((a as { name: string }).name).localeCompare(String((b as { name: string }).name))
      );

    expect(normalized).toMatchSnapshot();
  });

  test('tool names remain unique', () => {
    const names = getToolDefinitions().map((definition) => definition.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  test('tool count includes only CMOS tools', () => {
    const tools = getToolDefinitions();
    // Sprint 64 m03: added cmos_review (bundled session-opener digest), bringing the total to 15.
    expect(tools.length).toBe(15);

    const names = tools.map((t) => t.name).sort();
    for (const toolName of DEPRECATED_TOOL_NAMES) {
      expect(names).not.toContain(toolName);
    }

    // Verify consolidated CMOS tools are present
    expect(names).toContain('cmos_mission');
    expect(names).toContain('cmos_mission_transition');
    expect(names).toContain('cmos_sprint');
    expect(names).toContain('cmos_context');
    expect(names).toContain('cmos_session');
    expect(names).toContain('cmos_decisions');
    expect(names).toContain('cmos_learnings');
    expect(names).toContain('cmos_db');
    expect(names).toContain('cmos_project');
    expect(names).toContain('cmos_message');
    expect(names).toContain('cmos_agent_onboard');
    expect(names).toContain('cmos_feedback');
    expect(names).toContain('cmos_auth');
    expect(names).toContain('cmos_status');
    expect(names).toContain('cmos_review');
  });
});
