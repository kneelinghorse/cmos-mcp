import { MissionProtocolError } from '../errors/mission-error';
import { ErrorCategory, ErrorCode, ErrorContext } from '../errors/types';

/**
 * Historical compatibility layer for YAML loader specific errors.
 */
export class YAMLLoaderError extends MissionProtocolError {
  constructor(
    message: string,
    context: ErrorContext = {},
    code: ErrorCode = 'SYSTEM_INTERNAL_FAILURE',
    category: ErrorCategory = 'system'
  ) {
    super({
      message,
      code,
      category,
      context,
    });
    this.name = 'YAMLLoaderError';
  }
}

export class PathTraversalError extends YAMLLoaderError {
  constructor(attemptedPath: string, context: ErrorContext = {}) {
    super(
      `Path traversal attempt detected: ${attemptedPath}`,
      {
        ...context,
        attemptedPath,
      },
      'IO_PERMISSION_DENIED',
      'io'
    );
    this.name = 'PathTraversalError';
    this.context = {
      ...this.context,
      attemptedPath,
    };
  }
}

export class SchemaValidationError extends YAMLLoaderError {
  public readonly errors: unknown[];

  constructor(message: string, errors: unknown[], context: ErrorContext = {}) {
    super(
      `Schema validation failed: ${message}`,
      {
        ...context,
        validationErrors: errors,
      },
      'VALIDATION_SCHEMA_MISMATCH',
      'validation'
    );
    this.name = 'SchemaValidationError';
    this.errors = errors;
  }
}

export class UnsafeYAMLError extends YAMLLoaderError {
  constructor(message: string, context: ErrorContext = {}) {
    super(
      `Unsafe YAML content detected: ${message}`,
      context,
      'VALIDATION_INVALID_INPUT',
      'validation'
    );
    this.name = 'UnsafeYAMLError';
  }
}
