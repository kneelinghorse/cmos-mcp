import { emitTelemetryError, emitTelemetryInfo, emitTelemetryWarning } from './telemetry';

export type RSIPStopReason = 'disabled' | 'converged' | 'max_iterations' | 'error';

export interface RSIPLoopOptions {
  readonly enabled?: boolean;
  readonly maxIterations?: number;
  readonly minIterations?: number;
  readonly convergenceThreshold?: number;
  readonly stagnationLimit?: number;
  readonly telemetrySource?: string;
  readonly clock?: () => Date;
}

export interface RSIPIterationContext<TState> {
  readonly iteration: number;
  readonly state: TState | undefined;
  readonly history: ReadonlyArray<RSIPIterationResult<TState>>;
}

export interface RSIPIterationResult<TState> {
  readonly state: TState;
  readonly improvementScore: number;
  readonly summary?: string;
  readonly telemetry?: Record<string, unknown>;
  readonly converged?: boolean;
}

export interface RSIPLoopHandlers<TState> {
  initialize?: () => Promise<TState> | TState;
  iterate: (context: RSIPIterationContext<TState>) => Promise<RSIPIterationResult<TState>>;
  finalize?: (summary: RSIPLoopSummary<TState>) => Promise<void> | void;
}

export interface RSIPLoopSummary<TState> {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly iterations: ReadonlyArray<RSIPIterationResult<TState>>;
  readonly converged: boolean;
  readonly reason: RSIPStopReason;
  readonly finalState: TState | undefined;
  readonly error?: Error;
}

interface NormalizedOptions {
  enabled: boolean;
  maxIterations: number;
  minIterations: number;
  convergenceThreshold: number;
  stagnationLimit: number;
  telemetrySource: string;
  clock: () => Date;
}

const DEFAULT_OPTIONS: NormalizedOptions = {
  enabled: true,
  maxIterations: 5,
  minIterations: 1,
  convergenceThreshold: 0.01,
  stagnationLimit: 2,
  telemetrySource: 'RSIPLoop',
  clock: () => new Date(),
};

function normalizeOptions(options: RSIPLoopOptions = {}): NormalizedOptions {
  const normalized: NormalizedOptions = {
    enabled: options.enabled ?? DEFAULT_OPTIONS.enabled,
    maxIterations: Math.max(1, options.maxIterations ?? DEFAULT_OPTIONS.maxIterations),
    minIterations: Math.max(0, options.minIterations ?? DEFAULT_OPTIONS.minIterations),
    convergenceThreshold: options.convergenceThreshold ?? DEFAULT_OPTIONS.convergenceThreshold,
    stagnationLimit: Math.max(1, options.stagnationLimit ?? DEFAULT_OPTIONS.stagnationLimit),
    telemetrySource: options.telemetrySource ?? DEFAULT_OPTIONS.telemetrySource,
    clock: options.clock ?? DEFAULT_OPTIONS.clock,
  };

  if (normalized.minIterations > normalized.maxIterations) {
    normalized.minIterations = normalized.maxIterations;
  }

  return normalized;
}

export async function runRSIPLoop<TState>(
  handlers: RSIPLoopHandlers<TState>,
  options?: RSIPLoopOptions
): Promise<RSIPLoopSummary<TState>> {
  const config = normalizeOptions(options);
  const startedAt = config.clock().toISOString();

  if (!config.enabled) {
    const summary: RSIPLoopSummary<TState> = {
      startedAt,
      completedAt: startedAt,
      iterations: [],
      converged: false,
      reason: 'disabled',
      finalState: undefined,
    };
    emitTelemetryInfo(config.telemetrySource, 'RSIP loop disabled via configuration toggle', {
      startedAt,
    });
    if (handlers.finalize) {
      await handlers.finalize(summary);
    }
    return summary;
  }

  emitTelemetryInfo(config.telemetrySource, 'RSIP loop started', {
    maxIterations: config.maxIterations,
    minIterations: config.minIterations,
    convergenceThreshold: config.convergenceThreshold,
    stagnationLimit: config.stagnationLimit,
    startedAt,
  });

  let state: TState | undefined;
  if (handlers.initialize) {
    state = await handlers.initialize();
  }

  const iterations: RSIPIterationResult<TState>[] = [];
  let reason: RSIPStopReason = 'max_iterations';
  let converged = false;
  let error: Error | undefined;
  let consecutiveBelowThreshold = 0;

  try {
    for (let iteration = 1; iteration <= config.maxIterations; iteration += 1) {
      const context: RSIPIterationContext<TState> = {
        iteration,
        state,
        history: iterations,
      };

      const result = await handlers.iterate(context);
      iterations.push(result);
      state = result.state;

      if (result.improvementScore < 0) {
        emitTelemetryWarning(config.telemetrySource, 'RSIP iteration regressed', {
          iteration,
          improvementScore: result.improvementScore,
          summary: result.summary,
        });
      }

      emitTelemetryInfo(config.telemetrySource, 'RSIP iteration completed', {
        iteration,
        improvementScore: result.improvementScore,
        converged: Boolean(result.converged),
        summary: result.summary,
        telemetry: result.telemetry,
      });

      if (result.improvementScore < config.convergenceThreshold) {
        consecutiveBelowThreshold += 1;
      } else {
        consecutiveBelowThreshold = 0;
      }

      const minSatisfied = iteration >= config.minIterations;
      const stagnationReached = minSatisfied && consecutiveBelowThreshold >= config.stagnationLimit;
      const explicitConvergence = Boolean(result.converged);

      if (explicitConvergence || stagnationReached) {
        converged = true;
        reason = 'converged';
        break;
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
    reason = 'error';
    emitTelemetryError(config.telemetrySource, 'RSIP loop failed', {
      error: error.message,
      stack: error.stack,
    });
  }

  const completedAt = config.clock().toISOString();
  const summary: RSIPLoopSummary<TState> = {
    startedAt,
    completedAt,
    iterations,
    converged,
    reason,
    finalState: state,
    error,
  };

  emitTelemetryInfo(config.telemetrySource, 'RSIP loop completed', {
    completedAt,
    iterations: iterations.length,
    converged,
    reason,
    error: error?.message,
  });

  if (handlers.finalize) {
    await handlers.finalize(summary);
  }
  return summary;
}

export const __test__ = {
  normalizeOptions,
};
