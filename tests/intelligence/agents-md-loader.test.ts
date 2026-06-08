import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { AgentsMdLoader } from '../../src/intelligence/agents-md-loader';

function createSampleAgentsMd(version = '1.0.0'): string {
  return `# Mission Protocol – Agent Guidance

## Project Overview
Mission Protocol v2 aligns MCP tooling with CMOS memory architecture.

## Build & Development Commands
\`\`\`bash
npm install
npm run build
npm test
\`\`\`

## AI Agent Specific Instructions
- Follow CMOS workspace guardrails.
- Keep missions append-only.

---

**Last Updated**: 2025-11-03
**Version**: ${version}
**Maintained by**: Mission Protocol Team
`;
}

describe('AgentsMdLoader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agents-md-loader-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('returns warning when agents.md is absent', async () => {
    const loader = new AgentsMdLoader();
    const result = await loader.load(tempDir);

    expect(result.loaded).toBe(false);
    expect(result.reason).toBe('not_found');
    expect(result.contextPatch.working_memory.agents_md_loaded).toBe(false);
    expect(result.contextPatch.working_memory.agents_md_path).toBe('./agents.md');
    expect(result.validations.some((validation) => validation.code === 'AGENTS_MD_NOT_FOUND')).toBe(
      true
    );
  });

  test('loads sections, version, and context patch when agents.md exists', async () => {
    await fs.writeFile(path.join(tempDir, 'agents.md'), createSampleAgentsMd('1.2.3'));

    const loader = new AgentsMdLoader();
    const result = await loader.load(tempDir);

    expect(result.loaded).toBe(true);
    expect(result.source).toBe('fallback');
    expect(result.sections?.['Project Overview']).toContain('Mission Protocol v2');
    expect(result.sections?.['Build & Development Commands']).toContain('npm run build');
    expect(result.version).toBe('1.2.3');
    expect(result.contextPatch.working_memory).toEqual({
      agents_md_path: './agents.md',
      agents_md_loaded: true,
      agents_md_version: '1.2.3',
    });
  });

  test('falls back to default path when configured path is missing', async () => {
    await fs.writeFile(path.join(tempDir, 'agents.md'), createSampleAgentsMd('1.0.1'));

    const loader = new AgentsMdLoader();
    const result = await loader.load(tempDir, {
      working_memory: {
        agents_md_path: 'config/agents.md',
      },
    });

    expect(result.loaded).toBe(true);
    expect(result.source).toBe('fallback');
    expect(result.validations.some((validation) => validation.code === 'AGENTS_MD_NOT_FOUND')).toBe(
      true
    );
    expect(result.contextPatch.working_memory.agents_md_loaded).toBe(true);
  });

  test('forceRefresh bypasses cache and picks up new versions', async () => {
    const agentsPath = path.join(tempDir, 'agents.md');
    await fs.writeFile(agentsPath, createSampleAgentsMd('1.0.0'));

    const loader = new AgentsMdLoader({ cacheTtlMs: 60_000 });

    const initial = await loader.load(tempDir);
    expect(initial.version).toBe('1.0.0');

    await fs.writeFile(agentsPath, createSampleAgentsMd('2.0.0'));

    const cached = await loader.load(tempDir);
    expect(cached.version).toBe('1.0.0');

    const refreshed = await loader.load(tempDir, undefined, { forceRefresh: true });
    expect(refreshed.version).toBe('2.0.0');
  });
});
