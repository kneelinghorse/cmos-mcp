// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s95-m06 — the one reading of a project's level, so one store never reads as two: the
// ABOUTME: stored project_type, else the identity's or a legacy context's tier; else Builder.

import type { RbookDatabaseClient } from './client';
import { levelOfTier, type ProjectLevel } from './rules-files';

/**
 * The tier from a store's sources, in order: `metadata.project_type`, the project identity row's
 * tier, and the tier a legacy `project_context` names (the one an identity row is seeded from,
 * project-identity.ts `seedIdentityFor`). Each is trimmed; null when none names one. Null and
 * unknown tiers read as Builder through {@link levelOfTier}, the level stores had before tiers
 * existed (#1219).
 */
export function tierOf(
  projectType: string | null | undefined,
  identityContent: string | null | undefined,
  projectContextContent?: string | null
): string | null {
  return projectType?.trim() || jsonTier(identityContent) || jsonTier(projectContextContent);
}

function jsonTier(content: string | null | undefined): string | null {
  if (!content) return null;
  try {
    const tier = (JSON.parse(content) as { tier?: unknown } | null)?.tier;
    return typeof tier === 'string' && tier.trim() ? tier.trim() : null;
  } catch {
    return null;
  }
}

/** The SQL that reads each of {@link tierOf}'s sources, for a client or a raw connection. */
export const TIER_SOURCES = [
  "SELECT value FROM metadata WHERE key = 'project_type'",
  "SELECT content FROM contexts WHERE id = 'project_identity'",
  "SELECT content FROM contexts WHERE id = 'project_context'",
] as const;

/** The tier a store holds, as {@link tierOf} reads it. */
export function readProjectTier(client: RbookDatabaseClient): string | null {
  const [projectType, identity, projectContext] = TIER_SOURCES.map((sql) => {
    const row = client.getOne<Record<string, string | null>>(sql, []);
    return row.success && row.data ? Object.values(row.data)[0] : null;
  });
  return tierOf(projectType, identity, projectContext);
}

/** The project's level, as every level-aware answer reads it. */
export function readProjectLevel(client: RbookDatabaseClient): ProjectLevel {
  return levelOfTier(readProjectTier(client));
}
