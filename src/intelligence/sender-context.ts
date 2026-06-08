// ABOUTME: resolveSenderContext — the single audited boundary that answers
// ABOUTME: "which local project is calling this tool?" for Sprint 53 attribution rebuild.

/**
 * Sender Context Resolution (Sprint 53 m01)
 *
 * Every Sprint 32 / Sprint 52 / Sprint 53 recurrence of cross-project mis-attribution
 * traces back to two root causes:
 *
 *   (a) the MCP server had two competing resolvers (`resolveCmosProjectRoot` and
 *       `resolveProjectRootEnhanced`) that disagreed about priority order, and
 *   (b) one of them silently fell back to the `CMOS_PROJECT_ROOT` env var when no
 *       caller-provided root was present, causing every downstream project to be
 *       attributed as cmos-mcp's own project.
 *
 * This module replaces both resolvers with one priority chain and a fail-closed
 * contract: when the server cannot authoritatively identify the caller, we throw
 * `SenderResolutionError` with a full candidate trace rather than guessing.
 *
 * Priority (highest → lowest):
 *   1. Explicit `explicitProjectRoot` parameter
 *   2. MCP client roots advertised via `roots/list`
 *   3. Auto-discovery from cwd (with cwd-vs-SERVER_INSTALL_ROOT guard)
 *   4. Registry singleton — only when exactly ONE project is registered
 *   5. Throw `SenderResolutionError`
 *
 * The `CMOS_PROJECT_ROOT` env var is NOT consulted here — it is retained only as a
 * bootstrap hint at `src/index.ts:17` so the server can locate its own `.env`. See
 * sprint-53-attribution-rebuild.md for the full rationale.
 *
 * No caller-wiring happens in this module — m01 ships the pure resolver + tests.
 * The dispatcher refactor at `src/index.ts` is m02.
 *
 * @module intelligence/sender-context
 */

import path from 'path';

import { backfillUnknownCmosAddress, getProjectIdentity } from '../tools/cmos/project-identity';
import type { CmosDatabaseClient } from '../tools/cmos/client';
import { withClientAsync } from '../tools/cmos/client';
import { CmosDetector } from './cmos-detector';
import { ProjectRegistry } from './project-registry';

/**
 * The directory where the compiled server binary lives. Computed at module-import time
 * via `path.resolve(__dirname, '../..')` — i.e. one level above `dist/intelligence`.
 *
 * Exported so the cwd-vs-server-install guard can be tested with overrides and so
 * callers can emit a startup diagnostic (Sprint 53 m04). Consumers should NEVER
 * pin tool attribution to this path — it is the one thing we are explicitly trying
 * to prevent becoming an implicit sender.
 */
export const SERVER_INSTALL_ROOT = path.resolve(__dirname, '..', '..');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Candidate source labels, ordered highest-to-lowest priority. */
export type SenderResolutionSource = 'explicit' | 'mcp-roots' | 'cwd' | 'registry-singleton';

/**
 * One step in the priority chain. Every attempted source is recorded, whether
 * accepted or rejected, so `SenderResolutionError.candidates` gives operators a
 * complete audit trail (echoed by `cmos_message(action='whoami')` in m03).
 */
export interface ResolutionCandidate {
  readonly source: SenderResolutionSource;
  readonly projectRoot?: string;
  readonly accepted: boolean;
  readonly rejectReason?: string;
}

/**
 * Output of `validateProject` — the fact-gathering layer used by the resolver.
 *
 * `hasValidSenderIdentity` encodes the fail-closed rule: a project is only a
 * valid implicit sender when it owns a UUID `dashboard_project_id` AND a non-stale
 * canonical `cmos_address` (neither empty nor `cmos://unknown/*`). A one-shot
 * heal via `backfillUnknownCmosAddress` is attempted before rejection.
 */
export interface ValidateProjectResult {
  readonly hasDatabase: boolean;
  readonly dashboardProjectId: string | null;
  readonly cmosAddress: string | null;
  readonly healed?: { previous: string; next: string };
  readonly hasValidSenderIdentity: boolean;
  readonly rejectReason?: string;
}

/** Resolved sender identity plus the full audit trail. */
export interface SenderContext {
  readonly projectRoot: string;
  readonly source: SenderResolutionSource;
  readonly dashboardProjectId: string | null;
  readonly cmosAddress: string | null;
  readonly healed?: { previous: string; next: string };
  readonly candidates: ReadonlyArray<ResolutionCandidate>;
}

/**
 * Options for `resolveSenderContext`.
 *
 * The `*Override` fields exist for tests; production callers only need
 * `explicitProjectRoot`, `mcpRoots`, and `requireSenderIdentity`.
 */
