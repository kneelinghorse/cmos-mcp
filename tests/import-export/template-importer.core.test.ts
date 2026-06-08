import { describe, expect, test, beforeEach, jest } from '@jest/globals';
import { TemplateImporter } from '../../src/import-export/template-importer';
import { ImportExportError } from '../../src/import-export/types';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';

jest.mock('../../src/loaders/yaml-loader', () => {
  return {
    SecureYAMLLoader: jest.fn(),
  };
});

jest.mock('../../src/import-export/security-validator', () => {
  const validateMock = jest.fn();
  const SecurityValidator = jest.fn().mockImplementation(() => ({
    validate: validateMock,
  }));
  (SecurityValidator as any).getSchema = jest.fn().mockReturnValue({});
  return { SecurityValidator };
});

const loaderModule = jest.requireMock('../../src/loaders/yaml-loader') as {
  SecureYAMLLoader: jest.Mock;
};
const validatorModule = jest.requireMock('../../src/import-export/security-validator') as {
  SecurityValidator: jest.Mock & { getSchema: jest.Mock };
};
const SecureYAMLLoader = loaderModule.SecureYAMLLoader;
const SecurityValidator = validatorModule.SecurityValidator;

describe('TemplateImporter core flow', () => {
  let loaderMock: any;
  let validatorMock: any;
  const baseDir = os.tmpdir();

  beforeEach(() => {
    loaderMock = {
      load: jest.fn(),
      sanitizePath: jest.fn((value: string) => value),
    };
    validatorMock = {
      validate: jest.fn(),
    };

    (SecureYAMLLoader as jest.Mock).mockImplementation(() => loaderMock);
    (SecurityValidator as jest.Mock).mockImplementation(() => validatorMock);
    (SecurityValidator as any).getSchema.mockReturnValue({});
    jest.spyOn(global.Date, 'now').mockReturnValue(0);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    (SecureYAMLLoader as jest.Mock).mockReset();
    (SecurityValidator as jest.Mock).mockReset();
  });

  const createImporter = () => new TemplateImporter(baseDir);

  test('imports template when validation succeeds', async () => {
    loaderMock.load.mockResolvedValue({ metadata: { name: 'demo' } });
    validatorMock.validate.mockResolvedValue({
      valid: true,
      template: {
        metadata: { name: 'demo' },
        dependencies: [],
      },
      errors: [],
      warnings: [],
      performanceMs: 10,
    });

    const importer = createImporter();
    const result = await importer.import('template.yaml', { skipSignatureVerification: true });

    expect(loaderMock.load).toHaveBeenCalled();
    expect(validatorMock.validate).toHaveBeenCalledWith(expect.any(Object), true);
    expect(result.template.metadata.name).toBe('demo');
  });

  test('throws ImportExportError when validation report invalid', async () => {
    loaderMock.load.mockResolvedValue({ metadata: { name: 'demo' } });
    validatorMock.validate.mockResolvedValue({
      valid: false,
      errors: ['schema mismatch'],
      warnings: [],
    });

    const importer = createImporter();
    await expect(importer.import('template.yaml')).rejects.toThrow(ImportExportError);
  });

  test('wraps loader failures as ImportExportError', async () => {
    loaderMock.load.mockRejectedValue(new Error('bad yaml'));

    const importer = createImporter();
    await expect(importer.import('template.yaml')).rejects.toThrow(
      'Failed to load template structure'
    );
  });

  test('wraps unexpected validator errors', async () => {
    loaderMock.load.mockResolvedValue({ metadata: { name: 'demo' } });
    validatorMock.validate.mockRejectedValue(new Error('validator crashed'));

    const importer = createImporter();
    await expect(importer.import('template.yaml')).rejects.toThrow(
      'Import failed: validator crashed'
    );
  });

  test('emits performance warning when import exceeds target', async () => {
    loaderMock.load.mockResolvedValue({ metadata: { name: 'demo' } });
    validatorMock.validate.mockResolvedValue({
      valid: true,
      template: { metadata: { name: 'demo' }, dependencies: [] },
      errors: [],
      warnings: [],
      performanceMs: 10,
    });

    const importer = createImporter();
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(global.Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(2005);

    await importer.import('slow-template.yaml');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Import performance warning'));
  });

  test('importFromString writes temporary file and cleans up', async () => {
    loaderMock.load.mockResolvedValue({ metadata: { name: 'demo' } });
    validatorMock.validate.mockResolvedValue({
      valid: true,
      template: { metadata: { name: 'demo' }, dependencies: [] },
      errors: [],
      warnings: [],
      performanceMs: 5,
    });

    const importer = createImporter();
    const result = await importer.importFromString('metadata: { name: demo }');

    expect(result.template.metadata.name).toBe('demo');
    const tempFiles = await fsp.readdir(baseDir);
    const tempMatches = tempFiles.filter((file) => file.includes('.temp-'));
    expect(tempMatches.length).toBe(0);
  });
});
