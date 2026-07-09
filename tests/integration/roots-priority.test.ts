// ABOUTME: Integration coverage for Sprint 53 sender-resolution precedence.
// ABOUTME: Verifies MCP roots beat registry fallback, and explicit projectRoot beats MCP roots.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { resolveSenderContext } from '../../src/intelligence/sender-context';
import { createSeededCmosProject, type SeededCmosProject } from '../helpers/seedCmosDb';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('sender-context precedence', () => {
  const cleanupDirs: string[] = [];

  async function trackDir(prefix: string): Promise<string> {
    const dir = await makeTempDir(prefix);
    cleanupDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
  });

  afterEach(async () => {
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    for (const dir of cleanupDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => void 0);
    }
  });

  it('prefers advertised MCP roots over the registry singleton', async () => {
    const rootsProject = await createSeededCmosProject(
      {
        projectName: 'Stage1',
        projectId: 'stage1',
        slug: 'stage1',
        dashboardProjectId: 'ddb34d24-30e3-4eb3-b13c-20b106a75970',
        cmosAddress: 'cmos://derek/stage1',
      },
      'roots-priority-stage1-'
    );
    const registryProject = await createSeededCmosProject(
      {
        projectName: 'CMOS MCP',
        projectId: 'cmos-mcp',
        slug: 'cmos-mcp',
        dashboardProjectId: 'ec2b4987-dbc1-4f16-946e-9843c4080ac1',
        cmosAddress: 'cmos://derek/cmos-mcp',
      },
      'roots-priority-cmos-mcp-'
    );
    cleanupDirs.push(rootsProject.projectRoot, registryProject.projectRoot);

    const configDir = await trackDir('roots-priority-cfg-');
    const emptyCwd = await trackDir('roots-priority-empty-');
    const registry = await ProjectGraphRegistry.create({ configDir });
    registry.registerStore(registryProject.projectRoot, { setAsDefault: true });

    const result = await resolveSenderContext({
      mcpRoots: [rootsProject.projectRoot],
      cwdOverride: emptyCwd,
      registryOverride: registry,
      serverInstallRootOverride: '/mock/server-install',
      requireSenderIdentity: true,
    });

    expect(result.source).toBe('mcp-roots');
    expect(result.projectRoot).toBe(path.resolve(rootsProject.projectRoot));
    expect(result.dashboardProjectId).toBe('ddb34d24-30e3-4eb3-b13c-20b106a75970');
  });

  it('prefers explicit projectRoot over advertised MCP roots', async () => {
    const explicitProject = await createSeededCmosProject(
      {
        projectName: 'OODS Foundry',
        projectId: 'oods-foundry',
        slug: 'oods-foundry',
        dashboardProjectId: '11111111-2222-4333-8444-555555555555',
        cmosAddress: 'cmos://derek/oods-foundry',
      },
      'roots-priority-explicit-'
    );
    const rootsProject = await createSeededCmosProject(
      {
        projectName: 'Stage1',
        projectId: 'stage1',
        slug: 'stage1',
        dashboardProjectId: 'ddb34d24-30e3-4eb3-b13c-20b106a75970',
        cmosAddress: 'cmos://derek/stage1',
      },
      'roots-priority-roots-'
    );
    cleanupDirs.push(explicitProject.projectRoot, rootsProject.projectRoot);

    const configDir = await trackDir('roots-priority-cfg-');
    const registry = await ProjectGraphRegistry.create({ configDir });

    const result = await resolveSenderContext({
      explicitProjectRoot: explicitProject.projectRoot,
      mcpRoots: [rootsProject.projectRoot],
      cwdOverride: await trackDir('roots-priority-empty-'),
      registryOverride: registry,
      serverInstallRootOverride: '/mock/server-install',
      requireSenderIdentity: true,
    });

    expect(result.source).toBe('explicit');
    expect(result.projectRoot).toBe(path.resolve(explicitProject.projectRoot));
    expect(result.dashboardProjectId).toBe('11111111-2222-4333-8444-555555555555');
  });
});
