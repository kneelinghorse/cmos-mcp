import { ZodError, ZodIssue } from 'zod';

export interface ValidationErrorOptions {
  readonly issues?: ZodIssue[];
  readonly cause?: unknown;
  readonly code?: string;
  readonly data?: Record<string, unknown>;
}

export class ValidationError extends Error {
  public readonly issues?: ZodIssue[];
  public readonly code: string;
  public readonly data?: Record<string, unknown>;

  constructor(message: string, options: ValidationErrorOptions = {}) {
    super(message);
    if (options.cause !== undefined) {
      (this as unknown as { cause?: unknown }).cause = options.cause;
    }
    this.name = 'ValidationError';
    this.issues = options.issues;
    this.code = options.code ?? 'VALIDATION_ERROR';
    this.data = options.data;
  }
}

export class SchemaError extends ValidationError {
  constructor(message: string, options: ValidationErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'SCHEMA_ERROR' });
    this.name = 'SchemaError';
  }
}

export class SanitizationError extends ValidationError {
  constructor(message: string, options: ValidationErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'SANITIZATION_ERROR' });
    this.name = 'SanitizationError';
  }
}

function formatField(issue: ZodIssue): string {
  if (!issue.path || issue.path.length === 0) {
    return 'value';
  }
  return issue.path
    .map((segment) => (typeof segment === 'number' ? `[${segment}]` : String(segment)))
    .join('.');
}

function formatZodIssue(issue: ZodIssue): string {
  const field = formatField(issue);
  switch (issue.code) {
    case 'invalid_type':
      if (issue.received === 'undefined') {
        if (field.endsWith('metadata')) {
          return 'Template must have metadata object';
        }
        if (field.endsWith('spec')) {
          return 'Template must have spec object';
        }
        if (field.endsWith('kind')) {
          return 'Template must have kind: "MissionTemplate"';
        }
        if (field.endsWith('apiVersion')) {
          return 'Template must have apiVersion: "mission-template.v1"';
        }
        return `Parameter "${field}" is required`;
      }
      return `Parameter "${field}" must be of type ${issue.expected}`;
    case 'invalid_string':
      return `${field}: ${issue.message}`;
    case 'invalid_enum_value':
      return `Invalid ${field}: must be one of ${issue.options.join(', ')}`;
    case 'invalid_literal':
      return `Invalid ${field}: expected ${JSON.stringify(issue.expected)}`;
    case 'too_small': {
      const comparator = issue.inclusive ? 'at least' : 'greater than';
      if (issue.type === 'string') {
        return `${field} must be ${comparator} ${issue.minimum} characters`;
      }
      if (issue.type === 'number') {
        return `${field} must be ${comparator} ${issue.minimum}`;
      }
      if (issue.type === 'array') {
        return `${field} must contain ${comparator} ${issue.minimum} items`;
      }
      return `${field} must be ${comparator} ${issue.minimum}`;
    }
    case 'too_big': {
      const comparator = issue.inclusive ? 'at most' : 'less than';
      if (issue.type === 'string') {
        return `${field} must be ${comparator} ${issue.maximum} characters`;
      }
      if (issue.type === 'number') {
        return `${field} must be ${comparator} ${issue.maximum}`;
      }
      if (issue.type === 'array') {
        return `${field} must contain ${comparator} ${issue.maximum} items`;
      }
      return `${field} must be ${comparator} ${issue.maximum}`;
    }
    case 'custom':
      return issue.message || `Invalid ${field}`;
    default:
      return issue.message || `Invalid ${field}`;
  }
}

export function normalizeValidationError(
  error: unknown,
  fallbackMessage = 'Input validation failed'
): ValidationError {
  if (error instanceof ValidationError) {
    return error;
  }

  if (error instanceof ZodError) {
    const formattedIssues = error.issues.map((issue) => formatZodIssue(issue));
    const message =
      formattedIssues.length === 0
        ? fallbackMessage
        : formattedIssues.length === 1
          ? formattedIssues[0]
          : formattedIssues.join('; ');
    return new SchemaError(message, {
      issues: error.issues,
      cause: error,
      data: { issues: error.issues, messages: formattedIssues },
      code: 'SCHEMA_ERROR',
    });
  }

  if (error instanceof Error) {
    return new ValidationError(error.message, { cause: error });
  }

  return new ValidationError(fallbackMessage, { data: { error } });
}
