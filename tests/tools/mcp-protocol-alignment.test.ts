import { describe, expect, test, jest } from '@jest/globals';
import Ajv2020 from 'ajv/dist/2020';
import { executeMissionProtocolTool, getToolDefinitions } from '../../src/index';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

function createMockContext(): any {
  return {
    baseDir: '/tmp',
    defaultModel: 'claude',
    loader: {} as any,
    registryParser: {
      loadRegistry: jest.fn(async () => [{ name: 'domain.pack' }]),
    },
    createMissionTool: {
      execute: jest.fn(async () => 'mission: yaml'),
      formatForLLM: jest.fn(() => 'mission'),
    },
    splitMissionTool: {
      execute: jest.fn(async () => ({ shouldSplit: false })),
      formatForLLM: jest.fn(() => 'split'),
    },
    tokenCounter: {} as any,
    listDomainsTool: {
      execute: jest.fn(async () => []),
      formatForLLM: jest.fn(() => 'domains'),
    },
  };
}

describe('MCP protocol alignment', () => {
  test('all tool input schemas validate against JSON Schema 2020-12 conventions', () => {
    const ajv = new Ajv2020({ strict: false, validateSchema: true, allErrors: true });
    const definitions = getToolDefinitions();
    const invalidTools: string[] = [];

    for (const definition of definitions) {
      const schema = definition.inputSchema as Record<string, unknown>;
      const schemaValid = ajv.validateSchema(schema);
      if (!schemaValid) {
        invalidTools.push(definition.name);
      }

      if (schema.type === 'object') {
        expect(schema).toHaveProperty('additionalProperties', false);
      }
    }

    expect(invalidTools).toEqual([]);
  });

  test('deprecated public tool names are rejected with MCP method-not-found', async () => {
    await expect(
      executeMissionProtocolTool(
        'get_mission_quality_score',
        { missionFile: 'bad.yaml' },
        createMockContext()
      )
    ).rejects.toMatchObject({
      code: ErrorCode.MethodNotFound,
    });
    await expect(
      executeMissionProtocolTool(
        'get_mission_quality_score',
        { missionFile: 'bad.yaml' },
        createMockContext()
      )
    ).rejects.toBeInstanceOf(McpError);
  });
});
