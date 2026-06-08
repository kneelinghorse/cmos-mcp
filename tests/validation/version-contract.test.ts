import { promises as fs } from 'fs';
import path from 'path';
import YAML from 'yaml';
import { createTemplateFromMission } from '../../src/tools/export-template';

interface RegistryEntry {
  readonly name: string;
  readonly version: string;
  readonly path: string;
  readonly schema_version: string;
}

interface RegistryFile {
  readonly domains: RegistryEntry[];
}

interface PackManifest {
  readonly version?: string | number;
}

async function readYamlFile<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, 'utf8');
  return YAML.parse(content) as T;
}

describe('Versioning contract', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const templatesDir = path.join(repoRoot, 'templates');

  it('keeps registry and manifest versions aligned', async () => {
    const registryPath = path.join(templatesDir, 'registry.yaml');
    const registry = await readYamlFile<RegistryFile>(registryPath);

    for (const entry of registry.domains) {
      const manifestPath = path.join(templatesDir, entry.path, 'pack.yaml');
      const manifest = await readYamlFile<PackManifest>(manifestPath);
      const manifestVersion = manifest.version ? String(manifest.version).trim() : '';

      expect(manifestVersion).toBeTruthy();
      expect(entry.version.trim()).toBe(manifestVersion);
      expect(entry.schema_version.trim()).toBe(manifestVersion);
    }
  });

  it('uses documented mission template API versions', async () => {
    const template = createTemplateFromMission(
      {
        objective: 'Ensure mission template API version stays aligned',
        context: 'Versioning contract validation',
      },
      {
        name: 'version-contract-smoke',
        version: '1.0.0',
        author: 'versioning-test-suite',
        signature: {
          keyId: 'internal-key',
          algorithm: 'PGP-SHA256',
          value: 'ZmFrZS1zaWduYXR1cmU=',
        },
      }
    );

    expect(template.apiVersion).toBe('mission-template.v1');

    const hybridSamplePath = path.join(templatesDir, 'hybrid', 'sample-mission.xml');
    const hybridSample = await fs.readFile(hybridSamplePath, 'utf8');
    const apiVersionMatch = hybridSample.match(/apiVersion="([^"]+)"/);

    expect(apiVersionMatch?.[1]).toBe('mission-template.v2');
  });
});
