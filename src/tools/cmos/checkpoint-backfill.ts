/**
 * Checkpoint Backfill — Fire-and-Forget Dashboard Sync
 *
 * Triggers a non-blocking sync to the dashboard at workflow boundaries
 * (session complete, sprint complete). Errors are logged to stderr and
 * never propagate to the caller.
 *
 * Primary path: POST SQLite file to /api/sync/sqlite-backfill (file-based bulk sync).
 * Fallback path: event-replay via cmosDbBackfill when no project slug is available.
 *
 * Auto-registers the project with the dashboard on first checkpoint if not
 * already registered (checks `dashboard_registered` metadata flag).
 *
 * @module tools/cmos/checkpoint-backfill
 */

import { cmosDbBackfill } from './cmos-db-backfill';
import { withClientAsync } from './client';
import {
  DashboardClient,
  CMOS_DASHBOARD_API_KEY_ENV,
  CMOS_DASHBOARD_USER_ENV,
  CMOS_DASHBOARD_PASSWORD_ENV,
} from './dashboard-client';
import { createSuccess } from './errors';
import { resolveAndPersistOwner } from './owner-resolution';
import { backfillUnknownCmosAddress } from './project-identity';
import { checkWrite } from './write-guard';
import { captureRegisterResponse } from '../../auth/project-key-capture';
import { CredentialStore, type KeySource } from '../../intelligence/credential-store';
import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';

/**
 * s86-m01 — write diagnostics straight to fd 2 instead of through the console
 * object.
 *
 * This module's work happens inside a fire-and-forget async IIFE
 * (`triggerCheckpointBackfill`) that deliberately outlives its caller. Under Jest
 * that body can still be in flight when a suite finishes, and Jest replaces the
 * global console object at teardown, so a late error write through it throws
 * "Cannot log after tests are done" — which surfaces as a nonzero exit AFTER a
 * fully green run (the CI flake root-caused in decision #970 and re-diagnosed in
 * s86-m01). `process.stderr` is not patched, so the same line lands without
 * arming that trap.
 *
 * Production behaviour is byte-identical: a stdio MCP server's error logging
 * already writes to fd 2, and stdout is reserved for the JSON-RPC channel.
 * In-tree precedent: `warnLegacyAuth` (dashboard-client.ts) already writes this way.
 *
 * The structural gate tests/tools/cmos/detached-log-gate.test.ts (Arm A) keeps
 * this module — and the other two on this path — free of console calls.
 */
function log(line: string): void {
  process.stderr.write(line + '\n');
}

/**
 * s86-m01 — kill switch for the fire-and-forget checkpoint sync.
 *
 * Set to the exact string `'off'` to disable it; any other value (including
 * `'on'`) leaves normal behaviour untouched. Exported so tests reference the name
 * rather than re-spelling the literal.
 */
export const CMOS_CHECKPOINT_SYNC_ENV = 'CMOS_CHECKPOINT_SYNC';

// ─── Sprint 70 m04: device-code credential gate ──────────────────────────────

/**
 * Whether the local CredentialStore holds a RESOLVABLE user-scoped key — i.e. at
 * least one device-code-minted record carrying a non-empty `cmk_...` key.
 *
 * This is the device-code-auth signal the checkpoint gate accepts in addition to
 * the env vars (#303/#701). Device-code-only auth (default since Sprint 57)
 * populates this store but NOT `CMOS_DASHBOARD_API_KEY` / `USER`+`PASSWORD`, so the
 * old env-only gate silently skipped sync for those users. Mere presence of the
 * store FILE is not enough — an empty/placeholder record does not count (RISK
 * guard: do not open the gate wider than real device-code auth). Async +
 * non-throwing: any read failure folds into `false` (fail closed).
 *
 * Exported for tests.
 */
export async function hasResolvableUserScopedKey(): Promise<boolean> {
  try {
    const store = CredentialStore.getInstance();
    const keys = await store.listUserScopedKeys();
    return Object.values(keys).some(
      (record) => typeof record.key === 'string' && record.key.length > 0
    );
  } catch {
    return false;
  }
}

