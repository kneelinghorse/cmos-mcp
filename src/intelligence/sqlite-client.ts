import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import type { Statement } from 'better-sqlite3';

export type MissionStatus =
  | 'Queued'
  | 'Current'
  | 'In Progress'
  | 'Blocked'
  | 'Completed'
  | 'Paused';

export interface MissionRecord {
  readonly id: string;
  readonly sprintId?: string | null;
  readonly name: string;
  readonly status: MissionStatus;
  readonly completedAt?: string | null;
  readonly notes?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}

export interface MissionCreateInput {
  readonly id: string;
  readonly name: string;
  readonly status: MissionStatus;
  readonly sprintId?: string | null;
  readonly completedAt?: string | null;
  readonly notes?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}

export interface MissionUpdateInput {
  readonly name?: string;
  readonly status?: MissionStatus;
  readonly sprintId?: string | null;
  readonly completedAt?: string | null;
  readonly notes?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}

export interface MissionQueryOptions {
  readonly status?: MissionStatus | MissionStatus[];
  readonly search?: string;
  readonly limit?: number;
  readonly includeCompleted?: boolean;
}

export interface SessionEventInput {
  readonly ts?: string | Date;
  readonly agent?: string;
  readonly mission?: string;
  readonly action?: string;
  readonly status?: string;
  readonly summary?: string;
  readonly nextHint?: string; // matches next_hint column
  readonly rawEvent?: Record<string, unknown> | string | null;
}

export interface SessionEventRecord {
  readonly id: number;
  readonly ts: string;
  readonly agent?: string;
  readonly mission?: string;
  readonly action?: string;
  readonly status?: string;
  readonly summary?: string;
  readonly nextHint?: string;
  readonly rawEvent?: Record<string, unknown> | string;
}

export interface ContextRecord {
  readonly id: string;
  readonly sourcePath: string;
  readonly content: Record<string, unknown>;
  readonly updatedAt?: string | null;
}

export interface ContextSetOptions {
  readonly sourcePath?: string | null;
  readonly sessionId?: string | null;
  readonly snapshot?: boolean;
  readonly snapshotSource?: string | null;
  readonly updatedAt?: string | Date;
}

export interface ContextSnapshotOptions {
  readonly sessionId?: string | null;
  readonly source?: string | null;
  readonly createdAt?: string | Date;
}

export type SQLiteClientErrorCode =
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INVALID_OPERATION'
  | 'NOT_FOUND'
  | 'SQLITE_ERROR';

export class SQLiteClientError extends Error {
  public readonly code: SQLiteClientErrorCode;

  constructor(message: string, code: SQLiteClientErrorCode, options?: { cause?: unknown }) {
    super(message);
    this.code = code;
    this.name = 'SQLiteClientError';
    if (options?.cause) {
      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - cause is not in the ES2020 lib definition but is supported in Node 18+
        this.cause = options.cause;
      } catch {
        // Ignore assigning cause when not supported.
      }
    }
  }
}

type BetterSqlite3Constructor = typeof import('better-sqlite3');
type BetterSqlite3Database = InstanceType<BetterSqlite3Constructor>;
type SqliteVerboseFn = (message?: unknown, ...additionalArgs: unknown[]) => void;

export interface SQLiteClientOptions {
  readonly databasePath: string;
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
  readonly timeoutMs?: number;
  readonly verbose?: SqliteVerboseFn;
  readonly driverFactory?: () => BetterSqlite3Constructor;
  readonly pool?: SQLiteConnectionPool;
}

interface MissionRow {
  id: string;
  sprint_id?: string | null;
  name: string;
  status: string;
  completed_at?: string | null;
  notes?: string | null;
  metadata?: string | null;
}

interface SessionEventRow {
  id: number;
  ts: string;
  agent?: string | null;
  mission?: string | null;
  action?: string | null;
  status?: string | null;
  summary?: string | null;
  next_hint?: string | null;
  raw_event?: string | null;
}

