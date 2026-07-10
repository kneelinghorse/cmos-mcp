// ABOUTME: Project Identity (Layer 0) — stable, machine-readable project description.
// Stored as a `project_identity` row in the contexts table. Seeded from existing blob on first access.

import type { CmosDatabaseClient } from './client';
import type { MigrationResult } from './schema-migrations';

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Type-specific extension fields. Keyed by project_type.
 */
export interface ProjectTypeFields {
  // build
  stack?: string[];
  deployment_env?: string;
  repo_branch_strategy?: string;
  test_framework?: string;
  // research
  research_questions?: string[];
  active_hypotheses?: string[];
  knowledge_areas?: string[];
  // design
  design_system_ref?: string;
  figma_url?: string;
  token_format?: string;
  // product
  user_segments?: string[];
  live_url?: string;
  live_metrics_url?: string;
  // agent
  protocol?: string;
  tool_count?: number;
  requires_auth?: boolean;
  transport?: string;
  [key: string]: unknown;
}

export interface RelatedProject {
  name: string;
  address: string;
  relationship: string;
}

export interface FoundationalDoc {
  title: string;
  path: string;
}

export interface TracelabRef {
  type: 'collection' | 'report' | 'document' | 'chunk' | 'project';
  id: string;
  label: string;
}

/**
 * Full Project Identity schema (Layer 0).
 *
 * Stored as JSON in contexts(id='project_identity').
 * Changes infrequently — only when project purpose/objectives change.
 */
export interface ProjectIdentityData {
  project_id: string;
  project_name: string;
  cmos_address: string;
  platform: string;
  domain: string;
  project_type: 'build' | 'research' | 'design' | 'product' | 'agent' | string;
  tier: 'build' | 'managed' | 'general' | string;
  status: 'active_development' | 'production' | 'archived' | 'mothballed' | string;
  description: string;
  objectives: string[];
  related_projects: RelatedProject[];
  foundational_docs: FoundationalDoc[];
  tracelab_refs: TracelabRef[];
  type_fields: ProjectTypeFields;
  identity_contract_version: string;
  created_at: string;
  updated_at: string;
}

/** Empty project identity template */
const IDENTITY_TEMPLATE: ProjectIdentityData = {
  project_id: '',
  project_name: '',
  cmos_address: '',
  platform: 'aquex.ai',
  domain: '',
  project_type: 'build',
  tier: 'build',
  status: 'active_development',
  description: '',
  objectives: [],
  related_projects: [],
  foundational_docs: [],
  tracelab_refs: [],
  type_fields: {},
  identity_contract_version: 'v1',
  created_at: '',
  updated_at: '',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function getMetadataValue(client: CmosDatabaseClient, key: string): string | null {
  const result = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [
    key,
  ]);
  return result.success && result.data ? result.data.value : null;
}

/**
 * Resolve the project owner (username portion of the cmos_address) from local metadata.
 *
 * Priority:
 *   1. `metadata.owner` — canonical, written on registration or dashboard seed
 *   2. `metadata.dashboard_username` — cached from last dashboard login
 *
 * Returns null if neither key is set. Callers must NEVER substitute "unknown" as a
 * fallback — publishing `cmos://unknown/*` corrupts dashboard-side sender attribution
 * (Sprint 52 m01). Prefer an empty cmos_address (to be rewritten later via
 * `backfillUnknownCmosAddress`) over a bogus one.
 */
function resolveLocalOwner(client: CmosDatabaseClient): string | null {
  const owner = getMetadataValue(client, 'owner');
  if (owner && owner.trim().length > 0) return owner.trim();
  const cached = getMetadataValue(client, 'dashboard_username');
  if (cached && cached.trim().length > 0) return cached.trim();
  return null;
}

/**
 * Build the canonical cmos_address or return an empty string when the owner is unknown.
 * Exposed for tests and reuse by the backfill path.
 */
function buildCmosAddress(owner: string | null, slug: string): string {
  if (!owner) return '';
  if (!slug) return '';
  return `cmos://${owner}/${slug}`;
}

