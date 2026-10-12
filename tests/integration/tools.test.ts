import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  buildMissionProtocolContext,
  executeMissionProtocolTool,
  getToolDefinitions,
} from '../../src/index';
import type { MissionProtocolContext } from '../../src/index';
import { ProtocolErrorCode } from '@modelcontextprotocol/server';

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

describe('Public MCP tool surface integration', () => {
  let context: MissionProtocolContext;

  beforeAll(async () => {
    context = await buildMissionProtocolContext({ defaultModel: 'claude' });
  });

  const runTool = async (name: string, args?: unknown) =>
    executeMissionProtocolTool(name, args, context);

  it('exposes Reasonbook tools but not legacy Mission Protocol tools', () => {
    const toolNames = getToolDefinitions().map((tool) => tool.name);

    expect(toolNames).toEqual(
      expect.arrayContaining([
        'rbook_mission',
        'rbook_mission_transition',
        'rbook_sprint',
        'rbook_context',
        'rbook_session',
        'rbook_decisions',
        'rbook_db',
        'rbook_project',
        'rbook_agent_onboard',
      ])
    );

    for (const toolName of DEPRECATED_TOOL_NAMES) {
      expect(toolNames).not.toContain(toolName);
    }
  });

  it.each(DEPRECATED_TOOL_NAMES)('rejects deprecated tool %s', async (toolName) => {
    await expect(runTool(toolName, {})).rejects.toMatchObject({
      code: ProtocolErrorCode.MethodNotFound,
    });
  });

  it('throws for unknown tool names', async () => {
    await expect(runTool('unknown_tool_name', {})).rejects.toThrow('Unknown tool');
  });
});
