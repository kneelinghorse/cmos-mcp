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
  'rbook_sprint_list',
  'rbook_sprint_show',
  'rbook_sprint_add',
  'rbook_sprint_update',
  'rbook_sprint_complete',
  'rbook_mission_list',
  'rbook_mission_show',
  'rbook_mission_status',
  'rbook_mission_start',
  'rbook_mission_complete',
  'rbook_mission_block',
  'rbook_mission_unblock',
  'rbook_mission_update',
  'rbook_mission_add',
  'rbook_mission_depends',
  'rbook_context_view',
  'rbook_context_update',
  'rbook_context_condense',
  'rbook_context_snapshot',
  'rbook_context_history',
  'rbook_session_start',
  'rbook_session_capture',
  'rbook_session_complete',
  'rbook_session_list',
  'rbook_decisions_list',
  'rbook_decisions_search',
  'rbook_db_health',
  'rbook_db_snapshot',
  'rbook_db_restore',
  'rbook_project_register',
  'rbook_project_list',
  'rbook_project_unregister',
  'rbook_project_validate',
  'rbook_project_init',
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

  test('tool count includes only Reasonbook tools', () => {
    const tools = getToolDefinitions();
    // Sprint 64 m03: added rbook_review (bundled session-opener digest), bringing the total to 15.
    expect(tools.length).toBe(15);

    const names = tools.map((t) => t.name).sort();
    for (const toolName of DEPRECATED_TOOL_NAMES) {
      expect(names).not.toContain(toolName);
    }

    // Verify consolidated Reasonbook tools are present
    expect(names).toContain('rbook_mission');
    expect(names).toContain('rbook_mission_transition');
    expect(names).toContain('rbook_sprint');
    expect(names).toContain('rbook_context');
    expect(names).toContain('rbook_session');
    expect(names).toContain('rbook_decisions');
    expect(names).toContain('rbook_learnings');
    expect(names).toContain('rbook_db');
    expect(names).toContain('rbook_project');
    expect(names).toContain('rbook_message');
    expect(names).toContain('rbook_agent_onboard');
    expect(names).toContain('rbook_feedback');
    expect(names).toContain('rbook_auth');
    expect(names).toContain('rbook_status');
    expect(names).toContain('rbook_review');
  });
});
