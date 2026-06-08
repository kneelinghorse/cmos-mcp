// ABOUTME: Resolves and persists the project owner (username) to metadata.owner by
// consulting the authenticated dashboard identity. Lets sync project-identity seeding
// produce canonical cmos://<owner>/<slug> addresses instead of cmos://unknown/*.

import type { CmosDatabaseClient } from './client';
import { DashboardClient } from './dashboard-client';

export interface OwnerResolutionResult {
  owner: string | null;
  source: 'metadata' | 'dashboard' | 'unresolved';
}

interface DashboardProjectLike {
  id?: string | null;
  owner?: string | null;
  address?: string | null;
  cmosAddress?: string | null;
  slug?: string | null;
  name?: string | null;
}

function parseOwnerFromAddress(address: string | null | undefined): string | null {
  if (!address || !address.startsWith('cmos://')) {
    return null;
  }

  const body = address.slice('cmos://'.length);
  const [owner] = body.split('/');
  return owner && owner.trim().length > 0 ? owner.trim() : null;
}

function normalizeSlug(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase().replace(/\s+/g, '-') : null;
}

function selectMatchingProject(
  projects: DashboardProjectLike[],
  hints: {
    dashboardProjectId: string | null;
    cmosAddress: string | null;
    projectId: string | null;
    projectName: string | null;
    dashboardSlug: string | null;
  }
): DashboardProjectLike | undefined {
  const trustedSlugs = new Set(
    [hints.projectId, hints.projectName]
      .map((value) => normalizeSlug(value))
      .filter((value): value is string => value !== null)
  );
  const expectedSlugs = new Set(
    [hints.dashboardSlug, hints.projectId, hints.projectName]
      .map((value) => normalizeSlug(value))
      .filter((value): value is string => value !== null)
  );

  if (hints.dashboardProjectId) {
    const byId = projects.find((project) => project.id === hints.dashboardProjectId);
    if (byId) {
      const matchedSlug = normalizeSlug(byId.slug ?? byId.name ?? null);
      const slugSetToTrust = trustedSlugs.size > 0 ? trustedSlugs : expectedSlugs;
      if (slugSetToTrust.size === 0 || (matchedSlug !== null && slugSetToTrust.has(matchedSlug))) {
        return byId;
      }
    }
  }

  if (expectedSlugs.size > 0) {
    const bySlug =
      (trustedSlugs.size > 0
        ? projects.find((project) => {
            const projectSlug = normalizeSlug(project.slug ?? project.name ?? null);
            return projectSlug !== null && trustedSlugs.has(projectSlug);
          })
        : undefined) ??
      projects.find((project) => {
        const projectSlug = normalizeSlug(project.slug ?? project.name ?? null);
        return projectSlug !== null && expectedSlugs.has(projectSlug);
      });
    if (bySlug) return bySlug;
  }

  if (hints.cmosAddress) {
    const byAddress = projects.find(
      (project) => (project.cmosAddress ?? project.address ?? null) === hints.cmosAddress
    );
    if (byAddress) return byAddress;
  }

  return projects[0];
}

function readMetadata(client: CmosDatabaseClient, key: string): string | null {
  const r = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key]);
  if (!r.success || !r.data) return null;
  const v = r.data.value;
  return v && v.trim().length > 0 ? v.trim() : null;
}

function readProjectIdentityAddress(client: CmosDatabaseClient): string | null {
  const result = client.getOne<{ content: string }>(
    "SELECT content FROM contexts WHERE id = 'project_identity'",
    []
  );
  if (!result.success || !result.data?.content) {
    return null;
  }

  try {
    const parsed = JSON.parse(result.data.content) as { cmos_address?: unknown };
    return typeof parsed.cmos_address === 'string' ? parsed.cmos_address.trim() : null;
  } catch {
    return null;
  }
}

function writeMetadata(client: CmosDatabaseClient, key: string, value: string): void {
  client.execute('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [key, value]);
}

/**
 * Resolve the project owner and persist it to `metadata.owner` when absent.
 *
 * Order:
 *   1. metadata.owner → done.
 *   2. Dashboard identity (login via env or provided client) → write metadata.owner +
 *      metadata.dashboard_username → done.
 *   3. Otherwise return { owner: null, source: 'unresolved' }.
 *
 * Never throws — dashboard reachability is best-effort. Callers should still tolerate
 * a null owner (the identity row will be seeded with an empty cmos_address until a
 * later checkpoint can fill it in).
 */
export async function resolveAndPersistOwner(
  client: CmosDatabaseClient,
  dashClientOverride?: DashboardClient
): Promise<OwnerResolutionResult> {
  const existing = readMetadata(client, 'owner');
  const currentAddress = readProjectIdentityAddress(client);
  const needsProjectIdentityRepair =
    currentAddress !== null &&
    (currentAddress.length === 0 || currentAddress.startsWith('cmos://unknown/'));
  const localProjectId = readMetadata(client, 'dashboard_project_id');
  const localDashboardSlug = readMetadata(client, 'dashboard_slug');
  const localProjectKey = readMetadata(client, 'project_id');
  const localProjectName = readMetadata(client, 'project_name');

  if (existing && !needsProjectIdentityRepair && !localProjectId) {
    return { owner: existing, source: 'metadata' };
  }

  let dashClient: DashboardClient | null = dashClientOverride ?? null;
  if (!dashClient) {
    const envResult = DashboardClient.fromEnv();
    if (!envResult.success || !envResult.data) {
      return existing
        ? { owner: existing, source: 'metadata' }
        : { owner: null, source: 'unresolved' };
    }
    dashClient = envResult.data;
  }

  // Trigger authentication. getMyProjects() is a cheap authenticated GET; its side
  // effect is populating dashClient.userIdentity with the username we need.
  const probe = await dashClient.getMyProjects();
  if (!probe.success) {
    return existing
      ? { owner: existing, source: 'metadata' }
      : { owner: null, source: 'unresolved' };
  }

  const identity = dashClient.userIdentity;
  let username = identity?.username ?? null;
  const projects = (probe.data?.projects ?? []) as DashboardProjectLike[];
  const matchedProject = selectMatchingProject(projects, {
    dashboardProjectId: localProjectId,
    cmosAddress: currentAddress,
    projectId: localProjectKey,
    projectName: localProjectName,
    dashboardSlug: localDashboardSlug,
  });

  if (matchedProject?.slug && matchedProject.slug.trim().length > 0) {
    writeMetadata(client, 'dashboard_slug', matchedProject.slug.trim());
  }
  if (matchedProject?.id && matchedProject.id.trim().length > 0) {
    writeMetadata(client, 'dashboard_project_id', matchedProject.id.trim());
  }

  // API-key auth skips the login that populates cachedIdentity. Fall back to the
  // matching project row returned by /api/projects/me.
  if (!username && matchedProject) {
    if (matchedProject.owner) {
      username = matchedProject.owner;
    } else {
      username = parseOwnerFromAddress(matchedProject.cmosAddress ?? matchedProject.address);
    }
  }

  if (!username || username.trim().length === 0) {
    return existing
      ? { owner: existing, source: 'metadata' }
      : { owner: null, source: 'unresolved' };
  }

  const trimmed = username.trim();
  writeMetadata(client, 'owner', trimmed);
  writeMetadata(client, 'dashboard_username', trimmed);
  return { owner: trimmed, source: 'dashboard' };
}
