// ABOUTME: cmos_status tool — at-a-glance status payload for support and ops surfaces.
// ABOUTME: Sprint 62 m06; 5 required fields per dashboard-team shape sketch (msg 416315a7), cross-side parity with onboard.authState.authTier.

/**
 * cmos_status Tool
 *
 * Returns a structured status payload that mirrors what an operator or support
 * agent would want to see at a glance: which cmos:// address this project
 * advertises, which dashboard URL it's pointed at, the auth tier (mirroring
 * onboard.authState.authTier exactly so support can read both sides the same
 * way), and last-sync / last-delivery timestamps.
 *
 * Field contract is FROZEN per dashboard team msg 416315a7. Any shape change
 * to the 5 required fields requires coordination with cmos://derek/cmos-dashboard
 * before shipping (see cmos_decisions #642).
 *
 * @module tools/cmos/cmos-status
 */

import { z } from 'zod';
import { withClientAsync } from './client';
import type { CmosToolResult } from './types';
import { createSuccess } from './errors';
import { getProjectIdentity } from './project-identity';
import { DashboardClient, resolveDashboardBaseUrl } from './dashboard-client';
import { computeAuthState } from '../../auth/auth-state';
import type { AuthTier } from '../../auth/auth-state';

/**
 * Public status payload. The five top-level fields are FROZEN — adding,
 * removing, or renaming any of them is a cross-side parity break and must
 * coordinate with the dashboard team before shipping.
 */
export interface CmosStatusResult {
  /** Project's cmos:// identity, or "local-only" when not dashboard-connected. */
  cmos_address: string;
  /** Runtime CMOS_DASHBOARD_URL value (always defined post-Sprint 62 m02 bake). */
  dashboard_url: string;
  /** Mirrors onboard.authState.authTier exactly: device-code | legacy-env | password-fallback | none. */
  auth_tier: AuthTier;
  /** ISO timestamp of last successful /api/sync/* round-trip; null if never. */
  last_sync_at: string | null;
  /** ISO timestamp of last successful message delivery; null if never. */
  last_delivery_observed_at: string | null;
}

export const cmosStatusSchema = z.object({
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosStatusParams = z.infer<typeof cmosStatusSchema>;

export const cmosStatusToolDefinition = {
  name: 'cmos_status',
  description:
    'Return a structured status payload for the current project: cmos_address, dashboard_url, auth_tier, last_sync_at, last_delivery_observed_at. Mirrors onboard.authState.authTier on the auth_tier field for cross-side parity with the dashboard. Useful for support/ops triage and at-a-glance health.',
  inputSchema: {
    type: 'object',
    properties: {
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    additionalProperties: false,
  },
} as const;

/**
 * Local-only sentinel for the cmos_address field when the project has no
 * canonical address yet (fresh project) or its identity is stuck on
 * `cmos://unknown/*` (pre-canonicalization).
 */
const LOCAL_ONLY_ADDRESS = 'local-only';

function normalizeCmosAddress(raw: string | undefined | null): string {
  if (!raw) return LOCAL_ONLY_ADDRESS;
  const trimmed = raw.trim();
  if (!trimmed) return LOCAL_ONLY_ADDRESS;
  if (trimmed.startsWith('cmos://unknown/')) return LOCAL_ONLY_ADDRESS;
  return trimmed;
}

async function resolveLastSyncAt(projectRoot?: string): Promise<string | null> {
  // Build a dashboard client opportunistically. If we can't authenticate
  // (no credentials / unreachable / 4xx), the status payload returns null
  // for last_sync_at without surfacing an error.
  const clientResult = await DashboardClient.fromEnvForProject(projectRoot);
  if (!clientResult.success || !clientResult.data) {
    return null;
  }

  try {
    const statusResult = await clientResult.data.client.getSyncStatus();
    if (statusResult.success && statusResult.data) {
      return statusResult.data.lastSyncAt ?? null;
    }
  } catch {
    // Non-fatal — cmos_status must always return useful data even when the
    // dashboard is unreachable.
  }
  return null;
}

/**
 * Execute cmos_status. Always returns success=true with all 5 frozen fields
 * populated; the only error path is the underlying CMOS DB being absent
 * (handled by `withClientAsync`).
 */
export async function cmosStatus(
  params: CmosStatusParams = {}
): Promise<CmosToolResult<CmosStatusResult>> {
  return withClientAsync(
    async (client) => {
      const identity = getProjectIdentity(client);
      const cmos_address = normalizeCmosAddress(identity?.cmos_address);

      const dashboard_url = resolveDashboardBaseUrl();

      const authState = await computeAuthState({ projectRoot: params.projectRoot });

      const last_sync_at = await resolveLastSyncAt(params.projectRoot);

      const result: CmosStatusResult = {
        cmos_address,
        dashboard_url,
        auth_tier: authState.authTier,
        last_sync_at,
        last_delivery_observed_at: authState.lastDeliveryObservedAt,
      };

      return createSuccess(result);
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Format the status payload for LLM-readable text output. The structuredContent
 * carries the canonical 5-field shape; this format is for the chat surface.
 */
export function formatStatusForLLM(result: CmosToolResult<CmosStatusResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['cmos_status failed', '', `Error: ${error?.message ?? 'Unknown error'}`];
    if (error?.suggestion) {
      lines.push('', `Suggestion: ${error.suggestion}`);
    }
    return lines.join('\n');
  }

  const s = result.data;
  return [
    'CMOS Status',
    '',
    `cmos_address:              ${s.cmos_address}`,
    `dashboard_url:             ${s.dashboard_url}`,
    `auth_tier:                 ${s.auth_tier}`,
    `last_sync_at:              ${s.last_sync_at ?? 'never'}`,
    `last_delivery_observed_at: ${s.last_delivery_observed_at ?? 'never'}`,
    s.auth_tier === 'none'
      ? '\nNo dashboard credentials configured. Run cmos_auth(action="login") to bootstrap, or sign up at https://cmos.aquex.ai/register.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