interface ContextRow {
  id: string;
  source_path: string;
  content: string;
  updated_at?: string | null;
}

interface ContextSnapshotHashRow {
  content_hash?: string | null;
}

interface NormalizedConnectionOptions {
  readonly readOnly: boolean;
  readonly fileMustExist: boolean;
  readonly timeoutMs: number;
  readonly verbose?: SqliteVerboseFn;
}

interface PooledConnection {
  readonly key: string;
  readonly databasePath: string;
  readonly options: NormalizedConnectionOptions;
  readonly db: BetterSqlite3Database;
  refCount: number;
}

export interface ConnectionSnapshot {
  readonly key: string;
  readonly databasePath: string;
  readonly readOnly: boolean;
  readonly refCount: number;
  readonly open: boolean;
}

function normalizeStatus(status: MissionStatus | string): MissionStatus {
  const normalized = (status || '').toString().trim().toLowerCase();
  const lookup: Record<string, MissionStatus> = {
    queued: 'Queued',
    current: 'Current',
    'in progress': 'In Progress',
    blocked: 'Blocked',
    completed: 'Completed',
    paused: 'Paused',
  };
  const result = lookup[normalized];
  if (!result) {
    const allowed = Object.values(lookup)
      .filter((value, index, arr) => arr.indexOf(value) === index)
      .join(', ');
    throw new SQLiteClientError(
      `Unsupported mission status '${status}'. Allowed values: ${allowed}.`,
      'INVALID_OPERATION'
    );
  }
  return result;
}

function serializeMetadata(metadata?: Record<string, unknown> | null): string | null {
  if (!metadata || Object.keys(metadata).length === 0) {
    return null;
  }
  return JSON.stringify(metadata);
}

function stringifyRawEvent(rawEvent?: Record<string, unknown> | string | null): string {
  if (typeof rawEvent === 'string') {
    return rawEvent;
  }
  if (!rawEvent) {
    return '{}';
  }
  try {
    return JSON.stringify(rawEvent);
  } catch {
    return '{}';
  }
}

