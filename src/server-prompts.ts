// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exposes portable CMOS commands as MCP prompts backed by the plugin's skill files.
// ABOUTME: Reads the installed sources so skill and prompt instructions cannot drift into copies.

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { Server } from '@modelcontextprotocol/server';

const COMMANDS = ['start', 'close-out', 'plan', 'build'] as const;
const SKILL_ROOT = path.resolve(__dirname, '../plugins/cmos/skills');

function readSkill(command: (typeof COMMANDS)[number], skillRoot: string) {
  try {
    const source = fs.readFileSync(path.join(skillRoot, command, 'SKILL.md'), 'utf8');
    const frontmatter = /^---\r?\n([\s\S]+?)\r?\n---\r?\n/.exec(source);
    if (!frontmatter) throw new Error('Missing skill metadata');
    const metadata: unknown = parseYaml(frontmatter[1]);
    const body = source.slice(frontmatter[0].length).trim();
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      !('name' in metadata) ||
      metadata.name !== command ||
      !('description' in metadata) ||
      typeof metadata.description !== 'string' ||
      !metadata.description.trim() ||
      !body
    ) {
      throw new Error('Skill name, description or body is invalid');
    }
    return { name: `cmos-${command}`, description: metadata.description, body };
  } catch (error) {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      `Cannot load cmos-${command}: ${error instanceof Error ? error.message : String(error)}. ` +
        'Reinstall @aquex/cmos-mcp to restore its shared skill sources.'
    );
  }
}

export function registerCmosPromptHandlers(server: Server, skillRoot = SKILL_ROOT): void {
  server.setRequestHandler('prompts/list', async () => ({
    prompts: COMMANDS.map((command) => {
      const { name, description } = readSkill(command, skillRoot);
      return { name, description };
    }),
  }));

  server.setRequestHandler('prompts/get', async (request) => {
    const command = COMMANDS.find((candidate) => `cmos-${candidate}` === request.params.name);
    if (!command) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Unknown prompt '${request.params.name}'. Use ${COMMANDS.map((name) => `cmos-${name}`).join(', ')}.`
      );
    }
    if (Object.keys(request.params.arguments ?? {}).length > 0) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `${request.params.name} does not accept arguments. Invoke it without arguments and describe the scope in the conversation.`
      );
    }
    const { description, body } = readSkill(command, skillRoot);
    return {
      description,
      messages: [{ role: 'user', content: { type: 'text', text: body } }],
    };
  });
}
