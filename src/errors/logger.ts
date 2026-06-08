import { randomUUID } from 'crypto';
import { MissionProtocolError } from './mission-error';
import { ErrorContext } from './types';

export interface LogSink {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const DEFAULT_SINK: LogSink = console;

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function generateCorrelationId(): string {
  try {
    return randomUUID();
  } catch {
    const rand = Math.random().toString(36).slice(2, 10);
    return `cid-${Date.now().toString(36)}-${rand}`;
  }
}

export class ErrorLogger {
  constructor(private readonly sink: LogSink = DEFAULT_SINK) {}

  /**
   * Ensures a correlation identifier exists and returns it.
   */
  ensureCorrelationId(context?: ErrorContext): string {
    if (context?.correlationId && typeof context.correlationId === 'string') {
      return context.correlationId;
    }
    return generateCorrelationId();
  }

  /**
   * Emit a structured log entry for an error.
   */
  logError(error: MissionProtocolError, contextOverride?: ErrorContext): string {
    const correlationId = this.ensureCorrelationId(contextOverride ?? error.context);
    const mergedContext: ErrorContext = {
      ...error.context,
      ...contextOverride,
      correlationId,
    };

    error.context = mergedContext;

    const payload = {
      level: error.severity === 'warning' ? 'warn' : 'error',
      timestamp: new Date().toISOString(),
      correlationId,
      code: error.code,
      category: error.category,
      retryable: error.retryable,
      message: error.message,
      context: mergedContext,
      stack: error.stack,
    };

    const sinkMethod =
      payload.level === 'warn' ? this.sink.warn.bind(this.sink) : this.sink.error.bind(this.sink);

    const contextString = safeStringify(payload);
    if (contextString) {
      sinkMethod(contextString);
    } else {
      sinkMethod(
        `[${payload.timestamp}] [${payload.level.toUpperCase()}] [${payload.code}] ${error.message} (correlationId=${correlationId})`
      );
    }

    return correlationId;
  }

  logWarning(message: string, context: ErrorContext = {}): string {
    const correlationId = this.ensureCorrelationId(context);
    const payload = {
      level: 'warn',
      timestamp: new Date().toISOString(),
      correlationId,
      message,
      context,
    };
    const contextString = safeStringify(payload);
    if (contextString) {
      this.sink.warn(contextString);
    } else {
      this.sink.warn(`[${payload.timestamp}] [WARN] ${message} (correlationId=${correlationId})`);
    }
    return correlationId;
  }
}
