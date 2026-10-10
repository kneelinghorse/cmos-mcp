// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercises portable CMOS commands through a real MCP client and transport.
// ABOUTME: Keeps prompt bodies tied to the shipped skill sources and rejects unusable requests.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Server, InMemoryTransport, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { parse as parseYaml } from 'yaml';
import { registerCmosPromptHandlers } from '../src/server-prompts';

const SKILL_ROOT = path.resolve(__dirname, '../plugins/cmos/skills');
const COMMANDS = ['start', 'close-out', 'plan', 'build'];

async function connect(skillRoot?: string) {
  const server = new Server(
    { name: 'cmos-prompt-test', version: '1.0.0' },
    { capabilities: { prompts: {} } }
  );
  registerCmosPromptHandlers(server, skillRoot);
  const client = new Client({ name: 'prompt-supporting-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: () => client.close() };
}

describe('CMOS MCP prompts', () => {
  test('a supporting client discovers all four commands and gets the exact shared skill body', async () => {
    const { client, close } = await connect();
    try {
      expect(client.getServerCapabilities()?.prompts).toEqual({});
      const listed = await client.listPrompts();
      expect(listed.prompts.map((prompt) => prompt.name)).toEqual(
        COMMANDS.map((command) => `cmos-${command}`)
      );
      for (const command of COMMANDS) {
        const source = fs.readFileSync(path.join(SKILL_ROOT, command, 'SKILL.md'), 'utf8');
        const frontmatter = /^---\r?\n([\s\S]+?)\r?\n---\r?\n/.exec(source)!;
        const metadata = parseYaml(frontmatter[1]);
        const name = `cmos-${command}`;
        expect(listed.prompts.find((prompt) => prompt.name === name)).toEqual({
          name,
          description: metadata.description,
        });
        expect(await client.getPrompt({ name })).toEqual({
          description: metadata.description,
          messages: [
            {
              role: 'user',
              content: { type: 'text', text: source.slice(frontmatter[0].length).trim() },
            },
          ],
        });
      }
    } finally {
      await close();
    }
  });

  test('unknown names and unsupported arguments fail instead of silently selecting a workflow', async () => {
    const { client, close } = await connect();
    try {
      await expect(client.getPrompt({ name: '../../agents.md' })).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
        message: expect.stringContaining('cmos-start'),
      });
      await expect(
        client.getPrompt({ name: 'cmos-build', arguments: { mission: 'wrong' } })
      ).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
        message: expect.stringContaining('does not accept arguments'),
      });
      expect(await client.getPrompt({ name: 'cmos-start', arguments: {} })).toHaveProperty(
        'messages'
      );
    } finally {
      await close();
    }
  });

  test.each([
    ['missing source', null],
    ['missing frontmatter', '# Start\nRead the project.'],
    ['wrong skill', '---\nname: build\ndescription: Start the project.\n---\nRead the project.'],
    ['missing description', '---\nname: start\n---\nRead the project.'],
    ['empty body', '---\nname: start\ndescription: Start the project.\n---\n'],
    ['invalid metadata', '---\nname: [\n---\nRead the project.'],
  ])(
    'an incomplete installation surfaces %s with a repair instruction',
    async (_reason, source) => {
      const skillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-prompt-skills-'));
      if (source !== null) {
        fs.mkdirSync(path.join(skillRoot, 'start'));
        fs.writeFileSync(path.join(skillRoot, 'start/SKILL.md'), source);
      }
      const { client, close } = await connect(skillRoot);
      try {
        await expect(client.getPrompt({ name: 'cmos-start' })).rejects.toMatchObject({
          code: ProtocolErrorCode.InternalError,
          message: expect.stringContaining('Reinstall @aquex/cmos-mcp'),
        });
        await expect(client.listPrompts()).rejects.toMatchObject({
          code: ProtocolErrorCode.InternalError,
        });
      } finally {
        await close();
        fs.rmSync(skillRoot, { recursive: true, force: true });
      }
    }
  );
});
