import { MissionProtocolError } from './mission-error';
import { ErrorCategory, ErrorCode, ErrorContext, ErrorSeverity, SerializedError } from './types';

interface NormalizeOptions {
  message?: string;
  category?: ErrorCategory;
  severity?: ErrorSeverity;
  context?: ErrorContext;
  code?: ErrorCode;
  retryable?: boolean;
}

/**
 * Normalize arbitrary values into MissionProtocolError instances.
 */
export function normalizeError(
  error: unknown,
  options: NormalizeOptions = {}
): MissionProtocolError {
  const { message, category, severity, context, code, retryable } = options;

  if (error instanceof MissionProtocolError) {
    if (context) {
      error.context = {
        ...error.context,
        ...context,
      };
    }
    if (retryable !== undefined) {
      (error as MissionProtocolError & { retryable: boolean }).retryable = retryable;
    }
    return error;
  }

  if (error instanceof Error) {
    return new MissionProtocolError({
      message: message ?? error.message,
      code: code ?? 'INTERNAL_UNEXPECTED',
      category: category ?? 'internal',
      severity,
      context: {
        ...context,
        cause: error.stack ?? error.message,
      },
      cause: error,
      retryable,
    });
  }

  return new MissionProtocolError({
    message: message ?? 'Unknown error',
    code: code ?? 'UNKNOWN',
    category: category ?? 'unknown',
    severity,
    context,
    cause: error,
    retryable,
  });
}

/**
 * Convert MissionProtocolError into a deterministic serialisable shape.
 */
export function serializeMissionError(error: MissionProtocolError): SerializedError {
  return error.toJSON();
}

/**
 * Helper to attach extra context to an error in a fluent manner.
 */
export function attachContext<T extends MissionProtocolError>(error: T, context: ErrorContext): T {
  error.context = {
    ...error.context,
    ...context,
  };
  return error;
}
