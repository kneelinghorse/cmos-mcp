/**
 * Legacy Tool Deprecation Smoke Tests
 *
 * Validates that deprecated Mission Protocol tools are no longer discoverable
 * or callable via the public MCP entry point.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  buildMissionProtocolContext,
  executeMissionProtocolTool,
  getToolDefinitions,
  MissionProtocolContext,
} from '../../src/index';

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
] as const;

describe('Legacy tool deprecation smoke coverage', () => {
  let context: MissionProtocolContext;

  beforeAll(async () => {
    context = await buildMissionProtocolContext({ defaultModel: 'gpt' });
  });

  it('list_tools omits deprecated Mission Protocol tools', () => {
    const toolNames = getToolDefinitions().map((tool) => tool.name);

    expect(toolNames).toEqual(
      expect.arrayContaining(['cmos_db', 'cmos_agent_onboard', 'cmos_sprint'])
    );
    for (const toolName of DEPRECATED_TOOL_NAMES) {
      expect(toolNames).not.toContain(toolName);
    }
  });

  it.each(DEPRECATED_TOOL_NAMES)('rejects deprecated tool %s', async (toolName) => {
    await expect(executeMissionProtocolTool(toolName, {}, context)).rejects.toMatchObject({
      code: ErrorCode.MethodNotFound,
    });
  });
});
