import { MissionProtocolError } from './mission-error';
import { ErrorLogger } from './logger';
import { ErrorCategory, ErrorCode, ErrorContext, ErrorSeverity } from './types';
import { normalizeError } from './utils';

export interface WrapOptions {
  module?: string;
  category?: ErrorCategory;
  code?: ErrorCode;
  severity?: ErrorSeverity;
  userMessage?: string;
  retryable?: boolean;
  fallbackMessage?: string;
}

export interface HandleOptions extends WrapOptions {
  logger?: ErrorLogger;
  rethrow?: boolean;
}

export class ErrorHandler {
  private static logger = new ErrorLogger();

  static useLogger(logger: ErrorLogger): void {
    this.logger = logger;
  }

  static wrap(
    error: unknown,
    operation: string,
    context: ErrorContext = {},
    options: WrapOptions = {}
  ): MissionProtocolError {
    const baseContext: ErrorContext = {
      ...context,
      operation,
    };

    if (options.module) {
      baseContext.module = options.module;
    }

    if (options.userMessage) {
      baseContext.userMessage = options.userMessage;
    }

    const normalized = normalizeError(error, {
      message: options.fallbackMessage,
      category: options.category,
      severity: options.severity,
      context: baseContext,
      code: options.code,
      retryable: options.retryable,
    });

    normalized.context = {
      ...normalized.context,
      ...baseContext,
    };

    if (options.fallbackMessage) {
      normalized.message = options.fallbackMessage;
    }

    return normalized;
  }

  static handle(
    error: unknown,
    operation: string,
    context: ErrorContext = {},
    options: HandleOptions = {}
  ): MissionProtocolError {
    const logger = options.logger ?? this.logger;
    const wrapped = this.wrap(error, operation, context, options);
    const correlationId = logger.logError(wrapped, wrapped.context);
    wrapped.context = {
      ...wrapped.context,
      correlationId,
    };

    if (options.rethrow ?? true) {
      throw wrapped;
    }

    return wrapped;
  }

  static toPublicError(error: MissionProtocolError) {
    return {
      code: error.code,
      category: error.category,
      message: error.context?.userMessage ?? 'An unexpected error occurred',
      correlationId: error.context?.correlationId,
      retryable: error.retryable,
    };
  }
}
