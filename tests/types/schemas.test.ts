import { describe, expect, test } from '@jest/globals';
import type { JSONSchema, ValidationResult } from '../../src/types/schemas';

const acceptSchema = (schema: JSONSchema): JSONSchema => schema;
const acceptResult = <T>(result: ValidationResult<T>): ValidationResult<T> => result;

describe('types/schemas', () => {
  test('supports nested object schemas with array definitions', () => {
    const schema = acceptSchema({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1 },
        tags: {
          type: 'array',
          items: { type: 'string', minLength: 2 },
        },
      },
      required: ['name'],
      additionalProperties: false,
    });

    expect(schema.type).toBe('object');
    expect(schema.properties?.name?.type).toBe('string');
    expect(schema.properties?.tags?.items?.type).toBe('string');
    expect(schema.required).toContain('name');
  });

  test('captures validation errors with typed payloads', () => {
    const result = acceptResult<{ id: string }>({
      valid: false,
      errors: ['Missing id'],
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['Missing id']);
  });

  test('allows typed data on successful validation', () => {
    const result = acceptResult<{ version: string }>({
      valid: true,
      data: { version: '1.0.0' },
    });

    expect(result.valid).toBe(true);
    expect(result.data?.version).toBe('1.0.0');
  });
});
