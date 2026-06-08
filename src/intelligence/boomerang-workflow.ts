import { promises as fs } from 'fs';
import { join } from 'path';

import { ensureDir, pathExists, removeDir, writeFileAtomic } from '../utils/fs';
import { resolveWorkspacePath } from '../utils/workspace-io';
import { emitTelemetryError, emitTelemetryInfo, emitTelemetryWarning } from './telemetry';

const DEFAULT_RUNTIME_ROOT = 'runtime/boomerang';
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_RETRIES = 2;

export type BoomerangStepStatus = 'success' | 'retry' | 'failed';

export interface BoomerangStepResult {
  readonly status: BoomerangStepStatus;
  readonly output?: unknown;
  readonly checkpoint?: Record<string, unknown>;
  readonly diagnostic?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface BoomerangCheckpointAttempt {
  readonly attempt: number;
  readonly status: BoomerangStepStatus;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly diagnostic?: string;
  readonly metadata?: Record<string, unknown>;
}

export type BoomerangCheckpointStatus = 'pending' | 'success' | 'failed' | 'retrying';

export interface BoomerangCheckpoint {
  readonly missionId: string;
  readonly stepId: string;
  readonly stepIndex: number;
  readonly status: BoomerangCheckpointStatus;
  readonly attempts: readonly BoomerangCheckpointAttempt[];
  readonly lastOutput?: unknown;
  readonly lastCheckpoint?: Record<string, unknown>;
  readonly lastUpdated: string;
}

export interface BoomerangStepRunContext {
  readonly missionId: string;
  readonly stepId: string;
  readonly stepIndex: number;
  readonly attempt: number;
  readonly resume: boolean;
  readonly previousOutput?: unknown;
  readonly previousCheckpoint?: BoomerangCheckpoint | null;
}

export interface BoomerangStep {
  readonly id: string;
  readonly name?: string;
  readonly run: (
    payload: unknown,
    context: BoomerangStepRunContext
  ) => Promise<BoomerangStepResult>;
}

export interface BoomerangWorkflowResult {
  readonly missionId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: 'success' | 'failed' | 'fallback';
  readonly completedSteps: readonly string[];
  readonly failedStep?: string;
  readonly fallbackReason?: string;
  readonly lastOutput?: unknown;
  readonly diagnostics: {
    readonly lastSuccessfulStep?: string;
    readonly attempts: Record<string, number>;
    readonly checkpointPaths: readonly string[];
    readonly retainedCheckpoints: number;
    readonly error?: string;
    readonly rollbackHint?: string;
  };
}

export interface BoomerangWorkflowConfig {
  readonly missionId: string;
  readonly steps: readonly BoomerangStep[];
  readonly runtimeRoot?: string;
  readonly retentionDays?: number;
  readonly maxRetries?: number;
  readonly telemetrySource?: string;
  readonly clock?: () => Date;
}

interface LoadedCheckpointState {
  readonly checkpoints: Map<number, BoomerangCheckpoint>;
  readonly existingPaths: Map<number, string>;
}

function computeCheckpointStatus(resultStatus: BoomerangStepStatus): BoomerangCheckpointStatus {
  if (resultStatus === 'success') {
    return 'success';
  }
  if (resultStatus === 'retry') {
    return 'retrying';
  }
  return 'failed';
}

export class BoomerangWorkflow {
  private readonly missionId: string;
  private readonly steps: readonly BoomerangStep[];
  private readonly runtimeRoot: string;
  private readonly retentionDays: number;
  private readonly maxRetries: number;
  private readonly telemetrySource: string;
  private readonly clock: () => Date;

