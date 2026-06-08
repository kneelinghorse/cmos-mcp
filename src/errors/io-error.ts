import { MissionProtocolError } from './mission-error';
import { ErrorCode, ErrorContext, ErrorSeverity } from './types';

export interface IOErrorOptions {
  code?: Extract<ErrorCode, 'IO_NOT_FOUND' | 'IO_PERMISSION_DENIED' | 'IO_SIZE_LIMIT'>;
  context?: ErrorContext;
  severity?: ErrorSeverity;
  cause?: unknown;
  retryable?: boolean;
}

export class IOError extends MissionProtocolError {
  constructor(message: string, options: IOErrorOptions = {}) {
    super({
      message,
      code: options.code ?? 'IO_NOT_FOUND',
      category: 'io',
      severity: options.severity ?? 'error',
      context: options.context,
      cause: options.cause,
      retryable: options.retryable ?? false,
    });
  }
}
