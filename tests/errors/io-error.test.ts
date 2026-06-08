import { describe, expect, test } from '@jest/globals';
import { IOError } from '../../src/errors/io-error';

describe('IOError', () => {
  test('defaults to IO_NOT_FOUND and non-retryable', () => {
    const error = new IOError('Not found');
    expect(error.code).toBe('IO_NOT_FOUND');
    expect(error.category).toBe('io');
    expect(error.retryable).toBe(false);
  });

  test('accepts custom options', () => {
    const error = new IOError('Permission denied', {
      code: 'IO_PERMISSION_DENIED',
      severity: 'warning',
      context: { path: '/tmp/secret' },
      retryable: true,
    });

    expect(error.code).toBe('IO_PERMISSION_DENIED');
    expect(error.severity).toBe('warning');
    expect(error.context?.path).toBe('/tmp/secret');
    expect(error.retryable).toBe(true);
  });
});