export interface ResolveSenderContextOptions {
  /** Caller-supplied project root (step 1). */
  readonly explicitProjectRoot?: string;
  /** MCP client roots from `server.listRoots()` (step 2). Paths, not `file://` URIs. */
  readonly mcpRoots?: readonly string[];
  /**
   * Whether the caller needs a validated sender identity (UUID + canonical address)
   * to proceed. Defaults to `true` — the safe choice for any tool that mutates
   * dashboard state. Set `false` only for read-only local-DB ops that just need
   * a project root.
   */
  readonly requireSenderIdentity?: boolean;
  readonly cwdOverride?: string;
  readonly registryOverride?: ProjectRegistry;
  readonly serverInstallRootOverride?: string;
}

/**
 * Thrown when no candidate in the priority chain produced a project that satisfied
 * the caller's acceptance bar. Carries the full candidate trace for operator
 * debugging — exposed via `cmos_message(action='whoami')` in m03.
 */
export class SenderResolutionError extends Error {
  readonly code: string;
  readonly candidates: ReadonlyArray<ResolutionCandidate>;

  constructor(
    message: string,
    candidates: ReadonlyArray<ResolutionCandidate>,
    code = 'SENDER_UNRESOLVABLE'
  ) {
    super(message);
    this.name = 'SenderResolutionError';
    this.code = code;
    this.candidates = candidates;
  }
}

/**
 * Read the sender-identity facts for a given project root.
 *
 * Opens the CMOS SQLite for `projectRoot` (via `withClientAsync({ projectRoot })`,
 * which bypasses the env-based fallback because the projectRoot is explicit),
 * reads `metadata.dashboard_project_id` and `project_identity.cmos_address`, and
 * attempts a one-shot heal when the address is `cmos://unknown/*` and an owner
 * exists in metadata.
 *
 * Returns the gathered facts plus `hasValidSenderIdentity`, the resolver-facing
 * acceptance verdict.
 */
export async function validateProject(
  projectRoot: string,
  options: { heal?: boolean } = {}
): Promise<ValidateProjectResult> {
  const { heal = true } = options;
  const resolved = path.resolve(projectRoot);

  const detector = CmosDetector.getInstance();
  const detection = await detector.detect(resolved, { forceRefresh: true });
  if (!detection.hasDatabase || !detection.databasePath) {
    return {
      hasDatabase: false,
      dashboardProjectId: null,
      cmosAddress: null,
      hasValidSenderIdentity: false,
      rejectReason: 'no CMOS database at projectRoot',
    };
  }

  try {
    const result = await withClientAsync(
      async (db: CmosDatabaseClient) => {
        const pidRow = db.getOne<{ value: string }>(
          "SELECT value FROM metadata WHERE key = 'dashboard_project_id'"
        );
        const rawProjectId = pidRow.success && pidRow.data?.value ? pidRow.data.value.trim() : '';
        const dashboardProjectId = rawProjectId.length > 0 ? rawProjectId : null;

        let identity = getProjectIdentity(db);
        let cmosAddress = identity?.cmos_address?.trim() ?? '';
        const initialStale = !cmosAddress || cmosAddress.startsWith('cmos://unknown/');

        let healed: { previous: string; next: string } | undefined;
        if (initialStale && heal) {
          const outcome = backfillUnknownCmosAddress(db);
          if (outcome.rewritten && outcome.next && outcome.next !== outcome.previous) {
            healed = {
              previous: outcome.previous ?? '',
              next: outcome.next,
            };
            identity = getProjectIdentity(db);
            cmosAddress = identity?.cmos_address?.trim() ?? '';
          }
        }

        const hasCanonicalAddress =
          cmosAddress.length > 0 && !cmosAddress.startsWith('cmos://unknown/');
        const hasValidUuid = dashboardProjectId !== null && UUID_REGEX.test(dashboardProjectId);
        const hasValidSenderIdentity = hasValidUuid && hasCanonicalAddress;

        let rejectReason: string | undefined;
        if (!hasValidUuid) {
          rejectReason = 'dashboard_project_id missing or not a UUID';
        } else if (!hasCanonicalAddress) {
          rejectReason = 'project_identity.cmos_address is empty or cmos://unknown/*';
        }

        const payload: ValidateProjectResult = {
          hasDatabase: true,
          dashboardProjectId,
          cmosAddress: hasCanonicalAddress ? cmosAddress : null,
          healed,
          hasValidSenderIdentity,
          rejectReason,
        };
        return { success: true, data: payload };
      },
      { projectRoot: resolved }
    );

    if (result.success && result.data) {
      return result.data;
    }
    return {
      hasDatabase: true,
      dashboardProjectId: null,
      cmosAddress: null,
      hasValidSenderIdentity: false,
      rejectReason: 'failed to open CMOS database',
    };
  } catch (err) {
    return {
      hasDatabase: true,
      dashboardProjectId: null,
      cmosAddress: null,
      hasValidSenderIdentity: false,
      rejectReason: `DB read error: ${err instanceof Error ? err.message : 'unknown'}`,
    };
  }
}

