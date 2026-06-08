import { describe, it, expect, jest } from '@jest/globals';
import * as path from 'path';

const BASE_DIR = path.join(process.cwd(), 'templates');

describe('TemplateImporter coverage scenarios', () => {
  it('throws when security validation fails', async () => {
    const template = {
      apiVersion: 'mission-template.v1',
      kind: 'MissionTemplate',
      metadata: {
        name: 'invalid-template',
        version: '0.1.0',
        author: 'tests',
        signature: {
          keyId: 'test',
          algorithm: 'sha256',
          value: 'fake',
        },
      },
      spec: {},
    };

    const loaderMock = {
      load: jest.fn(() => template),
      sanitizePath: jest.fn((value: string) => value),
    };

    const validatorMock = {
      validate: jest.fn(async () => ({
        valid: false,
        template,
        layers: [],
        errors: ['invalid'],
        warnings: [],
        performanceMs: 1,
      })),
    };

    let TemplateImporter: any;

    jest.isolateModules(() => {
      jest.doMock('../../src/loaders/yaml-loader', () => ({
        SecureYAMLLoader: jest.fn(() => loaderMock),
      }));

      class MockSecurityValidator {
        static getSchema = jest.fn(() => ({}));
        constructor() {}
        validate = validatorMock.validate;
      }

      jest.doMock('../../src/import-export/security-validator', () => ({
        SecurityValidator: MockSecurityValidator,
        SecurityValidationError: class {},
        ImportExportError: class extends Error {},
        // Expose getSchema for TemplateImporter
        default: MockSecurityValidator,
      }));

      TemplateImporter = require('../../src/import-export/template-importer').TemplateImporter;
    });

    const importer = new TemplateImporter(BASE_DIR);

    await expect(importer.import('template.yaml')).rejects.toThrow('Template validation failed');
  });

  it('bubbles dependency resolution failures', async () => {
    const template = {
      apiVersion: 'mission-template.v1',
      kind: 'MissionTemplate',
      metadata: {
        name: 'with-dep',
        version: '0.1.0',
        author: 'tests',
        signature: {
          keyId: 'test',
          algorithm: 'sha256',
          value: 'fake',
        },
      },
      spec: {},
      dependencies: [
        {
          name: 'dep-1',
          sourceUrl: 'file:///tmp/dep.yaml',
          version: '0.0.1',
          checksum: 'sha256:deadbeef',
        },
      ],
    };

    const loaderMock = {
      load: jest.fn(() => template),
      sanitizePath: jest.fn((value: string) => value),
    };

    const validatorMock = {
      validate: jest.fn(async () => ({
        valid: true,
        template,
        layers: [],
        errors: [],
        warnings: [],
        performanceMs: 2,
      })),
    };

    let TemplateImporter: any;

    jest.isolateModules(() => {
      jest.doMock('../../src/loaders/yaml-loader', () => ({
        SecureYAMLLoader: jest.fn(() => loaderMock),
      }));

      class MockSecurityValidator {
        static getSchema = jest.fn(() => ({}));
        constructor() {}
        validate = validatorMock.validate;
      }

      jest.doMock('../../src/import-export/security-validator', () => ({
        SecurityValidator: MockSecurityValidator,
        SecurityValidationError: class {},
        ImportExportError: class extends Error {},
        DependencyResolutionError: class extends Error {},
        default: MockSecurityValidator,
      }));

      TemplateImporter = require('../../src/import-export/template-importer').TemplateImporter;
    });

    const importer = new TemplateImporter(BASE_DIR);

    const fetchSpy = jest
      .spyOn(TemplateImporter.prototype as any, 'fetchDependency')
      .mockRejectedValue(new Error('network error'));
    const checksumSpy = jest
      .spyOn(TemplateImporter.prototype as any, 'verifyDependencyChecksum')
      .mockImplementation(() => undefined);

    await expect(importer.import('template.yaml')).rejects.toThrow('Failed to resolve dependency');

    fetchSpy.mockRestore();
    checksumSpy.mockRestore();
  });

  it('importFromString cleans up temporary files on failure', async () => {
    const fsMocks = {
      writeFileAtomic: jest.fn(async () => {}),
      pathExists: jest.fn(async () => true),
      removeFile: jest.fn(async () => {}),
    };

    let TemplateImporter: any;

    jest.isolateModules(() => {
      jest.doMock('../../src/utils/fs', () => fsMocks);
      jest.doMock('../../src/loaders/yaml-loader', () => ({
        SecureYAMLLoader: jest.fn(() => ({})),
      }));

      class MockSecurityValidator {
        static getSchema = jest.fn(() => ({}));
        validate = jest.fn(async () => ({
          valid: true,
          template: {},
          layers: [],
          errors: [],
          warnings: [],
          performanceMs: 1,
        }));
      }

      jest.doMock('../../src/import-export/security-validator', () => ({
        SecurityValidator: MockSecurityValidator,
        ImportExportError: class extends Error {},
        DependencyResolutionError: class extends Error {},
        default: MockSecurityValidator,
      }));

      TemplateImporter = require('../../src/import-export/template-importer').TemplateImporter;
    });

    const importer = new TemplateImporter(BASE_DIR);
    const importSpy = jest.spyOn(importer, 'import').mockRejectedValue(new Error('failure'));

    await expect(importer.importFromString('foo: bar')).rejects.toThrow('failure');

    expect(fsMocks.writeFileAtomic).toHaveBeenCalled();
    expect(fsMocks.pathExists).toHaveBeenCalled();
    expect(fsMocks.removeFile).toHaveBeenCalled();

    importSpy.mockRestore();
  });

  it('warns when import exceeds performance target', async () => {
    const template = {
      apiVersion: 'mission-template.v1',
      kind: 'MissionTemplate',
      metadata: { name: 'x', version: '0.1.0' },
      spec: {},
    };

    const loaderMock = {
      load: jest.fn(async () => template),
      sanitizePath: jest.fn((value: string) => value),
    };

    const validatorMock = {
      validate: jest.fn(async () => ({
        valid: true,
        template,
        layers: [],
        errors: [],
        warnings: [],
        performanceMs: 5,
      })),
    };

    let TemplateImporter: any;

    jest.isolateModules(() => {
      jest.doMock('../../src/loaders/yaml-loader', () => ({
        SecureYAMLLoader: jest.fn(() => loaderMock),
      }));

      class MockSecurityValidator {
        static getSchema = jest.fn(() => ({}));
        validate = validatorMock.validate;
      }

      jest.doMock('../../src/import-export/security-validator', () => ({
        SecurityValidator: MockSecurityValidator,
        ImportExportError: class extends Error {},
        DependencyResolutionError: class extends Error {},
        default: MockSecurityValidator,
      }));

      TemplateImporter = require('../../src/import-export/template-importer').TemplateImporter;
    });

    const importer = new TemplateImporter(BASE_DIR);
    const depsSpy = jest.spyOn(importer as any, 'resolveDependencies').mockResolvedValue(new Map());

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let call = 0;
    const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => (call++ === 0 ? 0 : 1505));

    const result = await importer.import('template.yaml', { skipSignatureVerification: true });
    expect(result.template).toBe(template);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Import performance warning'));

    dateSpy.mockRestore();
    warnSpy.mockRestore();
    depsSpy.mockRestore();
  });

  it('wraps unexpected errors with ImportExportError', async () => {
    const template = {
      apiVersion: 'mission-template.v1',
      kind: 'MissionTemplate',
      metadata: { name: 'wrap-test', version: '1.0.0' },
      spec: {},
    };

    const loaderMock = {
      load: jest.fn(() => template),
      sanitizePath: jest.fn((value: string) => value),
    };

    let TemplateImporter: any;

    jest.isolateModules(() => {
      jest.doMock('../../src/loaders/yaml-loader', () => ({
        SecureYAMLLoader: jest.fn(() => loaderMock),
      }));

      class MockSecurityValidator {
        static getSchema = jest.fn(() => ({}));
        validate = jest.fn(() => {
          throw 'runtime explode';
        });
      }

      jest.doMock('../../src/import-export/security-validator', () => ({
        SecurityValidator: MockSecurityValidator,
        ImportExportError: class extends Error {},
        DependencyResolutionError: class extends Error {},
        default: MockSecurityValidator,
      }));

      TemplateImporter = require('../../src/import-export/template-importer').TemplateImporter;
    });

    const importer = new TemplateImporter(BASE_DIR);

    await expect(importer.import('template.yaml')).rejects.toThrow('Import failed: Unknown error');
  });
});
