// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m01 — the non-hook verbs: review, relevant, capture, session, ambient, init and profile. Exit 0
// ABOUTME: on success, 1 on a refusal, a failure or a usage error (never 2); one stderr line says why.

import Database from 'better-sqlite3';
import * as path from 'path';

import {
  AMBIENT_METADATA_KEY,
  AMBIENT_MODES,
  parseArgs,
  readAmbient,
  resolveCliProject,
  type AmbientMode,
  type CliIo,
  type CliResolution,
} from './core';
import { previewText } from '../tools/cmos/text-preview';
import { observeCliResult, observeInjected, observeRelevantIds } from './telemetry';
import { captureToolCall } from '../tools/cmos/tool-call-context';

/** A hand-run write names its harness session; the CLI never opens a session per process (fork 8). */
export const NO_SESSION_REMEDY =
  'name the harness session with --session-id <id>, or write through the MCP tools ' +
  '(cmos_session, cmos_decisions); the CLI never opens a session of its own';

type Store = Extract<CliResolution, { kind: 'store' }>;

function requireStore(verb: string, resolution: CliResolution, io: CliIo): Store | null {
  switch (resolution.kind) {
    case 'store':
      return resolution;
    case 'explicit-missing':
      io.stderr(`cmos-mcp ${verb}: no CMOS project at ${resolution.dir}.`);
      return null;
    case 'store-missing':
      io.stderr(`cmos-mcp ${verb}: the CMOS store is missing: ${resolution.dbPath}.`);
      return null;
    case 'none':
      io.stderr(
        `cmos-mcp ${verb}: no CMOS project encloses ${resolution.workingDir}; pass --project-root.`
      );
      return null;
  }
}

export async function runCommand(
  verb: string,
  argv: readonly string[],
  io: CliIo
): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const resolution = resolveCliProject({
    projectRootArg: flags['project-root'],
    env: io.env,
    cwd: io.cwd,
  });
  switch (verb) {
    case 'review':
      return review(resolution, flags, io);
    case 'relevant':
      return (await captureToolCall('read', () => relevant(resolution, flags, io))).value;
    case 'capture':
      return capture(resolution, flags, io);
    case 'session':
      return session(resolution, positional, flags, io);
    case 'ambient':
      return ambient(resolution, positional, io);
    case 'init':
      return init(flags, io);
    case 'profile':
      return profile(positional, io);
    default:
      io.stderr(`cmos-mcp: unknown verb ${verb}.`);
      return 1;
  }
}

async function review(
  resolution: CliResolution,
  flags: Readonly<Record<string, string>>,
  io: CliIo
): Promise<number> {
  const store = requireStore('review', resolution, io);
  if (!store) return 1;
  const digest = await import('./digest');
  const text = await digest.buildDigest(store.projectRoot, io);
  if (text === null) {
    io.stderr('cmos-mcp review: the digest could not be built.');
    return 1;
  }
  io.stdout(flags.format === 'json' ? `${JSON.stringify({ digest: text })}\n` : `${text}\n`);
  observeInjected(io, text);
  return 0;
}

/** One match, as `relevant` prints it. */
export interface RelevantItem {
  readonly kind: 'decision' | 'learning';
  readonly id: number;
  readonly status: string;
  /** A preview of at most 300 characters. */
  readonly text: string;
  readonly truncated: boolean;
}

/** Words of three letters or more, quoted for FTS5 and joined with OR. Null when none. */
export function ftsQuery(text: string): string | null {
  const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 24);
  return words.length > 0 ? words.map((w) => `"${w}"`).join(' OR ') : null;
}

/**
 * The keyword arm only (FTS5 bm25), over decisions and learnings, superseded rows dropped inside
 * the query. Read-only. A store without an index answers with nothing.
 */
