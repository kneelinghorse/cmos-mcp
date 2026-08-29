// ABOUTME: Resolve the local project's sender identity (dashboard UUID + cmos_address)
// ABOUTME: for outbound cross-project messaging. Single source of truth for attribution.

/**
 * Sender Identity Resolver
 *
 * Every path that calls DashboardClient.sendMessage must attribute the send to the
 * *local* project — the cwd this process is running in. The original Sprint 32
 * auto-detect blindly returned `/api/projects/me` projects[0], which caused every
 * message from every project to be tagged with whichever project the dashboard
 * happened to list first for the user (Parts Town, for derek — P0 bug reported
 * 2026-04-16 after Sprint 52 failed to root-cause it).
 *
 * This module centralises the resolution so any new sender path gets the right
 * answer automatically. Fail-closed: when we cannot authoritatively resolve the
 * local project, return `undefined` — never a sibling project's id.
 *
 * @module tools/cmos/sender-identity
 */

import { withClientAsync, type CmosDatabaseClient } from './client';
import { createSuccess } from './errors';
import { getProjectIdentity, backfillUnknownCmosAddress } from './project-identity';
import { resolveAndPersistOwner } from './owner-resolution';
import type { DashboardClient } from './dashboard-client';

/** UUID regex used to validate the local dashboard_project_id before trusting it. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Local sender identity — everything we know about *this* cwd's project, used to
 * attribute outgoing messages. Both fields are resolved from the local DB in a
 * single open; the async entrypoint also best-effort seeds `metadata.owner` and
 * backfills the canonical cmos_address if they are missing.
 */
export interface LocalSenderIdentity {
  /** Dashboard UUID for this local project, or null when never registered. */
  projectId: string | null;
  /** Canonical cmos://<owner>/<slug> address, or null when still empty/unknown. */
  cmosAddress: string | null;
}

/**
 * Normalise a cmos:// address the same way cmos_message(send) does before POSTing,
 * so that local-vs-directory comparison is case-insensitive + whitespace-tolerant.
 */
function normalizeAddress(address: string): string {
  if (!address.startsWith('cmos://')) return address;
  const body = address.slice('cmos://'.length);
  const normalized = body.toLowerCase().replace(/\s+/g, '-').replace(/-{2,}/g, '-');
  return `cmos://${normalized}`;
}

function normalizeSlug(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase().replace(/\s+/g, '-') : null;
}

function extractSlugFromAddress(address: string | null): string | null {
  if (!address || !address.startsWith('cmos://')) {
    return null;
  }

  const body = address.slice('cmos://'.length);
  const [, slug] = body.split('/');
  return normalizeSlug(slug ?? null);
}

function readMetadataValue(db: CmosDatabaseClient, key: string): string | null {
  const result = db.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key]);
  if (!result.success || !result.data?.value) {
    return null;
  }

  const trimmed = result.data.value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function shouldAttemptIdentityRepair(
  projectId: string | null,
  cmosAddress: string | null,
  db: CmosDatabaseClient
): boolean {
  if (!projectId || !UUID_REGEX.test(projectId)) {
    return true;
  }

  if (!cmosAddress) {
    return true;
  }

  const currentSlug = extractSlugFromAddress(cmosAddress);
  const trustedSlugs = new Set(
    [readMetadataValue(db, 'project_id'), readMetadataValue(db, 'project_name')]
      .map((value) => normalizeSlug(value))
      .filter((value): value is string => value !== null)
  );

  if (trustedSlugs.size === 0) {
    return false;
  }

  return currentSlug === null || !trustedSlugs.has(currentSlug);
}

/**
 * Read the local project's sender identity (dashboard UUID + cmos_address) from
 * the CMOS database. Returns nulls — never bogus defaults — so the caller can
 * fail closed rather than publishing a sibling project's identity.
 *
 * `cmosAddress` is null when the identity row holds an empty or `cmos://unknown/*`
 * address; sending a bogus value is worse than omitting it (Sprint 52 m02, and
 * the reason the Parts Town attribution bug is P0).
 *
 * Attempts a best-effort owner resolution + backfill first so that a fresh project
 * with dashboard auth configured can emit a canonical address on its very first
 * send.
 */
export async function readLocalSenderIdentity(projectRoot?: string): Promise<LocalSenderIdentity> {
  try {
    const result = await withClientAsync(
      async (db) => {
        const readIdentity = (): LocalSenderIdentity => {
          const rawProjectId = readMetadataValue(db, 'dashboard_project_id') ?? '';
          const projectId = rawProjectId.length > 0 ? rawProjectId : null;
          const identity = getProjectIdentity(db);
          const addr = identity?.cmos_address?.trim() ?? '';
          const cmosAddress = !addr || addr.startsWith('cmos://unknown/') ? null : addr;
          return { projectId, cmosAddress };
        };

        let localIdentity = readIdentity();
        if (shouldAttemptIdentityRepair(localIdentity.projectId, localIdentity.cmosAddress, db)) {
          try {
            // s86-m02b: `resolveAndPersistOwner` returns a `warnings` array naming any
            // metadata write that errored, and this call site DROPS it — deliberately, and
            // this is the one caller of the three that must. It is a PRODUCER WITH NO
            // CONSUMER BY CONSTRUCTION: `readLocalSenderIdentity` is a resolver, not a tool
            // handler. It returns a bare `LocalSenderIdentity` (the `createSuccess` envelope
            // below is discarded by the `result.data` unwrap at the end of this function),
            // it has no `format*ForLLM`, and its two callers — cmos-message.ts's handleSend
            // and cmos-sprint-carry-forward.ts — consume only `{projectId, cmosAddress}`.
            // Carrying the failure out would mean widening this resolver's return type and
            // both call sites; the disclosure the operator actually gets is the NULL identity
            // this function then fails closed with, plus the same warnings surfaced by the
            // other two callers (cmos-agent-onboard, checkpoint-backfill) on their own answers.
            await resolveAndPersistOwner(db);
            backfillUnknownCmosAddress(db);
            localIdentity = readIdentity();
          } catch {
            // best-effort — fall through to whatever the DB currently has
          }
        }

        return createSuccess<LocalSenderIdentity>(localIdentity);
      },
      // Sender resolution observes (and may repair owner/address linkage); it is not the
      // project-registration authority even when nested inside a write-classified send.
      { projectRoot, registerProject: false }
    );
    return result.success && result.data ? result.data : { projectId: null, cmosAddress: null };
  } catch {
    return { projectId: null, cmosAddress: null };
  }
}

