import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { ErrorHandler } from '../../src/errors/handler';
import { ErrorLogger } from '../../src/errors/logger';
import { MissionProtocolError } from '../../src/errors/mission-error';

class StubLogger extends ErrorLogger {
  public errors: MissionProtocolError[] = [];

  constructor() {
    super({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });
  }

  logError(error: MissionProtocolError): string {
    this.errors.push(error);
    return 'cid-test';
  }
}

const originalLogger = new ErrorLogger();

describe('ErrorHandler', () => {
  let stubLogger: StubLogger;

  beforeEach(() => {
    stubLogger = new StubLogger();
    ErrorHandler.useLogger(stubLogger);
  });

  afterEach(() => {
    ErrorHandler.useLogger(originalLogger);
  });

  test('wrap merges context and applies fallback message', () => {
    const wrapped = ErrorHandler.wrap(
      new Error('boom'),
      'operation.test',
      { module: 'tests' },
      {
        userMessage: 'User facing',
        fallbackMessage: 'Fallback applied',
        category: 'system',
        code: 'SYSTEM_INTERNAL_FAILURE',
      }
    );

    expect(wrapped.message).toBe('Fallback applied');
    expect(wrapped.context?.operation).toBe('operation.test');
    expect(wrapped.context?.module).toBe('tests');
    expect(wrapped.context?.userMessage).toBe('User facing');
  });

  test('wrap attaches module context when provided in options', () => {
    const wrapped = ErrorHandler.wrap(
      new Error('oops'),
      'operation.mod',
      {},
      {
        module: 'module-name',
      }
    );

    expect(wrapped.context?.module).toBe('module-name');
  });

  test('handle logs error and returns when rethrow disabled', () => {
    const result = ErrorHandler.handle(
      new Error('boom'),
      'operation',
      { module: 'tests' },
      {
        rethrow: false,
        userMessage: 'Failure encountered',
      }
    );

    expect(result).toBeInstanceOf(MissionProtocolError);
    expect(stubLogger.errors).toHaveLength(1);
    expect(stubLogger.errors[0].context?.correlationId).toBe('cid-test');
  });

  test('handle rethrows by default', () => {
    expect(() => ErrorHandler.handle(new Error('fail'), 'op')).toThrow(MissionProtocolError);
    expect(stubLogger.errors).toHaveLength(1);
  });

  test('toPublicError produces sanitized payload', () => {
    const error = new MissionProtocolError({
      message: 'Internal',
      code: 'SYSTEM_INTERNAL_FAILURE',
      category: 'system',
      context: { userMessage: 'Visible', correlationId: 'cid' },
    });

    const publicError = ErrorHandler.toPublicError(error);
    expect(publicError.message).toBe('Visible');
    expect(publicError.correlationId).toBe('cid');
    expect(publicError.code).toBe('SYSTEM_INTERNAL_FAILURE');
  });

  test('toPublicError falls back to default message without user context', () => {
    const error = new MissionProtocolError({
      message: 'hidden',
      code: 'SYSTEM_INTERNAL_FAILURE',
      category: 'system',
    });

    const publicError = ErrorHandler.toPublicError(error);
    expect(publicError.message).toBe('An unexpected error occurred');
  });
});
