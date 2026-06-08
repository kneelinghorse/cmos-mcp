import {
  ErrorCategory,
  ErrorCode,
  ErrorContext,
  ErrorSeverity,
  MissionErrorOptions,
  SerializedError,
} from './types';

/**
 * Base Mission Protocol error carrying structured metadata.
 */
export class MissionProtocolError extends Error {
  public readonly code: ErrorCode;
  public readonly category: ErrorCategory;
  public readonly severity: ErrorSeverity;
  public readonly retryable: boolean;
  public context?: ErrorContext;
  public readonly cause?: unknown;

  constructor(options: MissionErrorOptions) {
    super(options.message);
    this.name = new.target.name;
    this.code = options.code;
    this.category = options.category;
    this.severity = options.severity ?? 'error';
    this.retryable = options.retryable ?? false;
    this.context = options.context;
    this.cause = options.cause;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }

  /**
   * Convert the error into a JSON-safe structure.
   */
  toJSON(): SerializedError {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      category: this.category,
      severity: this.severity,
      retryable: this.retryable,
      context: this.context,
      stack: this.stack,
      cause: this.serializeCause(this.cause),
    };
  }

  /**
   * Create a public-safe payload that hides internal data.
   */
  toPublicObject(): SerializedError {
    const { stack, ...rest } = this.toJSON();
    return {
      ...rest,
      stack: undefined,
      cause: undefined,
    };
  }

  /**
   * Assert helper to detect MissionProtocolError instances.
   */
  static isMissionProtocolError(error: unknown): error is MissionProtocolError {
    return error instanceof MissionProtocolError;
  }

  private serializeCause(cause: unknown): SerializedError | string | undefined {
    if (!cause) {
      return undefined;
    }

    if (cause instanceof MissionProtocolError) {
      return cause.toJSON();
    }

    if (cause instanceof Error) {
      return `${cause.name}: ${cause.message}`;
    }

    if (typeof cause === 'string') {
      return cause;
    }

    try {
      return JSON.stringify(cause);
    } catch (serializationError) {
      return `Unserializable cause: ${serializationError}`;
    }
  }
}
