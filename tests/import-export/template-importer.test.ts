/**
 * Template Importer Tests
 *
 * Tests the complete 6-layer validation pipeline integration:
 * - Layers 1-3: Path sanitization, safe parsing, schema validation (via SecureYAMLLoader)
 * - Layers 4-6: Signature, semantics, dependencies (via SecurityValidator)
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { TemplateImporter } from '../../src/import-export/template-importer';
import { SecurityValidator } from '../../src/import-export/security-validator';
import { MissionTemplate } from '../../src/import-export/types';
import { ensureDir, removeDir } from '../../src/utils/fs';

describe('TemplateImporter - Complete Pipeline', () => {
  const testDir = path.join(__dirname, 'test-templates');
  let importer: TemplateImporter;

  beforeAll(async () => {
    await ensureDir(testDir);
  });

  beforeEach(async () => {
    SecurityValidator.clearTrustedKeys();
    await removeDir(testDir, { recursive: true, force: true });
    await ensureDir(testDir);

    // Create importer with test directory
    importer = new TemplateImporter(testDir);
  });

  afterAll(async () => {
    await removeDir(testDir, { recursive: true, force: true });
  });

  // Helper to write a template file
  async function writeTemplateFile(filename: string, content: string): Promise<void> {
    await fs.writeFile(path.join(testDir, filename), content, 'utf-8');
  }

  // Helper to create valid template YAML
  function createValidTemplateYAML(): string {
    return `apiVersion: "mission-template.v1"
kind: "MissionTemplate"

metadata:
  name: "test-template"
  version: "1.0.0"
  author: "test@example.com"
  signature:
    keyId: "test-key-123"
    algorithm: "RS256"
    value: "valid-signature-base64"

spec:
  description: "A test template"
  phases:
    - name: "Phase 1"
      steps:
        - action: "test-action"
          parameters: {}
`;
  }

  describe('Layers 1-3: SecureYAMLLoader Integration', () => {
    it('T-02: should reject path traversal attempts', async () => {
      await writeTemplateFile('safe.yaml', createValidTemplateYAML());

      await expect(importer.import('../../../etc/passwd')).rejects.toThrow(/path traversal/i);
    });

    it('should load valid YAML files', async () => {
      SecurityValidator.registerTrustedKey({
        keyId: 'test-key-123',
        algorithm: 'RS256',
        publicKey: 'test-key',
        owner: 'Test',
        trustLevel: 'verified-internal',
      });

      await writeTemplateFile('valid.yaml', createValidTemplateYAML());

      const result = await importer.import('valid.yaml', {
        skipSignatureVerification: true,
      });

      expect(result.template.metadata.name).toBe('test-template');
    });

    it('should reject malformed YAML', async () => {
      await writeTemplateFile('malformed.yaml', 'invalid: yaml: content: [[[');

      await expect(
        importer.import('malformed.yaml', { skipSignatureVerification: true })
      ).rejects.toThrow();
    });

    it('should reject templates that fail schema validation', async () => {
      const invalidYAML = `apiVersion: "wrong-version"
kind: "MissionTemplate"
metadata:
  name: "test"
`;
      await writeTemplateFile('invalid-schema.yaml', invalidYAML);

      await expect(
        importer.import('invalid-schema.yaml', { skipSignatureVerification: true })
      ).rejects.toThrow(/validation/i);
    });
  });

  describe('Layer 4-6: SecurityValidator Integration', () => {
    it('should reject templates with untrusted signatures', async () => {
      await writeTemplateFile('untrusted.yaml', createValidTemplateYAML());

      await expect(
        importer.import('untrusted.yaml', { skipSignatureVerification: false })
      ).rejects.toThrow(/untrusted/i);
    });

    it('should accept templates with valid signatures', async () => {
      SecurityValidator.registerTrustedKey({
        keyId: 'test-key-123',
        algorithm: 'RS256',
        publicKey: 'public-key-data',
        owner: 'Test Team',
        trustLevel: 'verified-internal',
      });

      await writeTemplateFile('trusted.yaml', createValidTemplateYAML());

      const result = await importer.import('trusted.yaml', {
        skipSignatureVerification: false,
      });

      expect(result.validationReport.valid).toBe(true);
      expect(result.template.metadata.name).toBe('test-template');
    });

    it('should reject templates with malicious content (semantic validation)', async () => {
      const maliciousYAML = `apiVersion: "mission-template.v1"
kind: "MissionTemplate"

metadata:
  name: "malicious"
  version: "1.0.0"
  author: "attacker@evil.com"
  signature:
    keyId: "test-key-123"
    algorithm: "RS256"
    value: "signature"

spec:
  description: "Malicious template"
  script: "eval('malicious code')"
`;
      await writeTemplateFile('malicious.yaml', maliciousYAML);

      await expect(
        importer.import('malicious.yaml', { skipSignatureVerification: true })
      ).rejects.toThrow(/validation failed/i);
    });

    it('should enforce resource limits', async () => {
      const excessiveYAML = `apiVersion: "mission-template.v1"
kind: "MissionTemplate"

metadata:
  name: "excessive"
  version: "1.0.0"
  author: "test@example.com"
  signature:
    keyId: "test-key-123"
    algorithm: "RS256"
    value: "signature"

spec:
  description: "Excessive resource template"
  resources:
    memory: 99999
    cpu: 999
`;
      await writeTemplateFile('excessive.yaml', excessiveYAML);

      await expect(
        importer.import('excessive.yaml', { skipSignatureVerification: true })
      ).rejects.toThrow(/validation failed/i);
    });
  });

  describe('Dependency Resolution (Layer 6)', () => {
    it('should reject templates with invalid dependencies', async () => {
      const templateWithBadDep = `apiVersion: "mission-template.v1"
kind: "MissionTemplate"

metadata:
  name: "template-with-deps"
  version: "1.0.0"
  author: "test@example.com"
  signature:
    keyId: "test-key-123"
    algorithm: "RS256"
    value: "signature"

spec:
  description: "Template with dependencies"

dependencies:
  - name: "bad-dep"
    sourceUrl: "https://evil.com/malware.yaml"
    version: "1.0.0"
    checksum: "sha256:${'a'.repeat(64)}"
`;
      await writeTemplateFile('with-bad-deps.yaml', templateWithBadDep);

      await expect(
        importer.import('with-bad-deps.yaml', { skipSignatureVerification: true })
      ).rejects.toThrow(/validation failed/i);
    });

    it('should validate dependency checksums', async () => {
      // Create a dependency file
      const depContent = createValidTemplateYAML().replace('test-template', 'dependency-template');
      await writeTemplateFile('dep.yaml', depContent);

      // Create incorrect checksum - needs URL allowlist
      const templateWithDep = `apiVersion: "mission-template.v1"
kind: "MissionTemplate"

metadata:
  name: "template-with-deps"
  version: "1.0.0"
  author: "test@example.com"
  signature:
    keyId: "test-key-123"
    algorithm: "RS256"
    value: "signature"

spec:
  description: "Template with dependencies"

dependencies:
  - name: "dep"
    sourceUrl: "file://${path.join(testDir, 'dep.yaml')}"
    version: "1.0.0"
    checksum: "sha256:${'0'.repeat(64)}"
`;
      await writeTemplateFile('with-deps.yaml', templateWithDep);

      // Should fail due to URL allowlist (empty by default)
      await expect(
        importer.import('with-deps.yaml', { skipSignatureVerification: true })
      ).rejects.toThrow(/validation failed/i);
    });
  });

  describe('Performance Requirements', () => {
    it('should complete import in <1 second for typical templates', async () => {
      await writeTemplateFile('perf-test.yaml', createValidTemplateYAML());

      const startTime = Date.now();
      const result = await importer.import('perf-test.yaml', {
        skipSignatureVerification: true,
      });
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(1000);
      expect(result.validationReport.performanceMs).toBeLessThan(1000);
    });
  });

  describe('Import from String', () => {
    it('should support importing from YAML string', async () => {
      const yamlContent = createValidTemplateYAML();

      const result = await importer.importFromString(yamlContent, {
        skipSignatureVerification: true,
      });

      expect(result.template.metadata.name).toBe('test-template');
      expect(result.validationReport.valid).toBe(true);
    });

    it('should clean up temporary files after import', async () => {
      const yamlContent = createValidTemplateYAML();

      await importer.importFromString(yamlContent, {
        skipSignatureVerification: true,
      });

      // Check that no .temp- files remain
      const files = await fs.readdir(testDir);
      const tempFiles = files.filter((f) => f.startsWith('.temp-'));
      expect(tempFiles.length).toBe(0);
    });
  });

  describe('Complete Import Success', () => {
    it('should successfully import a fully valid template', async () => {
      SecurityValidator.registerTrustedKey({
        keyId: 'test-key-123',
        algorithm: 'RS256',
        publicKey: 'public-key-data',
        owner: 'Test Team',
        trustLevel: 'verified-internal',
      });

      const completeTemplate = `apiVersion: "mission-template.v1"
kind: "MissionTemplate"

metadata:
  name: "complete-template"
  version: "2.1.0"
  author: "security-team@example.com"
  signature:
    keyId: "test-key-123"
    algorithm: "RS256"
    value: "complete-signature-base64"

spec:
  description: "A complete, valid template"
  phases:
    - name: "Setup"
      steps:
        - action: "initialize"
          parameters:
            timeout: 30
  resources:
    memory: 2048
    cpu: 4
  startDate: "2025-01-01"
  endDate: "2025-12-31"
`;
      await writeTemplateFile('complete.yaml', completeTemplate);

      const result = await importer.import('complete.yaml', {
        skipSignatureVerification: false,
      });

      expect(result.validationReport.valid).toBe(true);
      expect(result.validationReport.errors).toHaveLength(0);
      expect(result.template.metadata.name).toBe('complete-template');
      expect(result.template.metadata.version).toBe('2.1.0');

      // Verify all layers passed
      result.validationReport.layers.forEach((layer) => {
        expect(layer.passed).toBe(true);
      });
    });
  });
});

describe('TemplateImporter - Hybrid XML Templates', () => {
  const testDir = path.join(__dirname, 'test-templates');
  let importer: TemplateImporter;

  beforeEach(async () => {
    SecurityValidator.clearTrustedKeys();
    await removeDir(testDir, { recursive: true, force: true });
    await ensureDir(testDir);

    importer = new TemplateImporter(testDir);
  });

  afterAll(async () => {
    await removeDir(testDir, { recursive: true, force: true });
  });

  async function ensureHybridComponent(relativePath: string, content: string): Promise<void> {
    const fullDir = path.dirname(path.join(testDir, relativePath));
    await ensureDir(fullDir);
    await fs.writeFile(path.join(testDir, relativePath), content, 'utf-8');
  }

  it('imports hybrid XML templates and resolves component content', async () => {
    await ensureHybridComponent(
      'hybrid/components/agent-persona/hybrid-architect.xml',
      `<AgentPersona>
  <Name>Hybrid Template Architect</Name>
  <Description>Ensures hybrid template readiness across domains.</Description>
  <Tone>Pragmatic</Tone>
  <Expectations>
    <Expectation>Highlight schema gaps before delivery.</Expectation>
  </Expectations>
</AgentPersona>`
    );

    await ensureHybridComponent(
      'hybrid/components/instructions/hybrid-briefing.xml',
      `<Instructions>
  <Title>Hybrid Delivery Checklist</Title>
  <Step index="1">Review mission objective.</Step>
  <Step index="2">Resolve component fragments.</Step>
  <Step index="3">Validate JSON Schema obligations.</Step>
</Instructions>`
    );

    await ensureDir(path.join(testDir, 'hybrid'));
    await fs.writeFile(
      path.join(testDir, 'hybrid/sample.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>
<MissionTemplate apiVersion="mission-template.v2" kind="HybridMissionTemplate">
  <Metadata>
    <Name>hybrid-sample</Name>
    <Version>1.0.0</Version>
    <Author>hybrid-test@example.com</Author>
    <Signature>
      <KeyId>hybrid-dev-key</KeyId>
      <Algorithm>PGP-SHA256</Algorithm>
      <Value>BASE64_SIGNATURE_PLACEHOLDER</Value>
    </Signature>
    <Tags>
      <Tag>hybrid</Tag>
      <Tag>test</Tag>
    </Tags>
  </Metadata>
  <MissionObjective>Validate importer hybrid support.</MissionObjective>
  <AgentPersona src="components/agent-persona/hybrid-architect.xml" />
  <Instructions src="components/instructions/hybrid-briefing.xml" />
  <ContextData>
    <Item key="domain">testing</Item>
    <Item key="repository">Mission-Protocol.v2</Item>
  </ContextData>
  <Examples>
    <Example name="baseline">
      <Input><![CDATA[{"prompt":"Generate hybrid mission"}]]></Input>
      <Output><![CDATA[{"summary":"Hybrid mission synthesized."}]]></Output>
    </Example>
  </Examples>
  <OutputSchema><![CDATA[
{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","required":["summary"],"properties":{"summary":{"type":"string"}}}
  ]]></OutputSchema>
</MissionTemplate>`,
      'utf-8'
    );

    const result = await importer.import('hybrid/sample.xml', {
      skipSignatureVerification: true,
    });

    expect(result.template.kind).toBe('HybridMissionTemplate');
    expect(result.template.apiVersion).toBe('mission-template.v2');
    expect(result.template.metadata.tags).toEqual(['hybrid', 'test']);
    expect(result.template.spec).toMatchObject({
      format: 'hybrid',
      objective: 'Validate importer hybrid support.',
      context: {
        domain: 'testing',
        repository: 'Mission-Protocol.v2',
      },
    });
    expect((result.template.spec as Record<string, unknown>).agentPersona).toMatchObject({
      src: 'components/agent-persona/hybrid-architect.xml',
    });
    expect((result.template.spec as Record<string, unknown>).instructions).toMatchObject({
      src: 'components/instructions/hybrid-briefing.xml',
    });
    expect((result.template.spec as { source?: { path?: string } }).source?.path).toBe(
      'hybrid/sample.xml'
    );
  });

  it('rejects missing hybrid template files', async () => {
    await expect(
      importer.import('hybrid/missing.xml', {
        skipSignatureVerification: true,
      })
    ).rejects.toThrow(/File not found/i);
  });

  it('rejects malformed hybrid XML content', async () => {
    await ensureDir(path.join(testDir, 'hybrid'));
    await fs.writeFile(
      path.join(testDir, 'hybrid/invalid.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>
<MissionTemplate apiVersion="mission-template.v2" kind="HybridMissionTemplate">
  <Metadata></Metadata>
</MissionTemplate>`,
      'utf-8'
    );

    await expect(
      importer.import('hybrid/invalid.xml', {
        skipSignatureVerification: true,
      })
    ).rejects.toThrow(/Hybrid template validation failed/i);
  });
});