interface CheckResult {
  sqlitePath: string;
  projectSlug: string | null;
  expectedSlug: string | null;
  /** s81-m03 — the store's stable metadata.project_id (registry key for last_synced_at). */
  projectId: string | null;
  /**
   * s86-m02b — DB errors from the registration-state writes below. This path has no CMOS
   * answer to attach to (it is the fire-and-forget checkpoint), so its reporting channel is
   * this module's `log` to fd 2 — the same channel that already carries "Registration
   * failed" and "File sync failed". Without it, a failed `dashboard_registered` write is
   * followed by an "Auto-registered project ..." line asserting a row that was never stored.
   */
  warnings: string[];
}

function deriveProjectSlug(projectName: string): string {
  return projectName.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Check if the project is registered with the dashboard.
 * If not, register it by uploading the SQLite database.
 * Returns the SQLite path and project slug (null if unavailable).
 * Non-fatal — errors are logged and swallowed.
 */
async function checkAndRegister(
  projectRoot: string | undefined,
  dashClient: DashboardClient,
  // s86-m06 — which resolution arm supplied `dashClient`. Threaded in because the
  // honest capture-failure log depends on it: `captureRegisterResponse` receives a
  // bare parentKeyId and structurally cannot know WHY it is absent, but its caller
  // can. Deriving the reason here rather than guessing there is the whole point.
  keySource: KeySource
): Promise<CheckResult | null> {
  let captured: CheckResult | null = null;
  // s86-m02b — declared out here so pushes made after `captured` is built still reach the
  // caller: the same array instance is handed to the CheckResult below.
  const warnings: string[] = [];

  try {
    await withClientAsync(
      async (client) => {
        captured = {
          sqlitePath: client.path,
          projectSlug: null,
          expectedSlug: null,
          projectId: null,
          warnings,
        };

        const nameResult = client.getOne<{ value: string }>(
          `SELECT value FROM metadata WHERE key = 'project_name'`
        );
        const projectName = (nameResult.success && nameResult.data?.value) || '';
        captured.expectedSlug = projectName ? deriveProjectSlug(projectName) : null;

        // s81-m03: capture the stable project_id — the project-graph registry key for
        // recording the converged-push time (last_synced_at) after a successful sync.
        const pidResult = client.getOne<{ value: string }>(
          `SELECT value FROM metadata WHERE key = 'project_id'`
        );
        captured.projectId = (pidResult.success && pidResult.data?.value) || null;

        // Sprint 52 m01: seed metadata.owner from dashboard identity and rewrite any
        // legacy `cmos://unknown/*` address. Runs on every checkpoint so downstream
        // dashboard relays see the canonical address for sender attribution.
        // s81-m02: capture whether the reconcile POSITIVELY confirmed the incumbent this
        // cycle — only then may the expectedSlug guard be relaxed (below).
        // s86-m02b: the reconcile's own `metadata.owner` / `dashboard_slug` /
        // `dashboard_project_id` writes report through the same sink as the registration
        // writes below. A failed owner write leaves the store minting `cmos://unknown/*`
        // addresses while the push proceeds under a slug this cycle believed it persisted.
        let incumbentConfirmed = false;
        try {
          const ownerResult = await resolveAndPersistOwner(client, dashClient);
          incumbentConfirmed = ownerResult.incumbentConfirmed;
          warnings.push(...(ownerResult.warnings ?? []));
          backfillUnknownCmosAddress(client);
        } catch {
          // best-effort — never block the registration/sync flow
        }

        // Check if already registered
        const regResult = client.getOne<{ value: string }>(
          `SELECT value FROM metadata WHERE key = 'dashboard_registered'`
        );
        if (regResult.success && regResult.data?.value === 'true') {
          // Already registered — read slug from metadata
          const slugResult = client.getOne<{ value: string }>(
            `SELECT value FROM metadata WHERE key = 'dashboard_slug'`
          );
          captured.projectSlug = (slugResult.success && slugResult.data?.value) || null;
          // s81-m02 defect-2 (adversarial-review-hardened): on the SYNC path, relax the
          // expectedSlug guard to the RECONCILED incumbent dashboard_slug ONLY when the
          // reconcile CONFIRMED that incumbent against a live dashboard row this cycle
          // (trusted id/slug/address match — not a self-referential dashboard_slug-hint
          // reaffirmation, not a getMyProjects failure). A confirmed incumbent lets a
          // same-owner byte-copy under a divergent name sync (the T4 goal). When NOT
          // confirmed we KEEP the stricter derive(project_name) guard (set at line 90) so
          // a stale/wrong dashboard_slug is refused with EXPECTED_SLUG_MISMATCH rather than
          // mis-routing the push into a sibling project's row. cmos-mcp-pro confirms via
          // byId every cycle, so its behavior is unchanged.
          if (incumbentConfirmed) {
            captured.expectedSlug = captured.projectSlug;
          }
          return createSuccess(undefined);
        }

        if (!projectName) {
          return createSuccess(undefined); // Can't register without a name
        }

        const sqlitePath = client.path;
        const result = await dashClient.registerProject({
          projectName,
          sqlitePath,
          localDbPath: sqlitePath,
          expectedSlug: captured.expectedSlug ?? undefined,
        });

        if (result.success && result.data) {
          // Store registration state in metadata
          checkWrite(
            client.execute(
              `INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_registered', 'true')`
            ),
            warnings,
            'metadata.dashboard_registered'
          );
          checkWrite(
            client.execute(
              `INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_slug', ?)`,
              [result.data.slug]
            ),
            warnings,
            'metadata.dashboard_slug'
          );
          checkWrite(
            client.execute(
              `INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_project_id', ?)`,
              [result.data.projectId]
            ),
            warnings,
            'metadata.dashboard_project_id'
          );
          log(
            `[CHECKPOINT] Auto-registered project "${projectName}" as "${result.data.slug}"` +
              (result.data.reregistered ? ' (re-registration)' : '')
          );
          captured.projectSlug = result.data.slug;

          // Sprint 57 m02: capture the auto-issued project-scoped key into the
          // local credential store so subsequent sends bear it via
          // fromEnvForProject() without relying on the user-scoped fallback.
          if (projectRoot) {
            try {
              const captureStatus = await captureRegisterResponse({
                projectRoot,
                response: result.data,
                parentKeyId: dashClient.authenticatingKeyId,
              });
              if (captureStatus === 'captured') {
                log(
                  `[CHECKPOINT] Captured project-scoped key for "${result.data.slug}" (keyId=${result.data.keyId})`
                );
              } else if (captureStatus === 'missing-parent-key-id') {
                // s86-m06 — the old line asserted "/reissue on next startup will
                // recover", which is false in exactly the state that emits it:
                // startup recovery returns `skipped-already-present` whenever a
                // local row exists, and where no row exists the reason for the
                // missing attribution is unchanged by a restart. Derived from
                // keySource so each arm gets the recovery that applies to it.
                log(
                  `[CHECKPOINT] Skipping project-key capture: the dashboard minted a project key but this client (keySource=${keySource}) carries no user-scoped parent to attribute it to, so it is left orphaned locally. ${
                    keySource === 'project-scoped'
                      ? 'A local project-key row already exists for this root, so startup recovery will skip it — run cmos_auth(action="reissue", projectRoot=…) to replace the row.'
                      : 'Startup recovery will hit the same wall — run cmos_auth(action="login_init") + login_complete so a device-code user key is available, then cmos_auth(action="reissue", projectRoot=…).'
                  }`
                );
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              log(`[CHECKPOINT] Project-key capture failed: ${msg}`);
            }
          }
        } else if (!result.success) {
          log(`[CHECKPOINT] Registration failed: ${result.error?.message ?? 'unknown'}`);
        }

        return createSuccess(undefined);
      },
      { projectRoot }
    );
  } catch {
    // Non-fatal — continue with sync regardless
  }

  return captured;
}

/**
 * s86-m01 — the most recently started checkpoint sync, held so a test that does
 * NOT own the call site can still drain it deterministically.
 *
 * `triggerCheckpointBackfill` already returns its promise, but the two production
 * call sites (cmos-sprint.ts, cmos-session.ts) deliberately drop it — that
 * non-blocking shape is the point, and awaiting it would be a user-visible
 * latency regression on every sprint/session complete. A test that drives
 * `cmos_sprint(action='complete')` therefore has no handle on the async work it
 * just started, and the detached body outlives the test: it re-resolves dashboard
 * credentials from `process.env` mid-flight, so an `afterEach` that restores
 * those vars flips the in-flight run onto a different code path and its log lands
 * after teardown. `__drainCheckpointBackfill` gives those tests the handle.
 */
let inFlightCheckpoint: Promise<void> | null = null;

/**
 * Await the most recently triggered checkpoint sync (resolves immediately when
 * none has run). TEST-ONLY — the leading underscores mark it as not part of the
 * tool surface.
 *
 * Call it in an `afterEach` BEFORE restoring/deleting dashboard credential env
 * vars. Draining afterwards reproduces the bug instead of fixing it: the detached
 * body reads those vars as it runs, so tearing them down first is what pushes it
 * onto the no-credential fallback whose failure line arrives post-teardown.
 */
export function __drainCheckpointBackfill(): Promise<void> {
  return inFlightCheckpoint ?? Promise.resolve();
}

/**
 * Trigger a checkpoint sync in a fire-and-forget manner.
 *
 * Primary path: file-based sync via POST /api/sync/sqlite-backfill (idempotent, bulk).
 * Fallback: event-replay backfill when no project slug is available (not yet registered).
 *
 * On first checkpoint, auto-registers the project with the dashboard
 * before running the sync.
 *
 * Returns the in-flight sync promise. Production callers IGNORE it — the sync
 * runs asynchronously and never blocks the caller (the trailing `.catch` folds
 * errors into a stderr log, so the returned promise always resolves and never
 * rejects). Tests `await` it for a deterministic drain: the device-code gate
 * does a real CredentialStore fs read, which heuristic event-loop ticking can
 * miss under full-suite load, leaking the async into the next test. Tests that
 * cannot reach the returned promise (because a production call site dropped it)
 * use {@link __drainCheckpointBackfill} instead.
 *
 * @param options.projectRoot - Project root for sync
 * @param options.force - true for full sync (sprint complete), false for incremental (session complete)
 */
export function triggerCheckpointBackfill(options: {
  projectRoot?: string;
  force: boolean;
}): Promise<void> {
  // s86-m01 — defense in depth, read BEFORE any other gate.
  //
  // 'off' disables the sync outright; ANY other value, INCLUDING 'on', runs
  // normally. The asymmetry is deliberate: tests/jest-global-setup.ts sets it to
  // 'off' only when the var is ABSENT, so `CMOS_CHECKPOINT_SYNC=on npm test` puts
  // the real behaviour back for a whole run — which is what keeps this mission's
  // own flake evidence falsifiable. With the switch silently forced off, "zero
  // 'Cannot log after tests are done'" would prove nothing about whether the
  // underlying late-log was actually fixed.
  //
  // This is the LAST line of defense, not the fix. The fix is that this module
  // and cmos-db-backfill no longer write through the global console object at all
  // (see `log` above), plus the deterministic drain below.
  if (process.env[CMOS_CHECKPOINT_SYNC_ENV] === 'off') {
    return Promise.resolve();
  }

  // Sprint 62 m02: URL has a baked default (DEFAULT_DASHBOARD_URL), so the gate is
  // credentials-only. Without any credential there's nothing to push, so skip
  // silently — users without an account run local-only and that's fine.
  const hasApiKey = !!process.env[CMOS_DASHBOARD_API_KEY_ENV];
  const hasCredentials =
    !!process.env[CMOS_DASHBOARD_USER_ENV] && !!process.env[CMOS_DASHBOARD_PASSWORD_ENV];

  // Fire and forget — never block the caller. The promise is RETURNED so tests
  // can await a deterministic drain; production callers ignore it, and the
  // trailing .catch means it always resolves (never rejects). s86-m01 also parks
  // it in module scope so a test whose call site dropped the handle can drain it
  // via __drainCheckpointBackfill.
  const inFlight = (async () => {
    // Sprint 70 m04: device-code-only auth (default since Sprint 57) populates the
    // CredentialStore with a user-scoped key but NOT the env vars above, so the old
    // env-only gate silently dropped those users' checkpoint sync (#303/#701).
    // Extend the gate: a resolvable user-scoped key ALSO counts as sufficient. Fail
    // closed ONLY when there is no credential by ANY path (no env AND no resolvable
    // user-scoped key). The credential read is async, so the whole gate lives here
    // inside the fire-and-forget body rather than in the synchronous entry. This
    // supersedes decision #703 (s67-m04's "gate behavior unchanged" + WARN-only).
    if (!hasApiKey && !hasCredentials && !(await hasResolvableUserScopedKey())) {
      return;
    }

    // Resolve dashboard client once for all operations. Sprint 57 m02:
    // fromEnvForProject threads the credential store so the client's
    // authenticatingKeyId is populated — required for auto-capturing the
    // project-scoped key returned on first-time register.
    const dashResult = await DashboardClient.fromEnvForProject(options.projectRoot);
    if (!dashResult.success || !dashResult.data) {
      return;
    }
    const dashClient = dashResult.data.client;

    // Auto-register on first checkpoint, read slug for file sync
    const info = await checkAndRegister(options.projectRoot, dashClient, dashResult.data.keySource);

    // s86-m02b: a registration-state write that errored must be said out loud on the same
    // channel as the "Auto-registered project ..." line it would otherwise contradict.
    for (const warning of info?.warnings ?? []) {
      log(`[CHECKPOINT] ${warning}`);
    }

    if (info?.projectSlug) {
      // Primary path: file-based sync via POST /api/sync/sqlite-backfill
      const result = await dashClient.syncSqliteFile(
        info.sqlitePath,
        info.projectSlug,
        info.expectedSlug ?? undefined
      );
      if (result.success && result.data) {
        const d = result.data;
        const countSummary = Object.entries(d.counts)
          .map(([k, v]) => `${k}:${v}`)
          .join(', ');
        log(
          `[CHECKPOINT] File sync: ${info.projectSlug} (${d.durationMs}ms)` +
            (countSummary ? ` — ${countSummary}` : '') +
            (d.errors.length > 0 ? ` — ${d.errors.length} error(s)` : '')
        );
        // s81-m03: the converged push succeeded — record last_synced_at so cmos_review
        // can flag 'local ahead of dashboard (unsynced)' drift with NO network round-trip
        // (read free off registry.list(), #671). ISOLATED try: this is the push path's
        // only registry write, on a per-user file shared by sibling MCP processes — a
        // lock/ALTER/UPDATE error must NEVER fail or block this fire-and-forget checkpoint.
        if (info.projectId) {
          try {
            const registry = await ProjectGraphRegistry.create();
            registry.updateLastSynced(info.projectId, Date.now());
          } catch {
            // best-effort — a registry bookkeeping write never gates a checkpoint sync.
          }
        }
      } else if (!result.success) {
        // s81-m01 NO-FALLBACK GAP: unlike the direct cmosDbBackfill path (which drops
        // to event-replay and now surfaces a warnings[] entry on file-sync failure),
        // the auto-checkpoint path for a REGISTERED project is file-sync-ONLY. On
        // failure there is no event-replay retry this cycle — the checkpoint simply
        // did not sync, and the next checkpoint boundary retries the full file. This
        // is acceptable for a fire-and-forget path (idempotent, self-healing on the
        // next boundary), but the gap is intentional and documented so a future
        // silent-lag investigation starts here, not from scratch.
        log(
          `[CHECKPOINT] File sync failed (no event-replay fallback on this path): ${result.error?.message ?? 'unknown'}`
        );
      }
    } else {
      // Fallback: event-replay backfill (no slug — project not yet registered)
      const result = await cmosDbBackfill({
        projectRoot: options.projectRoot,
        force: options.force,
        dryRun: false,
      });

      if (result.success && result.data) {
        const d = result.data;
        if (d.pushed > 0 || d.failed > 0) {
          log(
            `[CHECKPOINT] Backfill: ${d.pushed} pushed, ${d.failed} failed` +
              (d.deduped > 0 ? `, ${d.deduped} deduped` : '')
          );
        }
      } else if (!result.success) {
        log(`[CHECKPOINT] Backfill failed: ${result.error?.message ?? 'unknown'}`);
      }
    }
  })().catch((error: unknown) => {
    log(`[CHECKPOINT] Sync error: ${error instanceof Error ? error.message : 'unknown'}`);
  });

  inFlightCheckpoint = inFlight;
  return inFlight;
}
