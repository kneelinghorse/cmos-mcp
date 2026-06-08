const { exportTemplate } = require('../../src/tools/export-template');
const { ValidationError: InputValidationError } = require('../../src/validation/errors');

jest.mock('../../src/import-export/template-exporter', () => ({
  TemplateExporter: jest.fn(),
}));

jest.mock('../../src/validation/middleware', () => ({
  validateAndSanitize: jest.fn(),
}));

jest.mock('../../src/validation/common', () => ({
  safeFilePath: jest.fn(async (value) => value),
}));

jest.mock('../../src/errors/handler', () => ({
  ErrorHandler: {
    handle: jest.fn((error) => error),
    toPublicError: jest.fn(() => ({ message: 'Public failure', correlationId: 'cid-123' })),
  },
}));

const exporterModule = require('../../src/import-export/template-exporter');
const middlewareModule = require('../../src/validation/middleware');
const commonModule = require('../../src/validation/common');
const errorHandlerModule = require('../../src/errors/handler');

const template = {
  apiVersion: 'mission-template.v1',
  kind: 'MissionTemplate',
  metadata: {
    name: 'demo',
    version: '1.0.0',
    author: 'tester',
    signature: { keyId: 'abc', algorithm: 'PGP-SHA256', value: 'sig' },
  },
  spec: {},
};

describe('exportTemplate core behaviour', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    commonModule.safeFilePath = jest.fn(async (value) => value);
    middlewareModule.validateAndSanitize = jest.fn();
    exporterModule.TemplateExporter = jest.fn();
    errorHandlerModule.ErrorHandler.handle = jest.fn((error) => error);
    errorHandlerModule.ErrorHandler.toPublicError = jest.fn(() => ({
      message: 'Public failure',
      correlationId: 'cid-123',
    }));
  });

  const mockValidatedParams = (overrides = {}) => ({
    template,
    outputPath: 'output.yaml',
    baseDir: undefined,
    format: 'yaml',
    includeComments: true,
    pretty: true,
    ...overrides,
  });

  test('exports template successfully', async () => {
    const exporterInstance = {
      export: jest.fn().mockResolvedValue(true),
      exportToString: jest.fn().mockReturnValue('content'),
    };
    exporterModule.TemplateExporter.mockImplementation(() => exporterInstance);
    middlewareModule.validateAndSanitize.mockResolvedValue(mockValidatedParams());

    const result = await exportTemplate({ template, outputPath: 'out.yaml' });

    expect(result.success).toBe(true);
    expect(exporterInstance.export).toHaveBeenCalledWith(template, 'output.yaml', {
      format: 'yaml',
      includeComments: true,
      pretty: true,
    });
    expect(result.preview).toBe('content');
  });

  test('returns failure when exporter reports unsuccessful operation', async () => {
    exporterModule.TemplateExporter.mockImplementation(() => ({
      export: jest.fn().mockResolvedValue(false),
      exportToString: jest.fn(),
    }));
    middlewareModule.validateAndSanitize.mockResolvedValue(mockValidatedParams());

    const result = await exportTemplate({ template, outputPath: 'out.yaml' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('Export failed');
  });

  test('handles InputValidationError with detailed messages', async () => {
    const validationError = new InputValidationError('Invalid path', {
      data: { messages: ['outputPath: invalid character'] },
    });
    middlewareModule.validateAndSanitize.mockRejectedValue(validationError);

    const result = await exportTemplate({ template, outputPath: 'out.yaml' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('outputPath');
  });

  test('wraps unexpected errors via ErrorHandler', async () => {
    middlewareModule.validateAndSanitize.mockRejectedValue(new Error('boom'));

    const result = await exportTemplate({ template, outputPath: 'out.yaml' });
    expect(errorHandlerModule.ErrorHandler.handle).toHaveBeenCalled();
    expect(result.message).toContain('cid-123');
  });

  test('supports JSON format options', async () => {
    const exporterInstance = {
      export: jest.fn().mockResolvedValue(true),
      exportToString: jest.fn().mockReturnValue('{"template":true}'),
    };
    exporterModule.TemplateExporter.mockImplementation(() => exporterInstance);
    middlewareModule.validateAndSanitize.mockResolvedValue(
      mockValidatedParams({ format: 'json', outputPath: 'out.json' })
    );

    const result = await exportTemplate({ template, outputPath: 'out.json', format: 'json' });
    expect(result.format).toBe('json');
    expect(commonModule.safeFilePath).toHaveBeenCalledWith(
      'out.json',
      expect.objectContaining({
        allowedExtensions: ['.json'],
      })
    );
    expect(result.preview.startsWith('{"template"')).toBe(true);
  });
});
