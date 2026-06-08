import { ZodError, ZodIssue } from 'zod';
import {
  normalizeValidationError,
  ValidationError,
  SchemaError,
  SanitizationError,
} from '../../src/validation/errors';

describe('normalizeValidationError', () => {
  it('returns validation errors unchanged', () => {
    const original = new SanitizationError('fail');
    const normalized = normalizeValidationError(original);

    expect(normalized).toBe(original);
  });

  it('wraps generic Error instances', () => {
    const err = new Error('plain');
    const normalized = normalizeValidationError(err);

    expect(normalized).toBeInstanceOf(ValidationError);
    expect(normalized.message).toBe('plain');
  });

  it('wraps unknown values with fallback', () => {
    const normalized = normalizeValidationError({ message: 'no-error-class' }, 'fallback');

    expect(normalized).toBeInstanceOf(ValidationError);
    expect(normalized.message).toBe('fallback');
  });

  it('formats diverse Zod issues', () => {
    const zodIssues: ZodIssue[] = [
      {
        code: 'invalid_type',
        expected: 'object',
        received: 'undefined',
        path: ['template', 'metadata'],
        message: 'Required',
      },
      {
        code: 'invalid_type',
        expected: 'object',
        received: 'undefined',
        path: ['template', 'spec'],
        message: 'Spec missing',
      },
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'undefined',
        path: ['template', 'metadata', 'kind'],
        message: 'Kind missing',
      } as any,
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'undefined',
        path: ['template', 'metadata', 'apiVersion'],
        message: 'API version missing',
      } as any,
      {
        code: 'invalid_type',
        expected: 'object',
        received: 'string',
        path: ['template', 'spec'],
        message: 'Should be object',
      },
      {
        code: 'invalid_type',
        expected: 'object',
        received: 'undefined',
        path: [],
        message: 'Missing root value',
      },
      {
        code: 'invalid_string',
        path: ['metadata', 'name'],
        message: 'Must be lowercase',
      } as any,
      {
        code: 'invalid_enum_value',
        path: ['metadata', 'format'],
        options: ['yaml', 'json'],
        message: 'Invalid format',
      } as any,
      {
        code: 'invalid_literal',
        path: ['metadata', 'kind'],
        expected: 'MissionTemplate',
        message: 'Wrong literal',
      } as any,
      {
        code: 'too_small',
        path: ['spec', 'steps'],
        minimum: 1,
        inclusive: true,
        type: 'array',
        message: 'Too few steps',
      } as any,
      {
        code: 'too_small',
        path: ['metadata', 'owner'],
        minimum: 3,
        inclusive: false,
        type: 'string',
        message: 'Too short',
      } as any,
      {
        code: 'too_big',
        path: ['metadata', 'tags'],
        maximum: 3,
        inclusive: false,
        type: 'array',
        message: 'Too many tags',
      } as any,
      {
        code: 'too_big',
        path: ['metadata', 'budget'],
        maximum: 100,
        inclusive: true,
        type: 'number',
        message: 'Too much budget',
      } as any,
      {
        code: 'custom',
        path: ['metadata', 'signature'],
        message: 'Invalid signature',
      } as any,
      {
        code: 'unrecognized',
        path: ['metadata', 'extra', 0, 'name'],
        message: 'Unexpected field',
      } as any,
    ];

    const zodError = new ZodError(zodIssues);
    const normalized = normalizeValidationError(zodError);

    expect(normalized).toBeInstanceOf(SchemaError);
    expect(normalized.message).toContain('Template must have metadata object');
    expect(normalized.message).toContain('Template must have spec object');
    expect(normalized.message).toContain('Parameter "template.spec" must be of type object');
    expect(normalized.message).toContain('Template must have kind: "MissionTemplate"');
    expect(normalized.message).toContain('Template must have apiVersion: "mission-template.v1"');
    expect(normalized.message).toContain('Parameter "value" is required');
    expect(normalized.message).toContain('metadata.name: Must be lowercase');
    expect(normalized.message).toContain('Invalid metadata.format: must be one of yaml, json');
    expect(normalized.message).toContain('Invalid metadata.kind: expected "MissionTemplate"');
    expect(normalized.message).toContain('spec.steps must contain at least 1 items');
    expect(normalized.message).toContain('metadata.owner must be greater than 3 characters');
    expect(normalized.message).toContain('metadata.tags must contain less than 3 items');
    expect(normalized.message).toContain('metadata.budget must be at most 100');
    expect(normalized.message).toContain('Invalid signature');
    expect(normalized.message).toContain('Unexpected field');
  });
});
