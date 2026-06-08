import { describe, expect, jest, test, beforeEach } from '@jest/globals';
import { ErrorLogger } from '../../src/errors/logger';
import { MissionProtocolError } from '../../src/errors/mission-error';

const createError = (overrides: Partial<MissionProtocolError> = {}) =>
  new MissionProtocolError({
    message: 'Failure',
    code: 'SYSTEM_INTERNAL_FAILURE',
    category: 'system',
    severity: 'error',
    context: { module: 'tests' },
    ...('severity' in overrides ? { severity: overrides.severity as any } : {}),
    ...('context' in overrides ? { context: overrides.context } : {}),
    ...('retryable' in overrides ? { retryable: overrides.retryable as boolean } : {}),
  });

describe('ErrorLogger', () => {
  let sink: { info: jest.Mock; warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    sink = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
  });

  test('ensureCorrelationId reuses provided identifier', () => {
    const logger = new ErrorLogger(sink);
    const context = { correlationId: 'reuse-me' };
    expect(logger.ensureCorrelationId(context)).toBe('reuse-me');
  });

  test('ensureCorrelationId generates fallback when randomUUID fails', async () => {
    jest.resetModules();
    jest.doMock('crypto', () => ({
      randomUUID: jest.fn(() => {
        throw new Error('not supported');
      }),
    }));
    const { ErrorLogger: MockedLogger } = await import('../../src/errors/logger');
    const logger = new MockedLogger(sink);
    const correlation = logger.ensureCorrelationId({});
    expect(correlation).toMatch(/^cid-/);
    jest.dontMock('crypto');
    jest.resetModules();
  });

  test('logError emits JSON payload and returns correlation id', () => {
    const logger = new ErrorLogger(sink);
    const error = createError({ severity: 'warning' });

    const correlationId = logger.logError(error, { operation: 'test-op' });
    expect(typeof correlationId).toBe('string');

    expect(sink.warn).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(sink.warn.mock.calls[0][0] as string);
    expect(payload.level).toBe('warn');
    expect(payload.context?.operation).toBe('test-op');
    expect(payload.correlationId).toBe(correlationId);
  });

  test('logError falls back to plain text when JSON serialization fails', () => {
    const logger = new ErrorLogger(sink);
    const circular: any = {};
    circular.self = circular;

    const error = createError({
      context: { module: 'tests', circular },
    });

    const correlationId = logger.logError(error, { additional: 'context', circular });
    expect(sink.error).toHaveBeenCalledTimes(1);
    const message = sink.error.mock.calls[0][0] as string;
    expect(message).toContain('correlationId=');
    expect(message).toContain(correlationId);
  });

  test('logWarning serializes context when possible', () => {
    const logger = new ErrorLogger(sink);
    const correlationId = logger.logWarning('Heads up', { module: 'tests' });
    expect(sink.warn).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(sink.warn.mock.calls[0][0] as string);
    expect(payload.message).toBe('Heads up');
    expect(payload.correlationId).toBe(correlationId);
  });

  test('logWarning falls back when serialization fails', () => {
    const logger = new ErrorLogger(sink);
    const circular: any = {};
    circular.self = circular;
    const correlationId = logger.logWarning('Pay attention', { circular });
    const output = sink.warn.mock.calls[0][0] as string;
    expect(output).toContain('Pay attention');
    expect(output).toContain(correlationId);
  });

  test('logError uses error context when no override provided', () => {
    const logger = new ErrorLogger(sink);
    const error = createError();

    const correlationId = logger.logError(error);
    const payload = JSON.parse(sink.error.mock.calls[0][0] as string);
    expect(payload.context?.module).toBe('tests');
    expect(payload.correlationId).toBe(correlationId);
  });

  test('logWarning generates context when none supplied', () => {
    const logger = new ErrorLogger(sink);
    const correlationId = logger.logWarning('Heads up');
    const payload = JSON.parse(sink.warn.mock.calls[0][0] as string);
    expect(payload.context).toEqual({});
    expect(payload.correlationId).toBe(correlationId);
  });
});
