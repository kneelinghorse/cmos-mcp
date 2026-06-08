import { promises as fs } from 'fs';
import path from 'path';
import { TemplateImporter } from '../../src/import-export/template-importer';
import { SecurityValidator } from '../../src/import-export/security-validator';
import { parseHybridTemplate } from '../../src/import-export/hybrid-template-parser';
import { migrateTemplate } from '../../scripts/migrate-yaml-to-hybrid';
import { ensureDir, removeDir } from '../../src/utils/fs';

describe('Hybrid template migration', () => {
  const sandbox = path.join(__dirname, 'hybrid-migration-sandbox');
  const componentsSource = path.resolve(__dirname, '../../templates/hybrid/components');

  beforeAll(async () => {
    await ensureDir(sandbox);
  });

  afterAll(async () => {
    await removeDir(sandbox, { recursive: true, force: true });
  });

  beforeEach(async () => {
    SecurityValidator.clearTrustedKeys();
    await removeDir(sandbox, { recursive: true, force: true });
    await ensureDir(sandbox);
  });

  it('migrates legacy YAML to hybrid XML and imports through TemplateImporter', async () => {
    await fs.cp(componentsSource, path.join(sandbox, 'components'), {
      recursive: true,
    });

    const legacyPath = path.join(sandbox, 'legacy.yaml');
    const hybridPath = path.join(sandbox, 'legacy.xml');

    const legacyYaml = `schemaType: Build.Implementation
schemaVersion: "1.2.0"
missionId: legacy-build-01
objective: Build hybrid importer coverage
context:
  domain: engineering
  repository: mission-protocol
  owner:
    name: Lead Engineer
    email: lead.engineer@example.com
successCriteria:
  - Hybrid importer validates schema
deliverables:
  - Hybrid XML template
`;

    await fs.writeFile(legacyPath, legacyYaml, 'utf-8');

    await migrateTemplate(legacyPath, hybridPath);

    const hybridXml = await fs.readFile(hybridPath, 'utf-8');
    const parsed = parseHybridTemplate(hybridXml);
    expect(parsed.valid).toBe(true);

    const importer = new TemplateImporter(sandbox);
    const result = await importer.import('legacy.xml', {
      skipSignatureVerification: true,
    });

    expect(result.template.kind).toBe('HybridMissionTemplate');
    expect(result.template.apiVersion).toBe('mission-template.v2');
    expect(result.template.spec).toMatchObject({
      format: 'hybrid',
      objective: 'Build hybrid importer coverage',
    });

    const spec = result.template.spec as {
      context?: Record<string, string>;
      outputSchema?: Record<string, unknown>;
    };
    expect(spec.context).toBeDefined();
    expect(spec.context?.domain).toBe('engineering');
    expect(spec.context?.legacySource).toContain('legacy.yaml');

    const outputSchema = spec.outputSchema as {
      title?: string;
      properties?: Record<string, { default?: unknown }>;
    };
    expect(outputSchema?.title).toBe('MigratedMissionResult');
    expect(outputSchema?.properties?.deliverables?.default).toContain('Hybrid XML template');
  });
});
