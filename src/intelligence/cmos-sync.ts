import { promises as fs } from 'fs';
import path from 'path';

import { MissionHistoryEvent } from './mission-history';
import { CmosDetector } from './cmos-detector';
import { ContextRecord, SQLiteClient, SQLiteClientError } from './sqlite-client';
import { pathExists } from '../utils/fs';
import { resolveWorkspacePath, writeFileAtomicWithBackup } from '../utils/workspace-io';

export type CmosSyncDirection = 'disabled' | 'files_to_db' | 'db_to_files' | 'bidirectional';

export type CmosSyncFrequency = 'manual' | 'per_mission' | 'per_event' | 'interval';

export interface ContextSyncTarget {
  readonly id: string;
  readonly filePath: string;
  readonly direction?: CmosSyncDirection;
  readonly snapshot?: boolean;
}

export interface CmosSyncLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface CmosSyncOptions {
  readonly enabled?: boolean;
  readonly direction?: CmosSyncDirection;
  readonly frequency?: CmosSyncFrequency;
  readonly minIntervalMs?: number;
  readonly projectRoot?: string;
  readonly databasePath?: string;
  readonly sessionsPath?: string;
  readonly contextTargets?: readonly ContextSyncTarget[];
  readonly snapshotOnSync?: boolean;
  readonly detector?: CmosDetector;
  readonly sqliteClientFactory?: (databasePath: string) => SQLiteClient;
  readonly logger?: CmosSyncLogger;
}

export interface SyncRequestOptions {
  readonly force?: boolean;
  readonly direction?: CmosSyncDirection;
  readonly includeContexts?: boolean;
  readonly includeSessionEvents?: boolean;
}

export type ContextSyncAction = 'write_db' | 'write_file' | 'skipped';

export interface ContextSyncOutcome {
  readonly id: string;
  readonly filePath?: string;
  readonly direction: CmosSyncDirection;
  readonly action: ContextSyncAction;
  readonly source: 'file' | 'database' | 'none';
  readonly updated: boolean;
  readonly updatedAt?: string | null;
  readonly reason?: string;
}

export interface SessionSyncResult {
  attempted: boolean;
  inserted: number;
  skipped: number;
  lastAppliedTimestamp?: string;
  warnings: string[];
}

export type CmosSyncStatus =
  | 'completed'
  | 'partial'
  | 'skipped'
  | 'disabled'
  | 'unavailable'
  | 'throttled';

