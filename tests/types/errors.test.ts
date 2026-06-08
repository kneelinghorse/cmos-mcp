import { describe, expect, test } from '@jest/globals';
import {
  YAMLLoaderError,
  PathTraversalError,
  SchemaValidationError,
  UnsafeYAMLError,
} from '../../src/types/errors';

describe('types/errors compatibility layer', () => {
  test('YAMLLoaderError preserves message and context', () => {
    const error = new YAMLLoaderError(
      'Base failure',
      { file: 'test.yaml' },
      'CONFIG_INVALID',
      'config'
    );
    expect(error.message).toBe('Base failure');
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.category).toBe('config');
    expect(error.context?.file).toBe('test.yaml');
  });

  test('YAMLLoaderError defaults to system failure metadata', () => {
    const error = new YAMLLoaderError('Defaulted');
    expect(error.code).toBe('SYSTEM_INTERNAL_FAILURE');
    expect(error.category).toBe('system');
  });

  test('PathTraversalError sets IO-specific metadata', () => {
    const error = new PathTraversalError('../etc/passwd');
    expect(error.code).toBe('IO_PERMISSION_DENIED');
    expect(error.category).toBe('io');
    expect(error.context?.attemptedPath).toBe('../etc/passwd');
    expect(error.message).toContain('Path traversal attempt detected');
  });

  test('SchemaValidationError stores validation errors array', () => {
    const issues = ['missing fields', 'invalid types'];
    const error = new SchemaValidationError('Invalid payload', issues, { file: 'template.yaml' });
    expect(error.errors).toBe(issues);
    expect(error.context?.validationErrors).toBe(issues);
    expect(error.code).toBe('VALIDATION_SCHEMA_MISMATCH');
    expect(error.category).toBe('validation');
  });

  test('UnsafeYAMLError maps to validation failure', () => {
    const error = new UnsafeYAMLError('Detected executable code', { line: 42 });
    expect(error.code).toBe('VALIDATION_INVALID_INPUT');
    expect(error.category).toBe('validation');
    expect(error.context?.line).toBe(42);
  });
});
