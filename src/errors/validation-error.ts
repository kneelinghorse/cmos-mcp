import { MissionProtocolError } from './mission-error';
import { ErrorContext, ErrorSeverity, ErrorCode } from './types';

export interface ValidationErrorOptions {
  code?: Extract<ErrorCode, 'VALIDATION_INVALID_INPUT' | 'VALIDATION_SCHEMA_MISMATCH'>;
  context?: ErrorContext;
  severity?: ErrorSeverity;
  cause?: unknown;
  retryable?: boolean;
}

export class ValidationError extends MissionProtocolError {
  constructor(message: string, options: ValidationErrorOptions = {}) {
    super({
      message,
      code: options.code ?? 'VALIDATION_INVALID_INPUT',
      category: 'validation',
      severity: options.severity ?? 'error',
      context: options.context,
      cause: options.cause,
      retryable: options.retryable ?? false,
    });
  }
}
