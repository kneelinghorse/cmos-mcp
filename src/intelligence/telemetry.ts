/**
 * Telemetry utilities for intelligence services.
 *
 * Provides a lightweight hook that downstream missions can replace with
 * structured telemetry collectors once they are available.
 */

export type TelemetryEventLevel = 'info' | 'warning' | 'error';

export interface TelemetryEvent {
  source: string;
  level: TelemetryEventLevel;
  message: string;
  context?: Record<string, unknown>;
}

export type TelemetryHandler = (event: TelemetryEvent) => void;

let handler: TelemetryHandler | null = null;
const LEVEL_PRIORITY: Record<TelemetryEventLevel, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

function parseTelemetryLevel(level?: string): TelemetryEventLevel | null {
  if (!level) {
    return null;
  }
  const normalized = level.trim().toLowerCase();
  if (normalized === 'info' || normalized === 'warning' || normalized === 'error') {
    return normalized;
  }
  return null;
}

let minimumLevel: TelemetryEventLevel =
  parseTelemetryLevel(process.env.MISSION_TELEMETRY_LEVEL) ??
  parseTelemetryLevel(process.env.MISSION_PROTOCOL_TELEMETRY_LEVEL) ??
  'warning';

function shouldEmit(level: TelemetryEventLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minimumLevel];
}

/**
 * Register a telemetry handler. Downstream integrations can inject their own
 * collector without requiring us to ship a concrete analytics dependency.
 */
export function registerTelemetryHandler(nextHandler: TelemetryHandler | null): void {
  handler = nextHandler;
}

/**
 * Configure the minimum telemetry level that will be emitted.
 * Defaults to "warning" when unspecified.
 */
export function setTelemetryLevel(level: TelemetryEventLevel): void {
  minimumLevel = level;
}

/**
 * Retrieve the current minimum telemetry level.
 */
export function getTelemetryLevel(): TelemetryEventLevel {
  return minimumLevel;
}

/**
 * Emit a telemetry event if it meets the configured severity threshold.
 */
export function emitTelemetryEvent(
  level: TelemetryEventLevel,
  source: string,
  message: string,
  context?: Record<string, unknown>
): void {
  if (!shouldEmit(level)) {
    return;
  }

  const event: TelemetryEvent = {
    source,
    level,
    message,
    context,
  };

  if (handler) {
    try {
      handler(event);
      return;
    } catch (error) {
      // Fall through to console.warn so the warning is not lost.
      console.warn(
        `[Telemetry handler error] ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const consoleFn =
    level === 'error' ? console.error : level === 'warning' ? console.warn : console.info;
  const formattedMessage = `[Telemetry][${source}] ${message}`;

  if (context) {
    consoleFn(formattedMessage, context);
  } else {
    consoleFn(formattedMessage);
  }
}

/**
 * Emit helpers for common levels
 */
export function emitTelemetryInfo(
  source: string,
  message: string,
  context?: Record<string, unknown>
): void {
  emitTelemetryEvent('info', source, message, context);
}

export function emitTelemetryWarning(
  source: string,
  message: string,
  context?: Record<string, unknown>
): void {
  emitTelemetryEvent('warning', source, message, context);
}

export function emitTelemetryError(
  source: string,
  message: string,
  context?: Record<string, unknown>
): void {
  emitTelemetryEvent('error', source, message, context);
}

export const __test__ = {
  parseTelemetryLevel,
};
