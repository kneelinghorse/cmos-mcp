/**
 * Template Exporter Tests
 *
 * Tests the Strict YAML export functionality:
 * - Safe serialization (no language-specific tags)
 * - YAML and JSON output formats
 * - Comment preservation
 * - Path safety
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { TemplateExporter } from '../../src/import-export/template-exporter';
import { MissionTemplate } from '../../src/import-export/types';
import { ensureDir, pathExists, removeDir } from '../../src/utils/fs';

describe('TemplateExporter - Strict YAML Export', () => {
  const testDir = path.join(__dirname, 'test-exports');
  let exporter: TemplateExporter;

  beforeAll(async () => {
    await ensureDir(testDir);
  });

  beforeEach(async () => {
    if (await pathExists(testDir)) {
      await removeDir(testDir, { recursive: true, force: true });
    }
    await ensureDir(testDir);
    exporter = new TemplateExporter(testDir);
  });

  afterAll(async () => {
    if (await pathExists(testDir)) {
      await removeDir(testDir, { recursive: true, force: true });
    }
  });

  // Helper to create a valid template
  function createValidTemplate(): MissionTemplate {
    return {
      apiVersion: 'mission-template.v1',
      kind: 'MissionTemplate',
      metadata: {
        name: 'export-test',
        version: '1.0.0',
        author: 'test@example.com',
        signature: {
          keyId: 'test-key-123',
          algorithm: 'RS256',
          value: 'signature-value',
        },
      },
      spec: {
        description: 'Test template for export',
        phases: [
          {
            name: 'Phase 1',
            steps: [
              {
                action: 'test-action',
                parameters: { key: 'value' },
              },
            ],
          },
        ],
      },
    };
  }

  describe('YAML Export', () => {
    it('should export template to YAML format', async () => {
      const template = createValidTemplate();

      const success = await exporter.export(template, 'test-output.yaml');

      expect(success).toBe(true);
      expect(await pathExists(path.join(testDir, 'test-output.yaml'))).toBe(true);
    });

    it('should produce valid YAML that can be parsed', async () => {
      const template = createValidTemplate();

      await exporter.export(template, 'parseable.yaml');

      const content = await fs.readFile(path.join(testDir, 'parseable.yaml'), 'utf-8');
      const parsed = YAML.parse(content);

      expect(parsed.apiVersion).toBe('mission-template.v1');
      expect(parsed.metadata.name).toBe('export-test');
    });

    it('should include header comments by default', async () => {
      const template = createValidTemplate();

      await exporter.export(template, 'with-comments.yaml');

      const content = await fs.readFile(path.join(testDir, 'with-comments.yaml'), 'utf-8');

      expect(content).toContain('# Mission Template');
      expect(content).toContain('# Name: export-test');
      expect(content).toContain('Strict YAML format');
    });

    it('should exclude comments when requested', async () => {
      const template = createValidTemplate();

      await exporter.export(template, 'no-comments.yaml', { includeComments: false });

      const content = await fs.readFile(path.join(testDir, 'no-comments.yaml'), 'utf-8');

      expect(content).not.toContain('# Mission Template');
    });

    it('should not include language-specific tags', async () => {
      const template = createValidTemplate();

      await exporter.export(template, 'safe-yaml.yaml');

      const content = await fs.readFile(path.join(testDir, 'safe-yaml.yaml'), 'utf-8');

      // Check for dangerous YAML tags
      expect(content).not.toContain('!!python');
      expect(content).not.toContain('!!java');
      expect(content).not.toContain('!!ruby');
    });

    it('should support pretty printing', async () => {
      const template = createValidTemplate();

      await exporter.export(template, 'pretty.yaml', { pretty: true });

      const content = await fs.readFile(path.join(testDir, 'pretty.yaml'), 'utf-8');

      // Pretty YAML should have indentation
      expect(content).toContain('  '); // Check for indentation
    });
  });

  describe('JSON Export', () => {
    it('should export template to JSON format', async () => {
      const template = createValidTemplate();

      const success = await exporter.export(template, 'test-output.json', {
        format: 'json',
      });

      expect(success).toBe(true);
      expect(await pathExists(path.join(testDir, 'test-output.json'))).toBe(true);
    });

    it('should produce valid JSON that can be parsed', async () => {
      const template = createValidTemplate();

      await exporter.export(template, 'parseable.json', { format: 'json' });

      const content = await fs.readFile(path.join(testDir, 'parseable.json'), 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.apiVersion).toBe('mission-template.v1');
      expect(parsed.metadata.name).toBe('export-test');
    });

    it('should support pretty printing for JSON', async () => {
      const template = createValidTemplate();

      await exporter.export(template, 'pretty.json', { format: 'json', pretty: true });

      const content = await fs.readFile(path.join(testDir, 'pretty.json'), 'utf-8');

      // Pretty JSON should have newlines and indentation
      expect(content).toContain('\n');
      expect(content).toContain('  ');
    });

    it('should support compact JSON output', async () => {
      const template = createValidTemplate();

      await exporter.export(template, 'compact.json', { format: 'json', pretty: false });

      const content = await fs.readFile(path.join(testDir, 'compact.json'), 'utf-8');

      // Compact JSON should not have pretty formatting
      expect(content.split('\n').length).toBeLessThan(5);
    });
  });

  describe('Validation & Utilities', () => {
    it('rejects output paths that escape the base directory', async () => {
      const template = createValidTemplate();

      await expect(exporter.export(template, '../evil.yaml')).rejects.toThrow(
        'Output path escapes base directory'
      );
    });

    it('rejects templates with invalid apiVersion', async () => {
      const template = {
        ...createValidTemplate(),
        apiVersion: 'mission-template.v2',
      };

      await expect(exporter.export(template, 'invalid-api.yaml')).rejects.toThrow(
        'Invalid apiVersion'
      );
    });

    it('rejects templates with invalid kind', async () => {
      const template = {
        ...createValidTemplate(),
        kind: 'NotMissionTemplate',
      };

      await expect(exporter.export(template, 'invalid-kind.yaml')).rejects.toThrow('Invalid kind');
    });

    it('rejects templates missing metadata', async () => {
      const template = createValidTemplate();
      // @ts-ignore intentional invalid state
      delete template.metadata;

      await expect(exporter.export(template, 'missing-metadata.yaml')).rejects.toThrow(
        'Missing required metadata'
      );
    });

    it('rejects templates missing spec', async () => {
      const template = createValidTemplate();
      // @ts-ignore intentional invalid state
      delete template.spec;

      await expect(exporter.export(template, 'missing-spec.yaml')).rejects.toThrow(
        'Missing required spec'
      );
    });

    it('counts successful exports when exporting multiple templates', async () => {
      const validTemplate = createValidTemplate();
      const invalidTemplate = {
        ...createValidTemplate(),
        metadata: {
          ...createValidTemplate().metadata,
          name: 'invalid-template',
        },
        // Remove spec to trigger validation failure
        spec: undefined as any,
      };

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const count = await exporter.exportMultiple([validTemplate, invalidTemplate], 'bulk', {
        format: 'yaml',
      });

      expect(count).toBe(1);
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });
  });

  describe('Export to String', () => {
    it('should export to string without file I/O', async () => {
      const template = createValidTemplate();

      const yamlString = exporter.exportToString(template);

      expect(yamlString).toContain('apiVersion');
      expect(yamlString).toContain('mission-template.v1');
      expect(yamlString).toContain('export-test');
    });

    it('should export to JSON string', async () => {
      const template = createValidTemplate();

      const jsonString = exporter.exportToString(template, { format: 'json' });

      const parsed = JSON.parse(jsonString);
      expect(parsed.apiVersion).toBe('mission-template.v1');
    });
  });

  describe('Validation', () => {
    it('should reject templates with invalid apiVersion', async () => {
      const template = createValidTemplate();
      template.apiVersion = 'wrong-version';

      await expect(exporter.export(template, 'invalid.yaml')).rejects.toThrow(/apiVersion/i);
    });

    it('should reject templates with invalid kind', async () => {
      const template = createValidTemplate();
      template.kind = 'WrongKind';

      await expect(exporter.export(template, 'invalid.yaml')).rejects.toThrow(/kind/i);
    });

    it('should reject templates without metadata', async () => {
      const template = createValidTemplate();
      (template as any).metadata = undefined;

      await expect(exporter.export(template, 'invalid.yaml')).rejects.toThrow(/metadata/i);
    });

    it('should reject templates without spec', async () => {
      const template = createValidTemplate();
      (template as any).spec = undefined;

      await expect(exporter.export(template, 'invalid.yaml')).rejects.toThrow(/spec/i);
    });
  });

  describe('Path Safety', () => {
    it('should reject path traversal attempts', async () => {
      const template = createValidTemplate();

      await expect(exporter.export(template, '../../../etc/passwd')).rejects.toThrow(/path/i);
    });

    it('should create nested directories as needed', async () => {
      const template = createValidTemplate();

      const success = await exporter.export(template, 'nested/dir/template.yaml');

      expect(success).toBe(true);
      expect(await pathExists(path.join(testDir, 'nested/dir/template.yaml'))).toBe(true);
    });
  });

  describe('Export Multiple Templates', () => {
    it('should export multiple templates to directory', async () => {
      const template1 = createValidTemplate();
      const template2 = createValidTemplate();
      template2.metadata = { ...template2.metadata, name: 'template-2', version: '2.0.0' };

      const templates = [template1, template2];

      const count = await exporter.exportMultiple(templates, 'multi-export');

      expect(count).toBe(2);
      expect(await pathExists(path.join(testDir, 'multi-export'))).toBe(true);
    });

    it('should continue on errors and return success count', async () => {
      const templates = [
        createValidTemplate(),
        { ...createValidTemplate(), apiVersion: 'invalid' } as MissionTemplate, // Invalid
        createValidTemplate(),
      ];
      templates[2].metadata.name = 'template-3';

      const count = await exporter.exportMultiple(templates, 'partial-export');

      // Should export 2 out of 3 (skipping the invalid one)
      expect(count).toBe(2);
    });
  });

  describe('Round-trip Compatibility', () => {
    it('should produce output that can be re-imported', async () => {
      const template = createValidTemplate();
      template.dependencies = [
        {
          name: 'dep',
          sourceUrl: 'https://example.com/dep.yaml',
          version: '1.0.0',
          checksum: 'sha256:' + 'a'.repeat(64),
        },
      ];

      // Export
      await exporter.export(template, 'roundtrip.yaml');

      // Read back
      const content = await fs.readFile(path.join(testDir, 'roundtrip.yaml'), 'utf-8');
      const parsed = YAML.parse(content);

      // Verify structure is preserved
      expect(parsed.apiVersion).toBe(template.apiVersion);
      expect(parsed.metadata.name).toBe(template.metadata.name);
      expect(parsed.dependencies).toHaveLength(1);
      expect(parsed.dependencies[0].checksum).toBe(template.dependencies[0].checksum);
    });

    it('should preserve complex nested structures', async () => {
      const template = createValidTemplate();
      template.spec.complexData = {
        nested: {
          array: [1, 2, 3],
          object: { key: 'value' },
        },
      };

      const yamlString = exporter.exportToString(template);
      const parsed = YAML.parse(yamlString);

      expect(parsed.spec.complexData.nested.array).toEqual([1, 2, 3]);
      expect(parsed.spec.complexData.nested.object.key).toBe('value');
    });
  });
});