/**
 * Resolve the dashboard UUID to attribute an outbound message to.
 *
 * Resolution order (fail-closed):
 *   1. `metadata.dashboard_project_id` — the canonical UUID written at
 *      registration / first checkpoint. Authoritative: it is the dashboard's
 *      own id for *this* cwd's project, so there is no ambiguity.
 *   2. Match the local `project_identity.cmos_address` against
 *      `/api/projects/me` by canonical address. Used when a project was
 *      registered out-of-band and the metadata row is missing but the address
 *      is already canonical.
 *   3. Otherwise `undefined`. Callers pass it through as an omitted field; the
 *      dashboard can then reject or apply its own (unrelated) fallback.
 *
 * NEVER pick `projects[0]` — the /api/projects/me response is "every project
 * this user owns," and blindly taking the first one causes the Parts Town
 * attribution corruption that Sprint 32's auto-detect shipped and Sprint 52
 * failed to root-cause.
 */
export async function resolveLocalSenderProjectId(
  client: DashboardClient,
  identity: LocalSenderIdentity
): Promise<string | undefined> {
  if (identity.projectId && UUID_REGEX.test(identity.projectId)) {
    return identity.projectId;
  }

  if (!identity.cmosAddress) return undefined;

  const result = await client.getMyProjects();
  if (!result.success || !result.data?.projects?.length) {
    return undefined;
  }

  const normalizedLocal = normalizeAddress(identity.cmosAddress);
  const match = result.data.projects.find((p) => normalizeAddress(p.address) === normalizedLocal);
  return match?.id;
}

/**
 * Convenience wrapper: read the local identity and resolve the senderProjectId
 * in a single call. Used by tools that don't need the cmosAddress separately.
 */
export async function getLocalSenderProjectId(
  client: DashboardClient,
  projectRoot?: string
): Promise<{ senderProjectId: string | undefined; identity: LocalSenderIdentity }> {
  const identity = await readLocalSenderIdentity(projectRoot);
  const senderProjectId = await resolveLocalSenderProjectId(client, identity);
  return { senderProjectId, identity };
}

/**
 * Thrown when handleSend or any other authoritative-attribution call site cannot
 * produce a complete sender identity (UUID + canonical cmos_address). Defense in
 * depth on top of the dispatcher's `resolveSenderContext` gate — the resolver
 * normally fail-closes before we ever reach this path, but keeping the assertion
 * here prevents any caller that bypasses the boundary from silently publishing
 * with a null sender.
 *
 * The thrown code `SENDER_ATTRIBUTION_INCOMPLETE` is distinct from the resolver's
 * `SENDER_UNRESOLVABLE` so operators can tell which layer rejected the send.
 */
export class SenderAttributionIncompleteError extends Error {
  readonly code = 'SENDER_ATTRIBUTION_INCOMPLETE';
  readonly identity: LocalSenderIdentity;
  readonly senderProjectId: string | undefined;

  constructor(identity: LocalSenderIdentity, senderProjectId: string | undefined) {
    super(
      `Sender attribution incomplete: projectId=${identity.projectId ?? 'null'} ` +
        `cmosAddress=${identity.cmosAddress ?? 'null'} senderProjectId=${senderProjectId ?? 'null'}. ` +
        'Refusing to send — attribution must be authoritatively resolved before dashboard publish.'
    );
    this.name = 'SenderAttributionIncompleteError';
    this.identity = identity;
    this.senderProjectId = senderProjectId;
  }
}

/**
 * Throw `SenderAttributionIncompleteError` when local identity is null — i.e.
 * neither a resolved sender UUID nor a canonical cmos_address is available.
 *
 * Sprint 53 m02 decision: we fail-close only when there is *nothing* to
 * attribute with. When either the UUID or the address is present, we forward
 * what we have — the dashboard can cross-check (m04 adds echo-verification).
 * This preserves existing pass-through semantics for edge cases where metadata
 * is partially seeded, while still refusing to publish a completely-anonymous
 * send. The full UUID+address authoritative attribution is enforced upstream
 * by the dispatcher's `resolveSenderContext(requireSenderIdentity=true)` gate;
 * this function is defense-in-depth for any caller that bypasses the boundary.
 */
export function assertSenderIdentityValid(
  identity: LocalSenderIdentity,
  senderProjectId: string | undefined
): void {
  if (!senderProjectId && !identity.cmosAddress) {
    throw new SenderAttributionIncompleteError(identity, senderProjectId);
  }
}