function parseJsonObject(payload?: string | null): Record<string, unknown> | null {
  if (!payload) {
    return null;
  }
  try {
    const parsed = JSON.parse(payload);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseContextPayload(content: string, contextId: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content);
    if (!isPlainObject(parsed)) {
      throw new Error('Context content must be a JSON object.');
    }
    return parsed;
  } catch (error) {
    throw new SQLiteClientError(`Context ${contextId} contains invalid JSON.`, 'SQLITE_ERROR', {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

function stringifyContextPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, null, 2);
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

function canonicalizeContextPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(canonicalize(payload));
}

function computeContextHash(payload: Record<string, unknown>): string {
  const canonical = canonicalizeContextPayload(payload);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function mapMissionRow(row: MissionRow): MissionRecord {
  return {
    id: row.id,
    sprintId: row.sprint_id ?? null,
    name: row.name,
    status: normalizeStatus(row.status),
    completedAt: row.completed_at ?? null,
    notes: row.notes ?? null,
    metadata: parseJsonObject(row.metadata),
  };
}

function mapSessionEventRow(row: SessionEventRow): SessionEventRecord {
  const base: SessionEventRecord = {
    id: row.id,
    ts: row.ts,
    agent: row.agent ?? undefined,
    mission: row.mission ?? undefined,
    action: row.action ?? undefined,
    status: row.status ?? undefined,
    summary: row.summary ?? undefined,
    nextHint: row.next_hint ?? undefined,
  };
  if (!row.raw_event) {
    return base;
  }
  const parsed = parseJsonObject(row.raw_event);
  return parsed ? { ...base, rawEvent: parsed } : { ...base, rawEvent: row.raw_event };
}

function mapContextRow(row: ContextRow): ContextRecord {
  return {
    id: row.id,
    sourcePath: row.source_path ?? '',
    content: parseContextPayload(row.content, row.id),
    updatedAt: row.updated_at ?? null,
  };
}

let cachedDriver: BetterSqlite3Constructor | undefined;

function loadBetterSqlite3(factory?: () => BetterSqlite3Constructor): BetterSqlite3Constructor {
  if (factory) {
    try {
      return factory();
    } catch (error) {
      throw new SQLiteClientError(
        'Custom SQLite driver factory failed to initialize.',
        'DEPENDENCY_UNAVAILABLE',
        {
          cause: error instanceof Error ? error : undefined,
        }
      );
    }
  }
  const existingDriver = cachedDriver;
  if (existingDriver) {
    return existingDriver;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const required = require('better-sqlite3');
    const driver = (required.default ?? required) as BetterSqlite3Constructor;
    cachedDriver = driver;
    return driver;
  } catch (error) {
    throw new SQLiteClientError(
      'Optional dependency better-sqlite3 is required to use SQLiteClient. Install it with `npm install better-sqlite3 --save-optional`.',
      'DEPENDENCY_UNAVAILABLE',
      { cause: error instanceof Error ? error : undefined }
    );
  }
}

export class SQLiteConnectionPool {
  private static sharedInstance: SQLiteConnectionPool | undefined;

  private readonly connections = new Map<string, PooledConnection>();

  static shared(): SQLiteConnectionPool {
    if (!this.sharedInstance) {
      this.sharedInstance = new SQLiteConnectionPool();
    }
    return this.sharedInstance;
  }

  acquire(
    databasePath: string,
    options: NormalizedConnectionOptions,
    driverFactory?: () => BetterSqlite3Constructor
  ): BetterSqlite3Database {
    const absolutePath = path.resolve(databasePath);
    const key = this.buildKey(absolutePath, options.readOnly);
    let entry = this.connections.get(key);
    if (!entry) {
      const Driver = loadBetterSqlite3(driverFactory);
      const db = new Driver(absolutePath, {
        readonly: options.readOnly,
        fileMustExist: options.fileMustExist,
        timeout: options.timeoutMs,
        verbose: options.verbose,
      });
      entry = {
        key,
        databasePath: absolutePath,
        options,
        db,
        refCount: 0,
      };
      this.connections.set(key, entry);
    }
    entry.refCount += 1;
    return entry.db;
  }

  release(databasePath: string, options: NormalizedConnectionOptions): void {
    const key = this.buildKey(path.resolve(databasePath), options.readOnly);
    const entry = this.connections.get(key);
    if (!entry) {
      return;
    }
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      entry.db.close();
      this.connections.delete(key);
    }
  }

  drain(): void {
    for (const entry of this.connections.values()) {
      entry.db.close();
    }
    this.connections.clear();
  }

  snapshot(): ConnectionSnapshot[] {
    return Array.from(this.connections.values()).map((entry) => ({
      key: entry.key,
      databasePath: entry.databasePath,
      readOnly: entry.options.readOnly,
      refCount: entry.refCount,
      open: entry.db.open,
    }));
  }

  size(): number {
    return this.connections.size;
  }

  private buildKey(databasePath: string, readOnly: boolean): string {
    return `${databasePath}::${readOnly ? 'ro' : 'rw'}`;
  }
}

export class SQLiteClient {
  private readonly options: SQLiteClientOptions;

  private readonly pool: SQLiteConnectionPool;

  private readonly connectionOptions: NormalizedConnectionOptions;

  private connection: BetterSqlite3Database | undefined;

  private disposed = false;

  constructor(options: SQLiteClientOptions | string) {
    if (typeof options === 'string') {
      this.options = { databasePath: options };
    } else {
      this.options = options;
    }
    const databasePath = this.options.databasePath?.trim();
    if (!databasePath) {
      throw new SQLiteClientError(
        'A database path is required to instantiate SQLiteClient.',
        'INVALID_OPERATION'
      );
    }
    this.options = {
      ...this.options,
      databasePath: path.resolve(databasePath),
    };
    this.pool = this.options.pool ?? SQLiteConnectionPool.shared();
    this.connectionOptions = {
      readOnly: this.options.readonly ?? false,
      fileMustExist: this.options.fileMustExist ?? true,
      timeoutMs: this.options.timeoutMs ?? 1_000,
      verbose: this.options.verbose,
    };
    if (!this.connectionOptions.fileMustExist && !fs.existsSync(this.options.databasePath)) {
      fs.mkdirSync(path.dirname(this.options.databasePath), { recursive: true });
    }
  }

  dispose(): void {
    if (this.connection) {
      this.pool.release(this.options.databasePath, this.connectionOptions);
      this.connection = undefined;
    }
    this.disposed = true;
  }

  getMission(id: string): MissionRecord | undefined {
    this.ensureActive();
    const statement = this.prepare(
      'SELECT id, sprint_id, name, status, completed_at, notes, metadata FROM missions WHERE id = :id'
    );
    const row = statement.get({ id }) as MissionRow | undefined;
    return row ? mapMissionRow(row) : undefined;
  }

  listMissions(options?: MissionQueryOptions): MissionRecord[] {
    this.ensureActive();
    const filters: string[] = [];
    const params: Record<string, unknown> = {};
    if (options?.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      const normalized = statuses.map((status, index) => {
        const token = `status${index}`;
        params[token] = normalizeStatus(status);
        return `status = :${token}`;
      });
      filters.push(`(${normalized.join(' OR ')})`);
    }
    const search = options?.search?.trim();
    if (search) {
      params.search = `%${search}%`;
      filters.push('(id LIKE :search OR name LIKE :search)');
    }
    if (!options?.includeCompleted && !options?.status) {
      filters.push("status != 'Completed'");
    }
    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const limitValue = options?.limit;
    const hasLimit = typeof limitValue === 'number';
    const limitClause = hasLimit ? 'LIMIT :limit' : '';
    if (hasLimit) {
      const numericLimit = Number(limitValue);
      if (!Number.isFinite(numericLimit) || numericLimit < 1) {
        throw new SQLiteClientError(
          'limit must be a positive integer when provided.',
          'INVALID_OPERATION'
        );
      }
      params.limit = Math.floor(numericLimit);
    }
    const statement = this.prepare(
      `SELECT id, sprint_id, name, status, completed_at, notes, metadata FROM missions ${whereClause} ORDER BY id ${limitClause}`
    );
    const rows = statement.all(params) as MissionRow[];
    return rows.map(mapMissionRow);
  }

  createMission(input: MissionCreateInput): MissionRecord {
    this.ensureActive();
    const payload: MissionRow = {
      id: input.id,
      sprint_id: input.sprintId ?? null,
      name: input.name,
      status: normalizeStatus(input.status),
      completed_at: input.completedAt ?? null,
      notes: input.notes ?? null,
      metadata: serializeMetadata(input.metadata),
    };
    const statement = this.prepare(
      'INSERT INTO missions (id, sprint_id, name, status, completed_at, notes, metadata) VALUES (:id, :sprint_id, :name, :status, :completed_at, :notes, :metadata)'
    );
    try {
      statement.run(payload);
    } catch (error) {
      throw this.wrapSqliteError('Failed to insert mission record.', error);
    }
    const record = this.getMission(input.id);
    if (!record) {
      throw new SQLiteClientError(`Mission ${input.id} was not persisted.`, 'SQLITE_ERROR');
    }
    return record;
  }

  updateMission(id: string, updates: MissionUpdateInput): MissionRecord {
    this.ensureActive();
    const assignments: string[] = [];
    const params: Record<string, unknown> = { id };
    if (typeof updates.name === 'string') {
      assignments.push('name = :name');
      params.name = updates.name;
    }
    if (updates.status) {
      assignments.push('status = :status');
      params.status = normalizeStatus(updates.status);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'sprintId')) {
      assignments.push('sprint_id = :sprint_id');
      params.sprint_id = updates.sprintId ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'completedAt')) {
      assignments.push('completed_at = :completed_at');
      params.completed_at = updates.completedAt ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'notes')) {
      assignments.push('notes = :notes');
      params.notes = updates.notes ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'metadata')) {
      assignments.push('metadata = :metadata');
      params.metadata = serializeMetadata(updates.metadata ?? null);
    }
    if (!assignments.length) {
      throw new SQLiteClientError(
        'At least one field is required to update a mission record.',
        'INVALID_OPERATION'
      );
    }
    const statement = this.prepare(`UPDATE missions SET ${assignments.join(', ')} WHERE id = :id`);
    const result = statement.run(params);
    if (result.changes === 0) {
      throw new SQLiteClientError(`Mission ${id} does not exist.`, 'NOT_FOUND');
    }
    const record = this.getMission(id);
    if (!record) {
      throw new SQLiteClientError(
        `Mission ${id} could not be reloaded after update.`,
        'SQLITE_ERROR'
      );
    }
    return record;
  }

  deleteMission(id: string): boolean {
    this.ensureActive();
    const statement = this.prepare('DELETE FROM missions WHERE id = :id');
    try {
      const result = statement.run({ id });
      return result.changes > 0;
    } catch (error) {
      throw this.wrapSqliteError('Failed to delete mission record.', error);
    }
  }

  getContext(id: string): ContextRecord | undefined {
    this.ensureActive();
    const statement = this.prepare(
      'SELECT id, source_path, content, updated_at FROM contexts WHERE id = :id'
    );
    const row = statement.get({ id }) as ContextRow | undefined;
    return row ? mapContextRow(row) : undefined;
  }

  setContext(
    id: string,
    payload: Record<string, unknown>,
    options: ContextSetOptions = {}
  ): ContextRecord {
    this.ensureActive();
    const existing = options.sourcePath === undefined ? this.getContext(id) : undefined;
    const resolvedSourcePath =
      options.sourcePath === undefined ? (existing?.sourcePath ?? '') : (options.sourcePath ?? '');
    const timestamp = this.normalizeTimestamp(options.updatedAt);
    const statement = this.prepare(
      'INSERT OR REPLACE INTO contexts (id, source_path, content, updated_at) VALUES (:id, :source_path, :content, :updated_at)'
    );
    try {
      statement.run({
        id,
        source_path: resolvedSourcePath,
        content: stringifyContextPayload(payload),
        updated_at: timestamp,
      });
    } catch (error) {
      throw this.wrapSqliteError('Failed to upsert context record.', error);
    }

    if (options.snapshot ?? true) {
      this.addContextSnapshot(id, payload, {
        sessionId: options.sessionId ?? null,
        source: options.snapshotSource ?? resolvedSourcePath,
        createdAt: timestamp,
      });
    }

    const record = this.getContext(id);
    if (!record) {
      throw new SQLiteClientError(
        `Context ${id} could not be reloaded after upsert.`,
        'SQLITE_ERROR'
      );
    }
    return record;
  }

  addContextSnapshot(
    id: string,
    payload: Record<string, unknown>,
    options: ContextSnapshotOptions = {}
  ): boolean {
    this.ensureActive();
    const hash = computeContextHash(payload);
    const existing = this.prepare(
      'SELECT content_hash FROM context_snapshots WHERE context_id = :context_id ORDER BY created_at DESC LIMIT 1'
    );
    const last = existing.get({ context_id: id }) as ContextSnapshotHashRow | undefined;
    if (last?.content_hash === hash) {
      return false;
    }

    const createdAt = this.normalizeTimestamp(options.createdAt);
    const insert = this.prepare(
      'INSERT INTO context_snapshots (context_id, session_id, source, content_hash, content, created_at) VALUES (:context_id, :session_id, :source, :content_hash, :content, :created_at)'
    );
    try {
      insert.run({
        context_id: id,
        session_id: options.sessionId ?? null,
        source: options.source ?? null,
        content_hash: hash,
        content: stringifyContextPayload(payload),
        created_at: createdAt,
      });
      return true;
    } catch (error) {
      throw this.wrapSqliteError('Failed to insert context snapshot.', error);
    }
  }

  logSessionEvent(event: SessionEventInput): SessionEventRecord {
    this.ensureActive();
    const payload: SessionEventInput = {
      ...event,
      ts: this.normalizeTimestamp(event.ts),
    };
    const statement = this.prepare(
      'INSERT INTO session_events (ts, agent, mission, action, status, summary, next_hint, raw_event) VALUES (:ts, :agent, :mission, :action, :status, :summary, :next_hint, :raw_event)'
    );
    const params = {
      ts: payload.ts,
      agent: payload.agent ?? null,
      mission: payload.mission ?? null,
      action: payload.action ?? null,
      status: payload.status ?? null,
      summary: payload.summary ?? null,
      next_hint: payload.nextHint ?? null,
      raw_event: stringifyRawEvent(payload.rawEvent ?? null),
    };
    try {
      const result = statement.run(params);
      return this.getSessionEventById(Number(result.lastInsertRowid));
    } catch (error) {
      throw this.wrapSqliteError('Failed to log session event.', error);
    }
  }

  getRecentSessionEvents(limit = 20): SessionEventRecord[] {
    this.ensureActive();
    const statement = this.prepare(
      'SELECT id, ts, agent, mission, action, status, summary, next_hint, raw_event FROM session_events ORDER BY id DESC LIMIT :limit'
    );
    const rows = statement.all({ limit }) as SessionEventRow[];
    return rows.map(mapSessionEventRow);
  }

  getLatestSessionEvent(): SessionEventRecord | undefined {
    this.ensureActive();
    const statement = this.prepare(
      'SELECT id, ts, agent, mission, action, status, summary, next_hint, raw_event FROM session_events ORDER BY ts DESC, id DESC LIMIT 1'
    );
    const row = statement.get() as SessionEventRow | undefined;
    return row ? mapSessionEventRow(row) : undefined;
  }

  withTransaction<T>(handler: (client: this) => T): T {
    this.ensureActive();
    const db = this.getConnection();
    const run = db.transaction(() => handler(this));
    try {
      return run();
    } catch (error) {
      throw this.wrapSqliteError('Transaction failed.', error);
    }
  }

  private getSessionEventById(id: number): SessionEventRecord {
    const statement = this.prepare(
      'SELECT id, ts, agent, mission, action, status, summary, next_hint, raw_event FROM session_events WHERE id = :id'
    );
    const row = statement.get({ id }) as SessionEventRow | undefined;
    if (!row) {
      throw new SQLiteClientError(
        `Session event ${id} could not be found after insert.`,
        'SQLITE_ERROR'
      );
    }
    return mapSessionEventRow(row);
  }

  private normalizeTimestamp(value?: string | Date): string {
    if (!value) {
      return new Date().toISOString();
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) {
      throw new SQLiteClientError(`Invalid timestamp value: ${value}`, 'INVALID_OPERATION');
    }
    return dt.toISOString();
  }

  private ensureActive(): void {
    if (this.disposed) {
      throw new SQLiteClientError(
        'SQLiteClient was disposed and can no longer be used.',
        'INVALID_OPERATION'
      );
    }
  }

  private getConnection(): BetterSqlite3Database {
    if (!this.connection) {
      this.connection = this.pool.acquire(
        this.options.databasePath,
        this.connectionOptions,
        this.options.driverFactory
      );
    }
    return this.connection;
  }

  private prepare(sql: string): Statement {
    try {
      return this.getConnection().prepare(sql);
    } catch (error) {
      throw this.wrapSqliteError(`Failed to prepare statement: ${sql}`, error);
    }
  }

  private wrapSqliteError(message: string, error: unknown): SQLiteClientError {
    if (error instanceof SQLiteClientError) {
      return error;
    }
    if (error instanceof Error) {
      return new SQLiteClientError(message, 'SQLITE_ERROR', { cause: error });
    }
    return new SQLiteClientError(message, 'SQLITE_ERROR');
  }
}
