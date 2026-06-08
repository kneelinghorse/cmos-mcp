import { describe, it, expect, beforeAll } from '@jest/globals';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  buildMissionProtocolContext,
  executeMissionProtocolTool,
  getToolDefinitions,
} from '../../src/index';
import type { MissionProtocolContext } from '../../src/index';
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

describe('Public MCP tool surface integration', () => {
  let context: MissionProtocolContext;

  beforeAll(async () => {
    context = await buildMissionProtocolContext({ defaultModel: 'claude' });
  });

  const runTool = async (name: string, args?: unknown) =>
    executeMissionProtocolTool(name, args, context);

  it('exposes CMOS tools but not legacy Mission Protocol tools', () => {
    const toolNames = getToolDefinitions().map((tool) => tool.name);

    expect(toolNames).toEqual(
      expect.arrayContaining([
        'cmos_mission',
        'cmos_mission_transition',
        'cmos_sprint',
        'cmos_context',
        'cmos_session',
        'cmos_decisions',
        'cmos_db',
        'cmos_project',
        'cmos_agent_onboard',
      ])
    );

    for (const toolName of DEPRECATED_TOOL_NAMES) {
      expect(toolNames).not.toContain(toolName);
    }
  });

  it.each(DEPRECATED_TOOL_NAMES)('rejects deprecated tool %s', async (toolName) => {
    await expect(runTool(toolName, {})).rejects.toMatchObject({
      code: ErrorCode.MethodNotFound,
    });
  });

  it('throws for unknown tool names', async () => {
    await expect(runTool('unknown_tool_name', {})).rejects.toThrow('Unknown tool');
  });
});