export interface CmosSyncResult {
  readonly ok: boolean;
  readonly status: CmosSyncStatus;
  readonly direction: CmosSyncDirection;
  readonly frequency: CmosSyncFrequency;
  readonly contexts: ContextSyncOutcome[];
  readonly sessionEvents: SessionSyncResult;
  readonly warnings: string[];
  readonly errors: string[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

interface FileContextState {
  readonly exists: boolean;
  readonly path?: string;
  readonly payload?: Record<string, unknown>;
  readonly mtimeMs?: number;
  readonly error?: string;
}

interface ResolvedCmosSyncConfig {
  readonly enabled: boolean;
  readonly direction: CmosSyncDirection;
  readonly frequency: CmosSyncFrequency;
  readonly minIntervalMs: number;
  readonly projectRoot: string;
  readonly sessionsPath: string;
  readonly snapshotOnSync: boolean;
  readonly contextTargets: readonly ContextSyncTarget[];
  readonly databasePath?: string;
  readonly detector: CmosDetector;
  readonly sqliteClientFactory: (databasePath: string) => SQLiteClient;
  readonly logger?: CmosSyncLogger;
}

const DEFAULT_DIRECTION: CmosSyncDirection = 'bidirectional';
const DEFAULT_FREQUENCY: CmosSyncFrequency = 'manual';
const DEFAULT_MIN_INTERVAL_MS = 60_000;
const DEFAULT_CONTEXT_TARGETS: readonly ContextSyncTarget[] = [
  { id: 'project_context', filePath: 'PROJECT_CONTEXT.json' },
  { id: 'master_context', filePath: path.join('cmos', 'context', 'MASTER_CONTEXT.json') },
];

const CANONICAL_NEWLINE = '\n';

/**
 * CMOS Sync Service
 *
 * Provides bidirectional synchronization between Mission Protocol file mirrors
 * (PROJECT_CONTEXT.json, MASTER_CONTEXT.json, SESSIONS.jsonl) and the CMOS
 * SQLite database. All operations are best-effort with graceful degradation
 * when the CMOS runtime assets are unavailable.
 */
export class CmosSyncService {
  private readonly config: ResolvedCmosSyncConfig;

  private lastSyncAt?: number;

  constructor(options: CmosSyncOptions = {}) {
    this.config = {
      enabled: options.enabled ?? true,
      direction: options.direction ?? DEFAULT_DIRECTION,
      frequency: options.frequency ?? DEFAULT_FREQUENCY,
      minIntervalMs: Math.max(1_000, options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS),
      projectRoot: path.resolve(options.projectRoot ?? process.cwd()),
      sessionsPath: options.sessionsPath ?? 'SESSIONS.jsonl',
      snapshotOnSync: options.snapshotOnSync ?? false,
      contextTargets:
        options.contextTargets && options.contextTargets.length > 0
          ? options.contextTargets.map((target) => ({ ...target }))
          : DEFAULT_CONTEXT_TARGETS,
      databasePath: options.databasePath,
      detector: options.detector ?? CmosDetector.getInstance(),
      sqliteClientFactory:
        options.sqliteClientFactory ??
        ((databasePath: string) => new SQLiteClient({ databasePath })),
      logger: options.logger,
    };
  }

  async syncAll(options: SyncRequestOptions = {}): Promise<CmosSyncResult> {
    const startedAtMs = Date.now();
    const warnings: string[] = [];
    const errors: string[] = [];
    const direction = options.direction ?? this.config.direction;
    const includeContexts = options.includeContexts ?? true;
    const includeSessions = options.includeSessionEvents ?? true;

    if (!this.config.enabled || direction === 'disabled') {
      return this.buildResult(
        'disabled',
        direction,
        startedAtMs,
        [],
        this.emptySessionResult(),
        warnings,
        errors
      );
    }

    if (!options.force && this.shouldThrottle(startedAtMs)) {
      warnings.push('sync_throttled_by_frequency');
      return this.buildResult(
        'throttled',
        direction,
        startedAtMs,
        [],
        this.emptySessionResult(),
        warnings,
        errors
      );
    }

    const client = await this.createClient();
    if (!client) {
      warnings.push('cmos_database_unavailable');
      return this.buildResult(
        'unavailable',
        direction,
        startedAtMs,
        [],
        this.emptySessionResult(),
        warnings,
        errors
      );
    }

    let contexts: ContextSyncOutcome[] = [];
    let sessionResult: SessionSyncResult = this.emptySessionResult();

    try {
      if (includeContexts) {
        contexts = await this.syncContexts(client, direction, warnings);
      }
      if (includeSessions) {
        sessionResult = await this.syncSessionEvents(client, warnings);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      this.config.logger?.error?.('cmos_sync_unhandled_error', { message });
    } finally {
      client.dispose();
    }

    const finishedAtMs = Date.now();
    const status = errors.length > 0 ? 'partial' : 'completed';
    this.lastSyncAt = finishedAtMs;
    const combinedWarnings = [...warnings, ...sessionResult.warnings];
    return this.buildResult(
      status,
      direction,
      startedAtMs,
      contexts,
      sessionResult,
      combinedWarnings,
      errors,
      finishedAtMs
    );
  }

  private shouldThrottle(nowMs: number): boolean {
    if (this.config.frequency !== 'interval') {
      return false;
    }
    if (!this.lastSyncAt) {
      return false;
    }
    return nowMs - this.lastSyncAt < this.config.minIntervalMs;
  }

  private async createClient(): Promise<SQLiteClient | undefined> {
    const dbPath = this.config.databasePath ?? (await this.detectDatabasePath());
    if (!dbPath) {
      return undefined;
    }
    try {
      return this.config.sqliteClientFactory(dbPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.config.logger?.warn?.('cmos_sync_sqlite_init_failed', { message });
      return undefined;
    }
  }

  private async detectDatabasePath(): Promise<string | undefined> {
    try {
      const detection = await this.config.detector.detect(this.config.projectRoot);
      return detection.databasePath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.config.logger?.warn?.('cmos_sync_detection_failed', { message });
      return undefined;
    }
  }

  private async syncContexts(
    client: SQLiteClient,
    direction: CmosSyncDirection,
    warnings: string[]
  ): Promise<ContextSyncOutcome[]> {
    const outcomes: ContextSyncOutcome[] = [];
    for (const target of this.config.contextTargets) {
      const effectiveDirection = target.direction ?? direction;
      if (effectiveDirection === 'disabled') {
        outcomes.push({
          id: target.id,
          direction: 'disabled',
          action: 'skipped',
          source: 'none',
          updated: false,
          reason: 'context_sync_disabled',
        });
        continue;
      }
      const outcome = await this.syncContextTarget(client, target, effectiveDirection);
      if (outcome.reason && outcome.action === 'skipped') {
        warnings.push(`${target.id}:${outcome.reason}`);
      }
      outcomes.push(outcome);
    }
    return outcomes;
  }

  private async syncContextTarget(
    client: SQLiteClient,
    target: ContextSyncTarget,
    direction: CmosSyncDirection
  ): Promise<ContextSyncOutcome> {
    const resolvedPath = await this.resolveContextPath(target.filePath);
    if (!resolvedPath) {
      return this.buildContextOutcome(
        target,
        direction,
        'skipped',
        'none',
        false,
        'context_path_unresolved'
      );
    }

    const fileState = await this.readContextFile(resolvedPath);
    if (fileState.error) {
      return this.buildContextOutcome(target, direction, 'skipped', 'none', false, fileState.error);
    }

    let record: ContextRecord | undefined;
    try {
      record = client.getContext(target.id);
    } catch (error) {
      const reason = error instanceof SQLiteClientError ? error.message : String(error);
      return this.buildContextOutcome(target, direction, 'skipped', 'database', false, reason);
    }
    switch (direction) {
      case 'files_to_db':
        return this.syncFileToDatabase(client, target, resolvedPath, fileState, record);
      case 'db_to_files':
        return this.syncDatabaseToFile(target, resolvedPath, fileState, record);
      default:
        return this.syncBidirectional(client, target, resolvedPath, fileState, record);
    }
  }

  private async syncFileToDatabase(
    client: SQLiteClient,
    target: ContextSyncTarget,
    resolvedPath: string,
    fileState: FileContextState,
    record?: ContextRecord
  ): Promise<ContextSyncOutcome> {
    if (!fileState.exists || !fileState.payload) {
      return this.buildContextOutcome(
        target,
        'files_to_db',
        'skipped',
        'none',
        false,
        'context_file_missing'
      );
    }

    if (record && recordsEqual(record.content, fileState.payload)) {
      return this.buildContextOutcome(
        target,
        'files_to_db',
        'skipped',
        'file',
        false,
        'context_already_in_sync'
      );
    }

    try {
      const stored = client.setContext(target.id, fileState.payload, {
        sourcePath: target.filePath,
        snapshot: target.snapshot ?? this.config.snapshotOnSync,
      });
      return this.buildContextOutcome(
        target,
        'files_to_db',
        'write_db',
        'file',
        true,
        undefined,
        stored.updatedAt
      );
    } catch (error) {
      const reason = error instanceof SQLiteClientError ? error.message : String(error);
      return this.buildContextOutcome(target, 'files_to_db', 'skipped', 'file', false, reason);
    }
  }

  private async syncDatabaseToFile(
    target: ContextSyncTarget,
    resolvedPath: string,
    fileState: FileContextState,
    record?: ContextRecord
  ): Promise<ContextSyncOutcome> {
    if (!record) {
      return this.buildContextOutcome(
        target,
        'db_to_files',
        'skipped',
        'none',
        false,
        'context_record_missing'
      );
    }
    if (fileState.payload && recordsEqual(fileState.payload, record.content)) {
      return this.buildContextOutcome(
        target,
        'db_to_files',
        'skipped',
        'database',
        false,
        'context_already_in_sync'
      );
    }
    try {
      await this.writeContextFile(resolvedPath, record.content);
      return this.buildContextOutcome(
        target,
        'db_to_files',
        'write_file',
        'database',
        true,
        undefined,
        record.updatedAt
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.buildContextOutcome(target, 'db_to_files', 'skipped', 'database', false, reason);
    }
  }

  private async syncBidirectional(
    client: SQLiteClient,
    target: ContextSyncTarget,
    resolvedPath: string,
    fileState: FileContextState,
    record?: ContextRecord
  ): Promise<ContextSyncOutcome> {
    if (!record && fileState.exists && fileState.payload) {
      return this.syncFileToDatabase(client, target, resolvedPath, fileState, record);
    }
    if (record && (!fileState.exists || !fileState.payload)) {
      return this.syncDatabaseToFile(target, resolvedPath, fileState, record);
    }
    if (!record && !fileState.exists) {
      return this.buildContextOutcome(
        target,
        'bidirectional',
        'skipped',
        'none',
        false,
        'context_missing_everywhere'
      );
    }
    if (!record || !fileState.payload) {
      return this.buildContextOutcome(
        target,
        'bidirectional',
        'skipped',
        'none',
        false,
        'context_unreadable'
      );
    }
    if (recordsEqual(record.content, fileState.payload)) {
      return this.buildContextOutcome(
        target,
        'bidirectional',
        'skipped',
        'none',
        false,
        'context_already_in_sync'
      );
    }

    const fileTimestamp = fileState.mtimeMs ?? 0;
    const recordTimestamp = record.updatedAt ? Date.parse(record.updatedAt) : 0;

    if (fileTimestamp > recordTimestamp) {
      return this.syncFileToDatabase(client, target, resolvedPath, fileState, record);
    }
    return this.syncDatabaseToFile(target, resolvedPath, fileState, record);
  }

  private buildContextOutcome(
    target: ContextSyncTarget,
    direction: CmosSyncDirection,
    action: ContextSyncAction,
    source: 'file' | 'database' | 'none',
    updated: boolean,
    reason?: string,
    updatedAt?: string | null
  ): ContextSyncOutcome {
    return {
      id: target.id,
      filePath: target.filePath,
      direction,
      action,
      source,
      updated,
      reason,
      updatedAt,
    };
  }

  private async resolveContextPath(filePath: string): Promise<string | undefined> {
    try {
      return await resolveWorkspacePath(filePath, {
        baseDir: this.config.projectRoot,
        allowRelative: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.config.logger?.warn?.('context_path_resolution_failed', { filePath, message });
      return undefined;
    }
  }

  private async readContextFile(filePath: string): Promise<FileContextState> {
    if (!(await pathExists(filePath))) {
      return { exists: false, path: filePath };
    }
    try {
      const [raw, stats] = await Promise.all([fs.readFile(filePath, 'utf-8'), fs.stat(filePath)]);
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) {
        return { exists: true, path: filePath, error: 'context_file_not_object' };
      }
      return {
        exists: true,
        path: filePath,
        payload: parsed as Record<string, unknown>,
        mtimeMs: stats.mtimeMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { exists: true, path: filePath, error: message };
    }
  }

  private async writeContextFile(
    filePath: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const body = `${JSON.stringify(payload, null, 2)}${CANONICAL_NEWLINE}`;
    await writeFileAtomicWithBackup(filePath, body, { allowRelative: false, backupSuffix: '.bak' });
  }

  private async syncSessionEvents(
    client: SQLiteClient,
    warnings: string[]
  ): Promise<SessionSyncResult> {
    const result: SessionSyncResult = { attempted: false, inserted: 0, skipped: 0, warnings: [] };
    const sessionsPath = await this.resolveSessionsPath();
    if (!sessionsPath) {
      warnings.push('sessions_path_unresolved');
      result.warnings.push('sessions_path_unresolved');
      return result;
    }
    if (!(await pathExists(sessionsPath))) {
      return result;
    }

    const events = await this.readSessionLog(sessionsPath, result.warnings);
    if (events.length === 0) {
      return result;
    }
    result.attempted = true;

    let lastTimestamp = this.getLatestTimestamp(client);
    for (const event of events) {
      if (!event.ts || !event.mission || !event.action) {
        result.skipped += 1;
        continue;
      }
      const tsValue = Date.parse(event.ts);
      if (Number.isNaN(tsValue)) {
        result.skipped += 1;
        result.warnings.push(`invalid_timestamp:${event.ts}`);
        continue;
      }
      if (lastTimestamp && tsValue <= lastTimestamp) {
        result.skipped += 1;
        continue;
      }
      try {
        client.logSessionEvent({
          ts: event.ts,
          mission: event.mission,
          action: event.action,
          status: event.status,
          agent: event.agent,
          summary: event.summary,
          nextHint: event.next_hint,
          rawEvent: { ...event },
        });
        lastTimestamp = tsValue;
        result.inserted += 1;
        result.lastAppliedTimestamp = event.ts;
      } catch (error) {
        const message = error instanceof SQLiteClientError ? error.message : String(error);
        warnings.push(message);
        result.warnings.push(message);
        break;
      }
    }
    return result;
  }

  private getLatestTimestamp(client: SQLiteClient): number | undefined {
    try {
      const last = client.getLatestSessionEvent();
      return last ? Date.parse(last.ts) : undefined;
    } catch (error) {
      const message = error instanceof SQLiteClientError ? error.message : String(error);
      this.config.logger?.warn?.('session_event_lookup_failed', { message });
      return undefined;
    }
  }

  private async resolveSessionsPath(): Promise<string | undefined> {
    try {
      return await resolveWorkspacePath(this.config.sessionsPath, {
        baseDir: this.config.projectRoot,
        allowRelative: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.config.logger?.warn?.('sessions_path_resolution_failed', { message });
      return undefined;
    }
  }

  private async readSessionLog(
    sessionsPath: string,
    warnings: string[]
  ): Promise<MissionHistoryEvent[]> {
    try {
      const raw = await fs.readFile(sessionsPath, 'utf-8');
      const events: MissionHistoryEvent[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const parsed = JSON.parse(trimmed) as MissionHistoryEvent;
          if (parsed && parsed.ts && parsed.mission && parsed.action) {
            events.push(parsed);
          }
        } catch {
          warnings.push('session_log_parse_error');
        }
      }
      return events.sort((a, b) => Date.parse(a.ts ?? '') - Date.parse(b.ts ?? ''));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(message);
      return [];
    }
  }

  private buildResult(
    status: CmosSyncStatus,
    direction: CmosSyncDirection,
    startedAtMs: number,
    contexts: ContextSyncOutcome[],
    sessionEvents: SessionSyncResult,
    warnings: string[],
    errors: string[],
    finishedAtMs?: number
  ): CmosSyncResult {
    const finished = finishedAtMs ?? Date.now();
    return {
      ok: errors.length === 0,
      status,
      direction,
      frequency: this.config.frequency,
      contexts,
      sessionEvents,
      warnings,
      errors,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - startedAtMs,
    };
  }

  private emptySessionResult(): SessionSyncResult {
    return { attempted: false, inserted: 0, skipped: 0, warnings: [] };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

function canonicalizeRecord(record: Record<string, unknown>): string {
  return JSON.stringify(canonicalize(record));
}

function recordsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return canonicalizeRecord(a) === canonicalizeRecord(b);
}
