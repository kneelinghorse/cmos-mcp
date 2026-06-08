import { MissionProtocolError } from './mission-error';
import { ErrorCode, ErrorContext, ErrorSeverity } from './types';

export interface ConfigErrorOptions {
  code?: Extract<ErrorCode, 'CONFIG_MISSING' | 'CONFIG_INVALID'>;
  context?: ErrorContext;
  severity?: ErrorSeverity;
  cause?: unknown;
  retryable?: boolean;
}

export class ConfigError extends MissionProtocolError {
  constructor(message: string, options: ConfigErrorOptions = {}) {
    super({
      message,
      code: options.code ?? 'CONFIG_INVALID',
      category: 'config',
      severity: options.severity ?? 'error',
      context: options.context,
      cause: options.cause,
      retryable: options.retryable ?? false,
    });
  }
}