/**
 * Resolve the sender context for an outbound tool call.
 *
 * Walks the priority chain described in the module header. Every attempted
 * candidate is recorded in the returned `candidates` array (or in the thrown
 * `SenderResolutionError.candidates` when resolution fails), so operators can
 * see exactly what the server tried and why each option was rejected.
 *
 * @throws SenderResolutionError when no candidate is acceptable.
 */
export async function resolveSenderContext(
  opts: ResolveSenderContextOptions = {}
): Promise<SenderContext> {
  const candidates: ResolutionCandidate[] = [];
  const requireSenderIdentity = opts.requireSenderIdentity ?? true;
  const serverInstallRoot = path.resolve(opts.serverInstallRootOverride ?? SERVER_INSTALL_ROOT);

  const isAcceptable = (v: ValidateProjectResult): boolean =>
    requireSenderIdentity ? v.hasValidSenderIdentity : v.hasDatabase;

  const accept = (
    source: SenderResolutionSource,
    projectRoot: string,
    v: ValidateProjectResult
  ): SenderContext => {
    candidates.push({ source, projectRoot, accepted: true });
    return {
      projectRoot,
      source,
      dashboardProjectId: v.dashboardProjectId,
      cmosAddress: v.cmosAddress,
      healed: v.healed,
      candidates,
    };
  };

  // ─── Step 1: explicit ───────────────────────────────────────────────────
  if (opts.explicitProjectRoot) {
    const root = path.resolve(opts.explicitProjectRoot);
    const validation = await validateProject(root);
    if (isAcceptable(validation)) {
      return accept('explicit', root, validation);
    }
    candidates.push({
      source: 'explicit',
      projectRoot: root,
      accepted: false,
      rejectReason: validation.rejectReason ?? 'explicit projectRoot not acceptable',
    });
  }

  // ─── Step 2: MCP client roots ───────────────────────────────────────────
  for (const root of opts.mcpRoots ?? []) {
    const resolved = path.resolve(root);
    const validation = await validateProject(resolved);
    if (isAcceptable(validation)) {
      return accept('mcp-roots', resolved, validation);
    }
    candidates.push({
      source: 'mcp-roots',
      projectRoot: resolved,
      accepted: false,
      rejectReason: validation.rejectReason ?? 'mcp root not acceptable',
    });
  }

  // ─── Step 3: cwd (with cwd-vs-SERVER_INSTALL_ROOT guard) ────────────────
  const cwd = path.resolve(opts.cwdOverride ?? process.cwd());
  const guardEngaged =
    cwd === serverInstallRoot && requireSenderIdentity && !opts.explicitProjectRoot;
  if (guardEngaged) {
    candidates.push({
      source: 'cwd',
      projectRoot: cwd,
      accepted: false,
      rejectReason:
        'cwd-vs-SERVER_INSTALL_ROOT guard: cmos-mcp must never be implicit sender for another project',
    });
  } else {
    const validation = await validateProject(cwd);
    if (isAcceptable(validation)) {
      return accept('cwd', cwd, validation);
    }
    candidates.push({
      source: 'cwd',
      projectRoot: cwd,
      accepted: false,
      rejectReason: validation.rejectReason ?? 'cwd not acceptable',
    });
  }

  // ─── Step 4: registry singleton ─────────────────────────────────────────
  try {
    const registry = opts.registryOverride ?? (await ProjectRegistry.create());
    const projects = await registry.list();
    if (projects.length === 1) {
      const root = path.resolve(projects[0].projectRoot);
      const validation = await validateProject(root);
      if (isAcceptable(validation)) {
        return accept('registry-singleton', root, validation);
      }
      candidates.push({
        source: 'registry-singleton',
        projectRoot: root,
        accepted: false,
        rejectReason: validation.rejectReason ?? 'registry-singleton not acceptable',
      });
    } else {
      candidates.push({
        source: 'registry-singleton',
        accepted: false,
        rejectReason:
          projects.length === 0
            ? 'registry is empty'
            : `registry has ${projects.length} projects; auto-pick only allowed when size === 1`,
      });
    }
  } catch (err) {
    candidates.push({
      source: 'registry-singleton',
      accepted: false,
      rejectReason: `registry error: ${err instanceof Error ? err.message : 'unknown'}`,
    });
  }

  // ─── Step 5: fail closed ────────────────────────────────────────────────
  throw new SenderResolutionError(
    'Could not authoritatively resolve sender context. No candidate produced a project ' +
      'with a valid dashboard identity. See SenderResolutionError.candidates for the full trace.',
    candidates
  );
}
