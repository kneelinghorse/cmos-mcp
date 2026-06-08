import { promises as fs } from 'fs';
import { dirname } from 'path';

import { ensureDir } from '../utils/fs';
import { resolveWorkspacePath } from '../utils/workspace-io';
import { emitTelemetryWarning } from './telemetry';

export type AgenticObservabilityCategory = 'mission' | 'sub_mission' | 'workflow' | 'quality_gate';

export interface AgenticObservabilityEvent {
  readonly missionId: string;
  readonly category: AgenticObservabilityCategory;
  readonly type: string;
  readonly status?: string;
  readonly detail?: string;
  readonly data?: Record<string, unknown>;
  readonly ts?: string;
}

export interface AgenticQualityGateResult {
  readonly missionId: string;
  readonly gate: string;
  readonly status: 'passed' | 'failed' | 'warning';
  readonly detail?: string;
  readonly data?: Record<string, unknown>;
  readonly ts?: string;
}

export interface AgenticObservabilityOptions {
  /**
   * Target JSONL file for observability events. When null, logging is disabled.
   */
  readonly logPath?: string | null;
  /**
   * Telemetry source identifier for warning/error emission.
   */
  readonly telemetrySource?: string;
  /**
   * Clock function used for timestamp generation. Defaults to Date.now().
   */
  readonly clock?: () => Date;
}

const DEFAULT_LOG_PATH = 'runtime/agentic/events.jsonl';
const DEFAULT_TELEMETRY_SOURCE = 'AgenticObservability';

interface AgenticLogEntry {
  readonly ts: string;
  readonly missionId: string;
  readonly category: AgenticObservabilityCategory;
  readonly type: string;
  readonly status?: string;
  readonly detail?: string;
  readonly data?: Record<string, unknown>;
}

export class AgenticObservability {
  private readonly logPath: string | null;
  private readonly telemetrySource: string;
  private readonly clock: () => Date;

  constructor(options: AgenticObservabilityOptions = {}) {
    this.logPath = options.logPath ?? DEFAULT_LOG_PATH;
    this.telemetrySource = options.telemetrySource ?? DEFAULT_TELEMETRY_SOURCE;
    this.clock = options.clock ?? (() => new Date());
  }

  async recordEvent(event: AgenticObservabilityEvent): Promise<void> {
    await this.writeEntry({
      ts: event.ts ?? this.clock().toISOString(),
      missionId: event.missionId,
      category: event.category,
      type: event.type,
      status: event.status,
      detail: event.detail,
      data: event.data,
    });
  }

  async recordQualityGate(result: AgenticQualityGateResult): Promise<void> {
    await this.recordEvent({
      missionId: result.missionId,
      category: 'quality_gate',
      type: result.gate,
      status: result.status,
      detail: result.detail,
      data: result.data,
      ts: result.ts,
    });
  }

  async recordQualityGates(results: readonly AgenticQualityGateResult[]): Promise<void> {
    for (const result of results) {
      await this.recordQualityGate(result);
    }
  }

  private async writeEntry(entry: AgenticLogEntry): Promise<void> {
    if (!this.logPath) {
      return;
    }

    try {
      const resolvedPath = await resolveWorkspacePath(this.logPath, { allowRelative: true });
      await ensureDir(dirname(resolvedPath));
      await fs.appendFile(resolvedPath, `${JSON.stringify(entry)}\n`, 'utf-8');
    } catch (error) {
      emitTelemetryWarning(this.telemetrySource, 'observability_write_failed', {
        error: error instanceof Error ? error.message : String(error),
        logPath: this.logPath,
      });
    }
  }
}
