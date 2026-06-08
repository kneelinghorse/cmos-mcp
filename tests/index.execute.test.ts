import { describe, expect, test } from '@jest/globals';
import { executeMissionProtocolTool } from '../src/index';
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

describe('executeMissionProtocolTool integration (mocked)', () => {
  test.each(DEPRECATED_TOOL_NAMES)('rejects deprecated tool %s', async (toolName) => {
    await expect(executeMissionProtocolTool(toolName, {}, {} as any)).rejects.toThrow(
      `Unknown tool: ${toolName}`
    );
  });

  test('throws McpError for unknown tool', async () => {
    await expect(executeMissionProtocolTool('unknown_tool', {}, {} as any)).rejects.toThrow(
      'Unknown tool: unknown_tool'
    );
  });
});
