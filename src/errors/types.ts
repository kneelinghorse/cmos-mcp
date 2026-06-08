/**
 * Canonical error categories used across Mission Protocol v2.
 */
export type ErrorCategory =
  | 'validation'
  | 'io'
  | 'config'
  | 'domain'
  | 'network'
  | 'system'
  | 'internal'
  | 'unknown';

/**
 * Severity levels for categorized errors.
 */
export type ErrorSeverity = 'fatal' | 'error' | 'warning';

/**
 * Standardised error codes for Mission Protocol.
 * Codes follow the convention `<CATEGORY>_<IDENTIFIER>`.
 */
export type ErrorCode =
  | 'VALIDATION_INVALID_INPUT'
  | 'VALIDATION_SCHEMA_MISMATCH'
  | 'IO_NOT_FOUND'
  | 'IO_PERMISSION_DENIED'
  | 'IO_SIZE_LIMIT'
  | 'CONFIG_MISSING'
  | 'CONFIG_INVALID'
  | 'DOMAIN_NOT_FOUND'
  | 'DOMAIN_INVALID'
  | 'NETWORK_TIMEOUT'
  | 'SYSTEM_DEPENDENCY_FAILURE'
  | 'SYSTEM_INTERNAL_FAILURE'
  | 'INTERNAL_UNEXPECTED'
  | 'UNKNOWN';

/**
 * Additional diagnostic context included with every error.
 */
export interface ErrorContext {
  operation?: string;
  module?: string;
  correlationId?: string;
  userMessage?: string;
  data?: Record<string, JsonValue>;
  cause?: unknown;
  [key: string]: unknown;
}

/**
 * Lightweight JSON-compatible value definition.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface MissionErrorOptions {
  message: string;
  code: ErrorCode;
  category: ErrorCategory;
  severity?: ErrorSeverity;
  context?: ErrorContext;
  cause?: unknown;
  retryable?: boolean;
}

export interface SerializedError {
  name: string;
  message: string;
  code: ErrorCode;
  category: ErrorCategory;
  severity: ErrorSeverity;
  retryable: boolean;
  context?: ErrorContext;
  stack?: string;
  cause?: SerializedError | string;
}