export function keywordRelevant(dbPath: string, query: string, limit: number): RelevantItem[] {
  const match = ftsQuery(query);
  if (!match) return [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 300');
    const tables = new Set(
      (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('decisions_fts', 'learnings_fts')"
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
    );
    const rows: Array<RelevantItem & { score: number }> = [];
    const collect = (kind: RelevantItem['kind'], sql: string): void => {
      for (const row of db.prepare(sql).all(match, limit) as Array<{
        id: number;
        text: string;
        status: string | null;
        score: number;
      }>) {
        const preview = previewText(row.text ?? '');
        rows.push({
          kind,
          id: row.id,
          status: row.status ?? 'active',
          text: preview.preview,
          truncated: preview.truncated,
          score: row.score,
        });
      }
    };
    if (tables.has('decisions_fts')) {
      collect(
        'decision',
        `SELECT d.id AS id, d.decision_text AS text, d.status AS status, bm25(decisions_fts) AS score
           FROM decisions_fts JOIN strategic_decisions d ON d.id = decisions_fts.rowid
          WHERE decisions_fts MATCH ? AND COALESCE(d.status, 'active') <> 'superseded'
          ORDER BY score LIMIT ?`
      );
    }
    if (tables.has('learnings_fts')) {
      collect(
        'learning',
        `SELECT l.id AS id, l.content AS text, l.status AS status, bm25(learnings_fts) AS score
           FROM learnings_fts JOIN learnings l ON l.id = learnings_fts.rowid
          WHERE learnings_fts MATCH ? AND COALESCE(l.status, 'active') <> 'superseded'
          ORDER BY score LIMIT ?`
      );
    }
    return rows
      .sort((a, b) => a.score - b.score || a.kind.localeCompare(b.kind) || b.id - a.id)
      .slice(0, limit)
      .map(({ score: _score, ...item }) => item);
  } finally {
    db.close();
  }
}

async function relevant(
  resolution: CliResolution,
  flags: Readonly<Record<string, string>>,
  io: CliIo
): Promise<number> {
  const query = flags.query?.trim();
  if (!query || query === 'true') {
    io.stderr('cmos-mcp relevant: pass --query <text>.');
    return 1;
  }
  const store = requireStore('relevant', resolution, io);
  if (!store) return 1;
  const limit = Math.min(20, Math.max(1, Number.parseInt(flags.limit ?? '5', 10) || 5));
  const items = keywordRelevant(store.dbPath, query, limit);
  observeRelevantIds(io, store.dbPath, items);
  if (flags.format === 'json') {
    io.stdout(`${JSON.stringify({ items })}\n`);
    return 0;
  }
  if (items.length === 0) return 0;
  io.stdout(
    `${items
      .map((item) => `#${item.id} ${item.kind} [${item.status}] — ${item.text}`)
      .join('\n')}\n` +
      'Read one in full with cmos_decisions(action="show") or cmos_learnings(action="show").\n'
  );
  return 0;
}

async function capture(
  resolution: CliResolution,
  flags: Readonly<Record<string, string>>,
  io: CliIo
): Promise<number> {
  const rawSessionId = flags['session-id'];
  if (!rawSessionId || rawSessionId === 'true') {
    io.stderr(`cmos-mcp capture: ${NO_SESSION_REMEDY}.`);
    return 1;
  }
  const category = flags.category;
  const content = flags.content;
  if (!category || !content || category === 'true' || content === 'true') {
    io.stderr('cmos-mcp capture: pass --category <c> and --content <text>.');
    return 1;
  }
  const store = requireStore('capture', resolution, io);
  if (!store) return 1;
  const owner = await import('../tools/cmos/session-owner');
  const context = await import('../tools/cmos/tool-call-context');
  const sessions = await import('../tools/cmos/cmos-session');
  owner.setExternalSessionOwner(rawSessionId);
  const result = await context.captureToolCall('write', () =>
    sessions.cmosSession({
      action: 'capture',
      category: category as 'decision' | 'learning' | 'constraint' | 'context' | 'next-step',
      content,
      ...(flags.mission && flags.mission !== 'true' ? { missionId: flags.mission } : {}),
      projectRoot: store.projectRoot,
    })
  );
  observeCliResult(io, 'cmos_session', { action: 'capture', category, content }, result.value);
  io.stdout(`${sessions.formatSessionForLLM('capture', result.value)}\n`);
  return result.value.success ? 0 : 1;
}

async function session(
  resolution: CliResolution,
  positional: readonly string[],
  flags: Readonly<Record<string, string>>,
  io: CliIo
): Promise<number> {
  const action = positional[0];
  if (action !== 'ensure' && action !== 'close') {
    io.stderr('cmos-mcp session: ensure or close, with --session-id <id>.');
    return 1;
  }
  const rawSessionId = flags['session-id'];
  if (!rawSessionId || rawSessionId === 'true') {
    io.stderr(`cmos-mcp session ${action}: ${NO_SESSION_REMEDY}.`);
    return 1;
  }
  const store = requireStore(`session ${action}`, resolution, io);
  if (!store) return 1;
  const ops = await import('./harness-ops');
  if (action === 'ensure') {
    const ensured = await ops.ensureHarnessSession(store.projectRoot, rawSessionId);
    if (!ensured) {
      io.stderr('cmos-mcp session ensure: no session could be opened in this store.');
      return 1;
    }
    io.stdout(`${ensured.sessionId}${ensured.opened ? ' (opened)' : ''}\n`);
    return 0;
  }
  const receipts = await ops.endHarnessSession(store.projectRoot, rawSessionId);
  const failed = receipts.find((receipt) => !receipt.closed);
  if (failed) {
    io.stderr(
      `cmos-mcp session close: ${failed.sessionId}: ${failed.error ?? 'the close failed'}.`
    );
    return 1;
  }
  io.stdout(
    receipts.length > 0
      ? `${receipts.map((receipt) => `${receipt.sessionId} closed`).join('\n')}\n`
      : 'no open session for this harness session\n'
  );
  return 0;
}

async function ambient(
  resolution: CliResolution,
  positional: readonly string[],
  io: CliIo
): Promise<number> {
  const mode = positional[0] as AmbientMode | undefined;
  if (mode !== undefined && !AMBIENT_MODES.includes(mode)) {
    io.stderr(`cmos-mcp ambient: ${AMBIENT_MODES.join(', ')}, or nothing to show the setting.`);
    return 1;
  }
  if (resolution.kind === 'store-missing') {
    io.stderr(`cmos-mcp ambient: the CMOS store is missing: ${resolution.dbPath}.`);
    return 1;
  }
  if (resolution.kind !== 'store') {
    // No store: the only setting is whether this repository is offered CMOS at session start.
    const start = await import('./session-start');
    const harness = await import('../tools/cmos/harness-session');
    const dir = resolution.kind === 'none' ? resolution.workingDir : resolution.dir;
    const repo = start.gitWorkTreeRoot(dir);
    if (!repo) {
      io.stderr('cmos-mcp ambient: no CMOS project and no git repository here.');
      return 1;
    }
    if (mode === undefined) {
      io.stdout(`${harness.isDeclined(repo, io.env) ? 'declined' : 'offered'} (no CMOS record)\n`);
      return 0;
    }
    if (mode === 'digest-off') {
      io.stderr('cmos-mcp ambient digest-off: this repository has no CMOS record.');
      return 1;
    }
    harness.setDeclined(repo, mode === 'off', io.env);
    io.stdout(
      mode === 'off' ? 'CMOS will not be offered here.\n' : 'CMOS will be offered here again.\n'
    );
    return 0;
  }
  if (mode === undefined) {
    const effective = readAmbient(resolution.dbPath, io.env);
    const fromEnv = (io.env.CMOS_AMBIENT ?? '').trim() !== '';
    io.stdout(`${effective}${fromEnv ? ' (CMOS_AMBIENT, this session only)' : ''}\n`);
    return 0;
  }
  const { withClientAsync } = await import('../tools/cmos/client');
  const { createError, createSuccess } = await import('../tools/cmos/errors');
  const { checkWrite } = await import('../tools/cmos/write-guard');
  const written = await withClientAsync(
    async (client) => {
      const failures: string[] = [];
      const ok = checkWrite(
        client.execute('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [
          AMBIENT_METADATA_KEY,
          mode,
        ]),
        failures,
        'metadata.ambient'
      );
      // The line names the level too, so the refresh is handed the store's (s93-m12).
      const tier = client.getOne<{ value: string }>(
        "SELECT value FROM metadata WHERE key = 'project_type'",
        []
      );
      return ok
        ? createSuccess(tier.success ? (tier.data?.value ?? null) : null)
        : createError<string | null>({
            code: 'DB_QUERY_FAILED',
            message: failures[0] ?? 'the setting was not written',
          });
    },
    { projectRoot: resolution.projectRoot, registerProject: false }
  );
  observeCliResult(io, 'ambient', { action: mode }, written);
  if (!written.success) {
    io.stderr(`cmos-mcp ambient: ${written.error?.message ?? 'the setting was not written'}.`);
    return 1;
  }
  // s93-m12: the agents file's CMOS line names the hooks' state, so it follows the setting.
  const { describeCmosLineRefresh, levelOfTier, refreshCmosLine } =
    await import('../tools/cmos/rules-files');
  const note = describeCmosLineRefresh(
    refreshCmosLine(resolution.projectRoot, {
      level: levelOfTier(written.data),
      ambient: mode,
    })
  );
  io.stdout(`${mode}\n${note ? `${note}\n` : ''}`);
  return 0;
}

/**
 * s93-m12: `init` starts a record in a folder: the store, AGENTS.md and CLAUDE.md, through the same
 * code as `cmos_project(action="init")`, so both write the same files. The folder is
 * `--project-root` or the working directory, never a guess further up. A contextless folder is
 * refused; so is a working directory inside another project (a subfolder is rarely meant), while a
 * folder named with --project-root is taken as meant, as the MCP tool takes it. `--level` is the
 * answer to the init question (no answer keeps an existing project's level, and makes a new one a
 * Ledger unless its folder's agents file already names a level); `--no-hooks` adds the hook-less
 * block for a harness without hooks. The output names the level and where it came from.
 */
async function init(flags: Readonly<Record<string, string>>, io: CliIo): Promise<number> {
  const rules = await import('../tools/cmos/rules-files');
  const level = flags.level?.toLowerCase();
  if (level !== undefined && !(rules.PROJECT_LEVELS as readonly string[]).includes(level)) {
    io.stderr(`cmos-mcp init: --level is ${rules.PROJECT_LEVELS.join(', ')}.`);
    return 1;
  }
  const named = flags['project-root'];
  const target = path.resolve(named && named !== 'true' ? named : io.cwd);
  const policy = await import('../intelligence/resolution-policy');
  if (policy.isContextlessDirectory(target)) {
    io.stderr(`cmos-mcp init: ${target} is not a project folder; pass --project-root.`);
    return 1;
  }
  const explicit = Boolean(named && named !== 'true');
  const enclosing = explicit ? null : policy.findEnclosingStore(target);
  if (enclosing && !policy.isSameDirectory(enclosing.root, target)) {
    io.stderr(
      `cmos-mcp init: ${target} is inside the CMOS project at ${enclosing.root}; run init there, or name this folder with --project-root to start a separate record in it.`
    );
    return 1;
  }
  const { cmosProjectInit } = await import('../tools/cmos/cmos-project-init');
  const result = await cmosProjectInit(
    {
      projectRoot: target,
      ...(flags.name && flags.name !== 'true' ? { projectName: flags.name } : {}),
      ...(level ? { projectType: rules.LEVEL_TIERS[level as keyof typeof rules.LEVEL_TIERS] } : {}),
    },
    { hooks: flags['no-hooks'] !== 'true' }
  );
  observeCliResult(io, 'cmos_project', { action: 'init' }, result);
  if (!result.success || !result.data) {
    io.stderr(`cmos-mcp init: ${result.error?.message ?? 'init failed'}`);
    return 1;
  }
  const rulesFiles = result.data.created.files
    .filter((file) => file.startsWith('..'))
    .map((file) => path.basename(file));
  const levelFrom = {
    passed: 'as asked',
    stored: 'kept from the store',
    'agents-file': "from the agents file's CMOS line",
    default: 'the default for a new project; --level changes it',
  }[result.data.levelSource];
  io.stdout(
    `CMOS record ${result.data.isNewProject ? 'started' : 'already here'} at ${target}.` +
      (rulesFiles.length > 0 ? ` Wrote ${rulesFiles.join(' and ')}.` : '') +
      `\nLevel: ${rules.levelName(result.data.level)} (${levelFrom}).\n` +
      (result.warnings ?? []).map((warning) => `${warning}\n`).join('')
  );
  return 0;
}

/** s93-m12: `profile show` prints the operator profile every project's digest reads. */
async function profile(positional: readonly string[], io: CliIo): Promise<number> {
  if (positional[0] !== 'show') {
    io.stderr('cmos-mcp profile: show prints the operator profile.');
    return 1;
  }
  const { PROFILE_CAP_CHARS, profilePath, readProfile } =
    await import('../tools/cmos/operator-profile');
  const current = readProfile(io.env);
  if (!current) {
    io.stdout(
      `No operator profile yet. It lives at ${profilePath(io.env)}: the operator writes it, and ` +
        'agents add lines only through drafts the operator approved.\n'
    );
    return 0;
  }
  io.stdout(
    `${current.text.trimEnd()}\n\n(${current.path}: ${current.chars} of ${PROFILE_CAP_CHARS} characters` +
      `${current.overCap ? ', over the cap' : ''})\n`
  );
  return 0;
}
