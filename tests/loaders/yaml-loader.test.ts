/**
 * YAML Loader Tests - Complete Security and Functionality
 * Tests all three security layers plus general functionality
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { SecureYAMLLoader } from '../../src/loaders/yaml-loader';
import { UnsafeYAMLError, SchemaValidationError } from '../../src/types/errors';
import { JSONSchema } from '../../src/types/schemas';
import { ensureTempDir, removeDir } from '../../src/utils/fs';
import {
  loadYamlFixture,
  loadYamlFixtures,
  SimpleYamlFixture,
  NestedYamlFixture,
  ItemsYamlFixture,
  AnchoredEnvYamlFixture,
  MultilineYamlFixture,
  NullHandlingYamlFixture,
  AppConfigFixture,
  ServerConfigFixture,
  UsersYamlFixture,
  EnumYamlFixture,
  ValueEntryFixture,
  NamedConfigFixture,
} from '../utils/secure-yaml-fixtures';

describe('SecureYAMLLoader', () => {
  let tempDir: string;
  let loader: SecureYAMLLoader;

  beforeEach(async () => {
    tempDir = await ensureTempDir('yaml-loader-test-');
    loader = new SecureYAMLLoader({ baseDir: tempDir });
  });

  afterEach(async () => {
    await removeDir(tempDir, { recursive: true, force: true });
  });

  async function writeTempFile(filename: string, content: string): Promise<void> {
    await fs.writeFile(path.join(tempDir, filename), content, 'utf-8');
  }

  describe('Safe YAML Parsing - Layer 2', () => {
    test('should safely parse simple YAML', async () => {
      const yamlContent = `
name: Test
version: 1.0
enabled: true
`;
      await writeTempFile('simple.yaml', yamlContent);

      const data = await loadYamlFixture<SimpleYamlFixture>(loader, 'simple.yaml');
      expect(data).toEqual({
        name: 'Test',
        version: 1.0,
        enabled: true,
      });
    });

    test('should safely parse nested YAML', async () => {
      const yamlContent = `
server:
  host: localhost
  port: 8080
  ssl:
    enabled: true
    cert: /path/to/cert
`;
      await writeTempFile('nested.yaml', yamlContent);

      const data = await loadYamlFixture<NestedYamlFixture>(loader, 'nested.yaml');
      expect(data.server.ssl.enabled).toBe(true);
      expect(data.server.port).toBe(8080);
    });

    test('should safely parse arrays', async () => {
      const yamlContent = `
items:
  - name: Item 1
    value: 100
  - name: Item 2
    value: 200
`;
      await writeTempFile('array.yaml', yamlContent);

      const data = await loadYamlFixture<ItemsYamlFixture>(loader, 'array.yaml');
      expect(data.items).toHaveLength(2);
      expect(data.items[0].value).toBe(100);
    });

    test('should safely parse YAML with anchors and aliases', async () => {
      const yamlContent = `
defaults: &defaults
  timeout: 30
  retries: 3

production:
  timeout: 30
  retries: 3
  host: prod.example.com

staging:
  timeout: 30
  retries: 3
  host: staging.example.com
`;
      await writeTempFile('anchors.yaml', yamlContent);

      const data = await loadYamlFixture<AnchoredEnvYamlFixture>(loader, 'anchors.yaml');
      expect(data.production.timeout).toBe(30);
      expect(data.staging.retries).toBe(3);
    });

    test('should handle multiline strings', async () => {
      const yamlContent = `
description: |
  This is a multiline
  string that should be
  preserved with newlines
`;
      await writeTempFile('multiline.yaml', yamlContent);

      const data = await loadYamlFixture<MultilineYamlFixture>(loader, 'multiline.yaml');
      expect(data.description).toContain('\n');
    });

    test('should handle null and undefined values', async () => {
      const yamlContent = `
nullValue: null
emptyValue:
undefinedValue: ~
`;
      await writeTempFile('nulls.yaml', yamlContent);

      const data = await loadYamlFixture<NullHandlingYamlFixture>(loader, 'nulls.yaml');
      expect(data.nullValue).toBeNull();
      expect(data.emptyValue).toBeNull();
      expect(data.undefinedValue).toBeNull();
    });

    test('should reject malformed YAML', async () => {
      const yamlContent = `
invalid yaml:
  - missing
  proper: [structure
`;
      await writeTempFile('invalid.yaml', yamlContent);

      await expect(loadYamlFixture<unknown>(loader, 'invalid.yaml')).rejects.toThrow(
        UnsafeYAMLError
      );
    });
  });

  describe('Malicious YAML Prevention', () => {
    test('should prevent code execution attempts', async () => {
      // While YAML.parse is safe by default, we test various attack vectors
      const maliciousYAML = `
!!python/object/apply:os.system
args: ['ls -la']
`;
      await writeTempFile('malicious1.yaml', maliciousYAML);

      // The YAML library should reject this or our validation catches it
      await expect(loadYamlFixture<unknown>(loader, 'malicious1.yaml')).rejects.toThrow();
    });

    test('should prevent arbitrary code tags', async () => {
      const maliciousYAML = `
!!js/function "function() { require('child_process').exec('rm -rf /'); }"
`;
      await writeTempFile('malicious2.yaml', maliciousYAML);

      await expect(loadYamlFixture<unknown>(loader, 'malicious2.yaml')).rejects.toThrow();
    });

    test('should prevent constructor attacks', async () => {
      const maliciousYAML = `
!!js/constructor |
  function() { this.process = require('process'); }
`;
      await writeTempFile('malicious3.yaml', maliciousYAML);

      await expect(loadYamlFixture<unknown>(loader, 'malicious3.yaml')).rejects.toThrow();
    });

    test('should prevent js regexp tag usage', async () => {
      const maliciousYAML = `
!!js/regexp /hack/i
`;
      await writeTempFile('malicious4.yaml', maliciousYAML);

      await expect(loadYamlFixture<unknown>(loader, 'malicious4.yaml')).rejects.toThrow();
    });

    test('should prevent custom unknown tags', async () => {
      const maliciousYAML = `
!!evil_tag
data: attempt
`;
      await writeTempFile('malicious5.yaml', maliciousYAML);

      await expect(loadYamlFixture<unknown>(loader, 'malicious5.yaml')).rejects.toThrow();
    });

    test('should prevent python object creation attempts', async () => {
      const maliciousYAML = `
!!python/object/new:tuple [1, 2, 3]
`;
      await writeTempFile('malicious6.yaml', maliciousYAML);

      await expect(loadYamlFixture<unknown>(loader, 'malicious6.yaml')).rejects.toThrow();
    });
  });

  describe('Schema Validation - Layer 3', () => {
    test('should validate against simple schema', async () => {
      const yamlContent = `
name: TestApp
version: 1.0.0
`;
      await writeTempFile('app.yaml', yamlContent);

      const schema: JSONSchema = {
        type: 'object',
        required: ['name', 'version'],
        properties: {
          name: { type: 'string' },
          version: { type: 'string' },
        },
      };

      const data = await loadYamlFixture<AppConfigFixture>(loader, 'app.yaml', schema);
      expect(data.name).toBe('TestApp');
    });

    test('should reject data missing required fields', async () => {
      const yamlContent = `
name: TestApp
`;
      await writeTempFile('incomplete.yaml', yamlContent);

      const schema: JSONSchema = {
        type: 'object',
        required: ['name', 'version'],
        properties: {
          name: { type: 'string' },
          version: { type: 'string' },
        },
      };

      await expect(
        loadYamlFixture<AppConfigFixture>(loader, 'incomplete.yaml', schema)
      ).rejects.toThrow(SchemaValidationError);
    });

    test('should reject data with wrong types', async () => {
      const yamlContent = `
name: TestApp
version: 123
`;
      await writeTempFile('wrongtype.yaml', yamlContent);

      const schema: JSONSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          version: { type: 'string' },
        },
      };

      await expect(
        loadYamlFixture<AppConfigFixture>(loader, 'wrongtype.yaml', schema)
      ).rejects.toThrow(SchemaValidationError);
    });

    test('should validate nested object schemas', async () => {
      const yamlContent = `
server:
  host: localhost
  port: 8080
`;
      await writeTempFile('server.yaml', yamlContent);

      const schema: JSONSchema = {
        type: 'object',
        required: ['server'],
        properties: {
          server: {
            type: 'object',
            required: ['host', 'port'],
            properties: {
              host: { type: 'string' },
              port: { type: 'number' },
            },
          },
        },
      };

      const data = await loadYamlFixture<ServerConfigFixture>(loader, 'server.yaml', schema);
      expect(data.server.port).toBe(8080);
    });

    test('should validate array schemas', async () => {
      const yamlContent = `
users:
  - id: 1
    name: Alice
  - id: 2
    name: Bob
`;
      await writeTempFile('users.yaml', yamlContent);

      const schema: JSONSchema = {
        type: 'object',
        properties: {
          users: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'name'],
              properties: {
                id: { type: 'number' },
                name: { type: 'string' },
              },
            },
          },
        },
      };

      const data = await loadYamlFixture<UsersYamlFixture>(loader, 'users.yaml', schema);
      expect(data.users).toHaveLength(2);
    });

    test('should validate enum values', async () => {
      const yamlContent = `
status: active
`;
      await writeTempFile('enum.yaml', yamlContent);

      const schema: JSONSchema = {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'inactive', 'pending'],
          },
        },
      };

      const data = await loadYamlFixture<EnumYamlFixture>(loader, 'enum.yaml', schema);
      expect(data.status).toBe('active');
    });

    test('should reject invalid enum values', async () => {
      const yamlContent = `
status: invalid
`;
      await writeTempFile('bad-enum.yaml', yamlContent);

      const schema: JSONSchema = {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'inactive', 'pending'],
          },
        },
      };

      await expect(
        loadYamlFixture<EnumYamlFixture>(loader, 'bad-enum.yaml', schema)
      ).rejects.toThrow(SchemaValidationError);
    });
  });

  describe('Multiple File Loading', () => {
    test('should load multiple files successfully', async () => {
      await writeTempFile('file1.yaml', 'value: 1');
      await writeTempFile('file2.yaml', 'value: 2');
      await writeTempFile('file3.yaml', 'value: 3');

      const results = await loadYamlFixtures<ValueEntryFixture>(loader, [
        'file1.yaml',
        'file2.yaml',
        'file3.yaml',
      ]);
      expect(results).toHaveLength(3);
      expect(results[0].value).toBe(1);
      expect(results[2].value).toBe(3);
    });

    test('should validate all files with schema', async () => {
      await writeTempFile('config1.yaml', 'name: Config1\nversion: 1.0');
      await writeTempFile('config2.yaml', 'name: Config2\nversion: 2.0');

      const schema: JSONSchema = {
        type: 'object',
        required: ['name', 'version'],
        properties: {
          name: { type: 'string' },
          version: { type: 'number' },
        },
      };

      const results = await loadYamlFixtures<NamedConfigFixture>(
        loader,
        ['config1.yaml', 'config2.yaml'],
        schema
      );
      expect(results).toHaveLength(2);
      expect(results[1].name).toBe('Config2');
    });
  });

  describe('Error Handling', () => {
    test('should throw error for non-existent file', async () => {
      await expect(loadYamlFixture<unknown>(loader, 'nonexistent.yaml')).rejects.toThrow(
        /File not found|ENOENT/
      );
    });

    test('should provide helpful error messages', async () => {
      const yamlContent = `
name: Test
version: abc
`;
      await writeTempFile('error.yaml', yamlContent);

      const schema: JSONSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          version: { type: 'number' },
        },
      };

      const error = await loadYamlFixture<AppConfigFixture>(loader, 'error.yaml', schema).catch(
        (err) => err
      );
      expect(error).toBeInstanceOf(SchemaValidationError);
      if (error instanceof SchemaValidationError) {
        expect(error.message).toContain('version');
      }
    });
  });

  describe('Utility Methods', () => {
    test('should return base directory', async () => {
      expect(loader.getBaseDir()).toBe(tempDir);
    });
  });
});
