import { describe, expect, test } from '@jest/globals';
import { z } from 'zod';
import { MissionProtocolError } from '../../src/errors/mission-error';
import { attachContext, normalizeError, serializeMissionError } from '../../src/errors/utils';

describe('error utils', () => {
  test('normalizeError merges context on MissionProtocolError', () => {
    const existing = new MissionProtocolError({
      message: 'existing',
      code: 'SYSTEM_INTERNAL_FAILURE',
      category: 'system',
      retryable: false,
      context: { module: 'existing' },
    });

    const normalized = normalizeError(existing, {
      context: { operation: 'test-op' },
      retryable: true,
    });

    expect(normalized.context?.module).toBe('existing');
    expect(normalized.context?.operation).toBe('test-op');
    expect(normalized.retryable).toBe(true);
  });

  test('normalizeError wraps standard Error with defaults', () => {
    const err = new Error('boom');
    err.stack = undefined;
    const normalized = normalizeError(err, {
      message: 'override',
      category: 'internal',
      code: 'INTERNAL_UNEXPECTED',
      severity: 'warning',
      context: { module: 'tests' },
      retryable: true,
    });

    expect(normalized.message).toBe('override');
    expect(normalized.category).toBe('internal');
    expect(normalized.context?.module).toBe('tests');
    expect(typeof normalized.context?.cause).toBe('string');
    expect(normalized.retryable).toBe(true);
  });

  test('normalizeError formats ZodError details', () => {
    const schema = z.object({ name: z.string().min(2) });
    const input = { name: '' };
    const zodError = (() => {
      try {
        schema.parse(input);
      } catch (error) {
        return error;
      }
      return undefined;
    })();

    const normalized = normalizeError(zodError, { message: 'fallback' });
    expect(normalized.message).toBe('fallback');
    expect(String(normalized.context?.cause || '')).toContain('ZodError');
  });

  test('normalizeError handles unknown values', () => {
    const normalized = normalizeError({ foo: 'bar' }, { message: 'unknown fallback' });
    expect(normalized.message).toBe('unknown fallback');
    expect(normalized.code).toBe('UNKNOWN');
    expect(normalized.category).toBe('unknown');
  });

  test('normalizeError applies default message and retryable fallback', () => {
    const normalized = normalizeError('string failure');
    expect(normalized.message).toBe('Unknown error');
    expect(normalized.retryable).toBe(false);
  });

  test('normalizeError keeps original retryable flag when undefined in options', () => {
    const existing = new MissionProtocolError({
      message: 'existing',
      code: 'SYSTEM_INTERNAL_FAILURE',
      category: 'system',
      retryable: false,
    });

    const normalized = normalizeError(existing);
    expect(normalized.retryable).toBe(false);
  });

  test('serializeMissionError returns JSON representation', () => {
    const error = new MissionProtocolError({
      message: 'serialize',
      code: 'SYSTEM_INTERNAL_FAILURE',
      category: 'system',
    });
    const serialized = serializeMissionError(error);
    expect(serialized.message).toBe('serialize');
    expect(serialized.code).toBe('SYSTEM_INTERNAL_FAILURE');
  });

  test('attachContext merges context fields', () => {
    const error = new MissionProtocolError({
      message: 'attach',
      code: 'SYSTEM_INTERNAL_FAILURE',
      category: 'system',
      context: { module: 'existing' },
    });

    const updated = attachContext(error, { operation: 'op', module: 'override' });
    expect(updated.context?.module).toBe('override');
    expect(updated.context?.operation).toBe('op');
  });
});