function getMasterContextSection(
  client: CmosDatabaseClient,
  section: string
): Record<string, unknown> | null {
  const result = client.getOne<{ content: string }>('SELECT content FROM contexts WHERE id = ?', [
    'master_context',
  ]);
  if (!result.success || !result.data) return null;

  try {
    const parsed = JSON.parse(result.data.content) as Record<string, unknown>;
    const sec = parsed[section];
    if (sec && typeof sec === 'object' && !Array.isArray(sec)) {
      return sec as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

function extractStr(obj: Record<string, unknown> | null, key: string): string {
  if (!obj) return '';
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

// ─── Core API ───────────────────────────────────────────────────────────────

/**
 * Ensure the `project_identity` context row exists.
 * If absent, seeds from existing master_context blob + metadata.
 * Safe to call multiple times (idempotent).
 */
export function ensureProjectIdentityRow(client: CmosDatabaseClient): MigrationResult {
  const existing = client.getOne<{ id: string }>(
    "SELECT id FROM contexts WHERE id = 'project_identity'",
    []
  );

  if (existing.success && existing.data) {
    return { columnsAdded: [], indexesCreated: [], rowsUpdated: 0, alreadyCurrent: true };
  }

  // Seed from existing blob
  const projectSection =
    getMasterContextSection(client, 'project_identity') ??
    getMasterContextSection(client, 'project') ??
    {};

  const now = new Date().toISOString();
  const projectId = getMetadataValue(client, 'project_id') ?? '';
  const projectName =
    extractStr(projectSection, 'name') || getMetadataValue(client, 'project_name') || '';
  const slugOrName = (getMetadataValue(client, 'dashboard_slug') ?? projectName)
    .toLowerCase()
    .replace(/\s+/g, '-');
  const owner = resolveLocalOwner(client);

  const tierResult = client.getOne<{ content: string }>(
    "SELECT content FROM contexts WHERE id = 'project_context'",
    []
  );
  let tier = 'build';
  if (tierResult.success && tierResult.data) {
    try {
      const pc = JSON.parse(tierResult.data.content) as Record<string, unknown>;
      if (typeof pc['tier'] === 'string') tier = pc['tier'];
    } catch {
      // ignore
    }
  }

  // s81-m04: seed the description preferring a NON-EMPTY source in this order — the
  // canonical `metadata.project_description` durability seed, then the master_context
  // `project` section, then the chosen `projectSection`. The old
  // `extractStr(projectSection, 'description')` alone seeded an EMPTY description whenever
  // the `project_identity` section existed but was description-less (it wins the
  // `?? getMasterContextSection('project')` precedence above), ignoring a non-empty
  // `project` section — the Fork B split-brain root (Layer-0 row description went EMPTY
  // while master_context held the correct string).
  const seededDescription =
    (getMetadataValue(client, 'project_description') ?? '').trim() ||
    extractStr(getMasterContextSection(client, 'project'), 'description') ||
    extractStr(projectSection, 'description') ||
    '';

  const identity: ProjectIdentityData = {
    ...IDENTITY_TEMPLATE,
    project_id: projectId,
    project_name: projectName,
    cmos_address: buildCmosAddress(owner, slugOrName),
    tier,
    status: extractStr(projectSection, 'status') || 'active_development',
    description: seededDescription,
    created_at: getMetadataValue(client, 'seeded_at') ?? now,
    updated_at: now,
  };

  const insertResult = client.execute(
    `INSERT OR IGNORE INTO contexts (id, source_path, content, updated_at)
     VALUES ('project_identity', 'cmos/contexts/project-identity.json', ?, ?)`,
    [JSON.stringify(identity), now]
  );

  const inserted = insertResult.success;
  return {
    columnsAdded: [],
    indexesCreated: [],
    rowsUpdated: inserted ? 1 : 0,
    alreadyCurrent: !inserted,
  };
}

/**
 * Fetch and parse the project_identity context row.
 * Returns null if not found.
 * Automatically seeds the row if absent.
 */
export function getProjectIdentity(client: CmosDatabaseClient): ProjectIdentityData | null {
  ensureProjectIdentityRow(client);

  const result = client.getOne<{ content: string; updated_at: string | null }>(
    "SELECT content, updated_at FROM contexts WHERE id = 'project_identity'",
    []
  );

  if (!result.success || !result.data) return null;

  try {
    return JSON.parse(result.data.content) as ProjectIdentityData;
  } catch {
    return null;
  }
}

/**
 * Patch specific top-level fields of the project identity.
 * Merges updates into the existing JSON and persists.
 *
 * @param client - Database client
 * @param updates - Partial fields to merge into the identity object
 * @returns true if the row was updated, false if no change or not found
 */
export function patchProjectIdentity(
  client: CmosDatabaseClient,
  updates: Partial<ProjectIdentityData>
): boolean {
  ensureProjectIdentityRow(client);

  const current = getProjectIdentity(client);
  if (!current) return false;

  const merged: ProjectIdentityData = {
    ...current,
    ...updates,
    updated_at: new Date().toISOString(),
  };

  const now = new Date().toISOString();
  const result = client.execute(
    "UPDATE contexts SET content = ?, updated_at = ? WHERE id = 'project_identity'",
    [JSON.stringify(merged), now]
  );

  return result.success;
}

/**
 * Heal an identity row whose cmos_address is missing or carries the legacy
 * `cmos://unknown/<slug>` placeholder. Called from the async entrypoints
 * (cmos_agent_onboard, checkpoint-backfill, sender-context, sender-identity)
 * after `resolveAndPersistOwner` has seeded metadata.owner from the
 * authenticated dashboard identity. Sprint 52 m01.
 *
 * No-ops when:
 *   - the row is missing,
 *   - the owner is still unresolvable,
 *   - the current cmos_address is a non-empty, non-`cmos://unknown/` value
 *     (Sprint 65 m02: user-set addresses are intentional — e.g. a fork
 *     `cmos://acme/widget-fork` vs canonical `cmos://acme/widget` —
 *     and must survive every observation/onboard pass).
 */
export function backfillUnknownCmosAddress(client: CmosDatabaseClient): {
  rewritten: boolean;
  previous: string | null;
  next: string | null;
} {
  const current = getProjectIdentity(client);
  if (!current) return { rewritten: false, previous: null, next: null };

  const existing = current.cmos_address ?? '';

  // Sprint 65 m02: respect user-set non-canonical addresses. The Sprint 52 m01
  // intent was to heal empty + legacy `cmos://unknown/*` rows, not to enforce
  // canonical form on every read. Pre-fix, any unguarded caller (cmos_agent_onboard,
  // checkpoint-backfill) silently reverted manual flips on the next observation —
  // decision #682.
  const needsHeal = existing === '' || /^cmos:\/\/unknown\//.test(existing);
  if (!needsHeal) {
    return { rewritten: false, previous: existing, next: existing };
  }

  const owner = resolveLocalOwner(client);
  if (!owner) return { rewritten: false, previous: existing, next: existing };

  const slugSource =
    getMetadataValue(client, 'dashboard_slug') ?? current.project_name ?? current.project_id ?? '';
  const slug = slugSource.toLowerCase().replace(/\s+/g, '-');
  const next = buildCmosAddress(owner, slug);
  if (!next || next === existing) {
    return { rewritten: false, previous: existing, next: existing };
  }

  const ok = patchProjectIdentity(client, { cmos_address: next });
  return { rewritten: ok, previous: existing, next: ok ? next : existing };
}

/**
 * Apply a nested dot-notation field update to the project identity JSON.
 *
 * Supported depth: 1-level (top-level fields) or 2-level (e.g. type_fields.stack).
 * For deeper nesting, use patchProjectIdentity with a merged object.
 *
 * @returns true if updated, false if not found or path invalid
 */
export function applyProjectIdentityFieldUpdate(
  client: CmosDatabaseClient,
  path: string,
  value: unknown
): { success: boolean; message?: string } {
  ensureProjectIdentityRow(client);

  const current = getProjectIdentity(client);
  if (!current) {
    return { success: false, message: 'project_identity row not found' };
  }

  // Guard: path must be a non-empty string. Callers sometimes pass undefined when
  // they use "field" instead of "path" as the key name in the fieldUpdates array.
  if (!path || typeof path !== 'string') {
    return {
      success: false,
      message: `Invalid field path: ${JSON.stringify(path)}. Each fieldUpdates entry must have a "path" key (not "field"), e.g. {path: "project_name", value: "My Project"}.`,
    };
  }

  const parts = path.split('.');
  if (parts.length === 0 || parts.some((p) => !p)) {
    return { success: false, message: `Invalid field path: "${path}"` };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj = current as any;

  if (parts.length === 1) {
    obj[parts[0]] = value;
  } else if (parts.length === 2) {
    if (obj[parts[0]] === undefined || typeof obj[parts[0]] !== 'object') {
      obj[parts[0]] = {};
    }
    obj[parts[0]][parts[1]] = value;
  } else {
    return {
      success: false,
      message: `Path "${path}" is too deep. Use patchProjectIdentity for complex updates.`,
    };
  }

  obj['updated_at'] = new Date().toISOString();

  const now = new Date().toISOString();
  const result = client.execute(
    "UPDATE contexts SET content = ?, updated_at = ? WHERE id = 'project_identity'",
    [JSON.stringify(obj), now]
  );

  return { success: result.success, message: result.success ? undefined : result.error?.message };
}