  constructor(config: BoomerangWorkflowConfig) {
    if (!config.missionId || config.missionId.trim().length === 0) {
      throw new Error('missionId is required for BoomerangWorkflow');
    }
    if (!config.steps || config.steps.length === 0) {
      throw new Error('steps are required for BoomerangWorkflow');
    }

    this.missionId = config.missionId;
    this.steps = config.steps;
    this.runtimeRoot = config.runtimeRoot ?? DEFAULT_RUNTIME_ROOT;
    this.retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.maxRetries = Math.max(0, config.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.telemetrySource = config.telemetrySource ?? `Boomerang:${this.missionId}`;
    this.clock = config.clock ?? (() => new Date());
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  async execute(initialPayload?: unknown): Promise<BoomerangWorkflowResult> {
    if (this.retentionDays > 0) {
      await BoomerangWorkflow.pruneExpired(this.runtimeRoot, this.retentionDays, this.clock);
    }

    const startedAt = this.nowIso();
    const missionDirRelative = join(this.runtimeRoot, this.missionId);
    const missionDirAbsolute = await resolveWorkspacePath(missionDirRelative, {
      allowRelative: true,
    });
    await ensureDir(missionDirAbsolute);

    const { checkpoints: persistedCheckpoints, existingPaths } = await this.loadCheckpoints(
      missionDirRelative,
      missionDirAbsolute
    );
    const retainedPaths = new Set<string>(existingPaths.values());

    const attemptCounts = new Map<string, number>();
    const completedSteps: string[] = [];

    let payload = initialPayload;
    let lastOutput = initialPayload;
    let lastSuccessfulStep: string | undefined;
    let errorMessage: string | undefined;
    let failedStep: string | undefined;
    let fallbackReason: string | undefined;
    let status: 'success' | 'failed' | 'fallback' = 'success';

    // Respect completed checkpoints before resuming execution.
    for (let index = 0; index < this.steps.length; index += 1) {
      const step = this.steps[index];
      const persisted = persistedCheckpoints.get(index);
      if (persisted && persisted.status === 'success') {
        attemptCounts.set(step.id, persisted.attempts.length);
        completedSteps.push(step.id);
        lastSuccessfulStep = step.id;
        payload = persisted.lastOutput;
        lastOutput = persisted.lastOutput;
        continue;
      }

      let checkpoint = persisted ?? null;
      let attempt = checkpoint?.attempts.length ?? 0;
      let resume = attempt > 0;

      let keepProcessing = true;

      while (keepProcessing) {
        const attemptNumber = attempt + 1;
        const stepStartedAt = this.nowIso();
        emitTelemetryInfo(this.telemetrySource, 'step_start', {
          pattern: 'boomerang',
          missionId: this.missionId,
          stepId: step.id,
          attempt: attemptNumber,
        });

        let result: BoomerangStepResult;
        try {
          result = await step.run(payload, {
            missionId: this.missionId,
            stepId: step.id,
            stepIndex: index,
            attempt: attemptNumber,
            resume,
            previousOutput: payload,
            previousCheckpoint: checkpoint,
          });
        } catch (error) {
          const diagnostic = error instanceof Error ? error.message : String(error);
          result = {
            status: 'failed',
            diagnostic,
          };
        }

        const stepCompletedAt = this.nowIso();
        const attemptRecord: BoomerangCheckpointAttempt = {
          attempt: attemptNumber,
          status: result.status,
          startedAt: stepStartedAt,
          completedAt: stepCompletedAt,
          diagnostic: result.diagnostic,
          metadata: result.metadata,
        };

        const attempts = checkpoint ? [...checkpoint.attempts, attemptRecord] : [attemptRecord];
        checkpoint = {
          missionId: this.missionId,
          stepId: step.id,
          stepIndex: index,
          status: computeCheckpointStatus(result.status),
          attempts,
          lastOutput: result.output ?? checkpoint?.lastOutput,
          lastCheckpoint: result.checkpoint ?? checkpoint?.lastCheckpoint,
          lastUpdated: stepCompletedAt,
        };

        attempt = attempts.length;
        attemptCounts.set(step.id, attempts.length);

        const checkpointPath = await this.writeCheckpoint(
          missionDirRelative,
          missionDirAbsolute,
          index,
          checkpoint
        );
        retainedPaths.add(checkpointPath);
        emitTelemetryInfo(this.telemetrySource, 'checkpoint_write', {
          pattern: 'boomerang',
          missionId: this.missionId,
          stepId: step.id,
          attempt: attemptNumber,
          status: checkpoint.status,
          checkpoint: checkpointPath,
        });

        if (result.status === 'success') {
          emitTelemetryInfo(this.telemetrySource, 'step_complete', {
            pattern: 'boomerang',
            missionId: this.missionId,
            stepId: step.id,
            attempt: attemptNumber,
          });
          completedSteps.push(step.id);
          lastSuccessfulStep = step.id;
          payload = result.output ?? payload;
          lastOutput = payload;
          keepProcessing = false;
          break;
        }

        if (result.status === 'retry') {
          if (attempt > this.maxRetries) {
            status = 'fallback';
            failedStep = step.id;
            fallbackReason = 'retry_limit_exceeded';
            errorMessage = result.diagnostic ?? 'Retry limit exceeded.';
            emitTelemetryWarning(this.telemetrySource, 'fallback_triggered', {
              pattern: 'boomerang',
              missionId: this.missionId,
              stepId: step.id,
              attempts: attempt,
              maxRetries: this.maxRetries,
            });
            emitTelemetryInfo(this.telemetrySource, 'rollback', {
              pattern: 'boomerang',
              missionId: this.missionId,
              lastSuccessfulStep,
              failedStep,
            });
            keepProcessing = false;
            break;
          }
          resume = true;
          continue;
        }

        status = 'failed';
        failedStep = step.id;
        errorMessage = result.diagnostic ?? 'Boomerang step failed';
        emitTelemetryError(this.telemetrySource, 'step_failed', {
          pattern: 'boomerang',
          missionId: this.missionId,
          stepId: step.id,
          attempt: attemptNumber,
          error: errorMessage,
        });
        emitTelemetryInfo(this.telemetrySource, 'rollback', {
          pattern: 'boomerang',
          missionId: this.missionId,
          lastSuccessfulStep,
          failedStep,
        });
        keepProcessing = false;
        break;
      }

      if (status !== 'success') {
        break;
      }
    }

    const completedAt = this.nowIso();

    if (status === 'success') {
      if (await pathExists(missionDirAbsolute)) {
        await removeDir(missionDirAbsolute);
      }
      retainedPaths.clear();
    }

    const checkpointPaths =
      status === 'success'
        ? []
        : Array.from(retainedPaths.values()).sort((a, b) => a.localeCompare(b));

    return {
      missionId: this.missionId,
      startedAt,
      completedAt,
      status,
      completedSteps,
      failedStep,
      fallbackReason,
      lastOutput,
      diagnostics: {
        lastSuccessfulStep,
        attempts: Object.fromEntries(attemptCounts),
        checkpointPaths,
        retainedCheckpoints: checkpointPaths.length,
        error: errorMessage,
        rollbackHint: lastSuccessfulStep
          ? `Resume from ${lastSuccessfulStep} using retained checkpoints.`
          : undefined,
      },
    };
  }

  private async loadCheckpoints(
    missionDirRelative: string,
    missionDirAbsolute: string
  ): Promise<LoadedCheckpointState> {
    if (!(await pathExists(missionDirAbsolute))) {
      return {
        checkpoints: new Map(),
        existingPaths: new Map(),
      };
    }

    const entries = await fs.readdir(missionDirAbsolute);
    const checkpoints = new Map<number, BoomerangCheckpoint>();
    const existingPaths = new Map<number, string>();

    for (const entry of entries) {
      const match = /^step-(\d+)\.json$/i.exec(entry);
      if (!match) {
        continue;
      }
      const index = Number.parseInt(match[1], 10) - 1;
      if (!Number.isFinite(index) || index < 0) {
        continue;
      }

      try {
        if (!entry.toLowerCase().endsWith('.json')) {
          continue;
        }

        const absolutePath = join(missionDirAbsolute, entry);
        const raw = await fs.readFile(absolutePath, 'utf-8');
        const parsed = JSON.parse(raw) as BoomerangCheckpoint;
        checkpoints.set(index, parsed);
        existingPaths.set(index, join(missionDirRelative, entry));
      } catch (error) {
        emitTelemetryWarning(this.telemetrySource, 'checkpoint_load_failed', {
          pattern: 'boomerang',
          missionId: this.missionId,
          stepIndex: index,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { checkpoints, existingPaths };
  }

  private async writeCheckpoint(
    missionDirRelative: string,
    missionDirAbsolute: string,
    stepIndex: number,
    checkpoint: BoomerangCheckpoint
  ): Promise<string> {
    const filename = `step-${stepIndex + 1}.json`;
    const relativePath = join(missionDirRelative, filename);
    const absolutePath = join(missionDirAbsolute, filename);
    await ensureDir(missionDirAbsolute);
    await writeFileAtomic(absolutePath, JSON.stringify(checkpoint, null, 2), {
      encoding: 'utf-8',
    });
    return relativePath;
  }

  static async pruneExpired(
    runtimeRoot: string,
    retentionDays: number,
    clock: () => Date = () => new Date()
  ): Promise<{ removed: number; scanned: number }> {
    if (retentionDays <= 0) {
      return { removed: 0, scanned: 0 };
    }

    const runtimeRootAbsolute = await resolveWorkspacePath(runtimeRoot, {
      allowRelative: true,
    });
    if (!(await pathExists(runtimeRootAbsolute))) {
      return { removed: 0, scanned: 0 };
    }

    const thresholdMs = retentionDays * 24 * 60 * 60 * 1000;
    const now = clock().getTime();

    const entries = await fs.readdir(runtimeRootAbsolute, { withFileTypes: true });
    let removed = 0;
    let scanned = 0;

    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory()) {
          return;
        }
        scanned += 1;
        const absolutePath = join(runtimeRootAbsolute, entry.name);
        const stats = await fs.stat(absolutePath);
        if (now - stats.mtimeMs >= thresholdMs) {
          await removeDir(absolutePath, { recursive: true, force: true });
          removed += 1;
        }
      })
    );

    return { removed, scanned };
  }
}
