// ABOUTME: cmos_message tool — cross-project messaging via cmos-dashboard REST API.
// ABOUTME: Supports backlog_request, question, status_update, info_push, intel_request, intel_alert.

/**
 * cmos_message Tool
 *
 * Consolidated messaging tool with action parameter support.
 * Actions: send, list (byte-capped summaries), get (full body by id), respond, ack, directory, whoami.
 * Calls the cmos-dashboard REST API via DashboardClient.
 *
 * @module tools/cmos/cmos-message
 */

import { z } from 'zod';
import path from 'path';
import { createError, createSuccess, CmosErrors } from './errors';
import type { CmosToolResult } from './types';
import {
  foreignDescriptor,
  frameForeignInline,
  UNTRUSTED_CONTENT_CONTRACT,
  type ProvenanceDescriptor,
} from '../../intelligence/provenance-frame';
import { computeAuthState, type AuthState } from '../../auth/auth-state';
import { DashboardClient, type DashboardMessage, type DirectoryProject } from './dashboard-client';
import { CMOS_PROJECT_ROOT_ENV } from './client';
import {
  assertSenderIdentityValid,
  readLocalSenderIdentity,
  resolveLocalSenderProjectId,
  SenderAttributionIncompleteError,
} from './sender-identity';
import {
  resolveSenderContext,
  SenderResolutionError,
  SERVER_INSTALL_ROOT,
  validateProject,
  type ResolutionCandidate,
  type SenderContext,
  type SenderResolutionSource,
} from '../../intelligence/sender-context';

// ─── Constants ───────────────────────────────────────────────────────────────

export const CMOS_MESSAGE_ACTIONS = [
  'send',
  'list',
  'get',
  'respond',
  'ack',
  'directory',
  'whoami',
] as const;
export type CmosMessageAction = (typeof CMOS_MESSAGE_ACTIONS)[number];

export const VALID_MESSAGE_TYPES = [
  'backlog_request',
  'question',
  'status_update',
  'info_push',
  'intel_request',
  'intel_alert',
] as const;
export type MessageType = (typeof VALID_MESSAGE_TYPES)[number];

export const VALID_MESSAGE_STATUSES = [
  'pending',
  'accepted',
  'declined',
  'replied',
  'acknowledged',
] as const;
export type MessageStatus = (typeof VALID_MESSAGE_STATUSES)[number];

export const VALID_RESPOND_STATUSES = ['accepted', 'declined', 'replied'] as const;
export type RespondStatus = (typeof VALID_RESPOND_STATUSES)[number];

export const VALID_MESSAGE_TABS = ['inbox', 'sent'] as const;
export type MessageTab = (typeof VALID_MESSAGE_TABS)[number];

/**
 * Message type to ActivityPub verb/object mapping.
 */
export const MESSAGE_TYPE_MAP: Record<MessageType, { verb: string; object: string }> = {
  backlog_request: { verb: 'create', object: 'mission' },
  question: { verb: 'ask', object: 'note' },
  status_update: { verb: 'update', object: 'mission' },
  info_push: { verb: 'add', object: 'reference' },
  intel_request: { verb: 'request', object: 'intelligence' },
  intel_alert: { verb: 'notify', object: 'intelligence' },
};

/** Regex for validating cmos:// addresses. */
const CMOS_ADDRESS_REGEX = /^cmos:\/\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)?$/;

/** Regex for validating UUID format. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Result Types ────────────────────────────────────────────────────────────

export interface MessageSendResult {
  messageId: string;
  targetAddress: string;
  status: string;
  summary: string;
  verb: string;
  object: string;
  /** Canonical cmos:// address of the sender, included when project_identity has a non-unknown address. */
  senderAddress?: string;
  /** Dashboard-reported delivery/routing status (e.g. "queued", "delivered"). Absent when the dashboard has not yet exposed an ACK surface. */
  deliveryStatus?: string;
}

/** s78-m05: a DashboardMessage plus an additive {source, trust:'foreign'} descriptor.
 *  All original fields (incl. `body`) are preserved for wire-contract compatibility;
 *  the descriptor signals to consumers that summary/body are untrusted foreign content.
 *  s80-m05: this is the BODY-ON-GET shape (cmos_message get) — the list shape is the
 *  byte-capped {@link MessageSummary} instead. */
export type FramedMessage = DashboardMessage & { provenance?: ProvenanceDescriptor };

/**
 * s80-m05 — the byte-capped list-row shape. The former `cmos_message(list)` spread the
 * WHOLE dashboard row (`{...msg}` incl. `payload.body` ~69% / `responseNotes` ~21% /
 * `evidence`), producing a ~410KB / 250-message overflow (#15/#346). This shape KEEPS
 * the light identity + attribution fields and DROPS the heavy body/notes/evidence —
 * those come via `cmos_message(get, messageId)`. Attribution uses the fields the
 * dashboard actually populates (probe 2026-07-09): `senderProject`/`senderDisplayName`
 * on inbox, `targetProject`/`targetMissionId` on sent.
 */
export interface MessageSummary {
  id: string;
  type: string;
  verb?: string;
  objectType?: string;
  status: string;
  summary: string;
  createdAt: string;
  respondedAt?: string | null;
  /** Inbox attribution. */
  senderProject?: string | null;
  senderDisplayName?: string | null;
  /** Sent attribution. */
  targetProject?: string | null;
  targetMissionId?: string | null;
  /** Additive foreign-content descriptor; `source` is the labeled sender (not "unknown"). */
  provenance?: ProvenanceDescriptor;
}

export interface MessageListResult {
  messages: MessageSummary[];
  unreadCount: number;
  totalCount: number;
  tab: string;
  statusFilter: string | null;
  /** s80-m05: non-fatal advisories (e.g. sent-tab is user-scoped across all projects). */
  warnings?: string[];
}

/** s80-m05 — the body-on-get result: the full framed message (body + notes + evidence). */
export interface MessageGetResult {
  message: FramedMessage;
}

export interface MessageRespondResult {
  messageId: string;
  previousStatus: string;
  currentStatus: string;
  respondedAt: string;
}

/** Sprint 72 m04 — mirrors the dashboard /ack response verbatim (pending→acknowledged). */
export interface MessageAckResult {
  messageId: string;
  previousStatus: string;
  status: string;
  ackedAt: string;
}

/** s78-m05: a DirectoryProject plus an additive provenance descriptor. Descriptions
 *  come from other users' project registrations and are untrusted foreign content. */
export type FramedDirectoryProject = DirectoryProject & { provenance?: ProvenanceDescriptor };

export interface MessageDirectoryResult {
  projects: FramedDirectoryProject[];
  totalCount: number;
}

export interface MessageWhoamiResult {
  resolved: {
    projectRoot: string | null;
    source: SenderResolutionSource | null;
    dashboardProjectId: string | null;
    cmosAddress: string | null;
    healed?: { previous: string; next: string };
  };
  candidates: ResolutionCandidate[];
  serverInstall: {
    root: string;
    wouldHaveBeenUsed: boolean;
    envCmosProjectRoot: string | null;
  };
  wouldAttributeAs: {
    senderProjectId: string | null;
    senderAddress: string | null;
  };
  /**
   * Sprint 57 m04 — diagnostic auth state from the local credential store
   * + the most recent dashboard deliveryAck. Always present so agents can
   * self-diagnose without calling cmos_auth(action=list).
   */
  authState?: AuthState;
}

export type CmosMessageResult =
  | MessageSendResult
  | MessageListResult
  | MessageGetResult
  | MessageRespondResult
  | MessageAckResult
  | MessageDirectoryResult
  | MessageWhoamiResult;

// ─── Zod Schema ──────────────────────────────────────────────────────────────

export const cmosMessageSchema = z
  .object({
    action: z
      .enum(CMOS_MESSAGE_ACTIONS)
      .describe('Message action: send | list | get | respond | ack | directory | whoami'),
    // send params
    targetAddress: z
      .string()
      .optional()
      .describe('cmos:// address of the recipient (required for send)'),
    type: z
      .enum(VALID_MESSAGE_TYPES)
      .optional()
      .describe(
        'Message type: backlog_request | question | status_update | info_push | intel_request | intel_alert (required for send)'
      ),
    summary: z
      .string()
      .optional()
      .describe('Short description displayed in inbox list (required for send)'),
    body: z.string().optional().describe('Full message content'),
    senderProjectId: z
      .string()
      .optional()
      .describe(
        "Sender's project UUID. Resolved from local metadata.dashboard_project_id when omitted; falls back to matching local cmos_address against /api/projects/me. Agents should leave this unset — it is authoritatively resolved from the cwd's project identity."
      ),
    evidence: z
      .array(z.object({ type: z.string(), id: z.string() }))
      .optional()
      .describe('TraceLab evidence references [{type, id}]'),
    // list params
    tab: z.enum(VALID_MESSAGE_TABS).optional().describe('inbox (default) or sent'),
    status: z
      .enum(VALID_MESSAGE_STATUSES)
      .optional()
      .describe('Filter by message status for list action'),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Max messages to return (default 20)'),
    // respond params
    messageId: z
      .string()
      .optional()
      .describe('UUID of the message to fetch (get), respond to (respond), or acknowledge (ack)'),
    respondStatus: z
      .enum(VALID_RESPOND_STATUSES)
      .optional()
      .describe('Response status: accepted | declined | replied (required for respond)'),
    notes: z.string().optional().describe('Response notes'),
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for CMOS database (defaults to cwd)'),
  })
  .strict();

export type CmosMessageParams = z.infer<typeof cmosMessageSchema>;

interface InternalCmosMessageParams extends CmosMessageParams {
  advertisedRoots?: readonly string[];
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

export const cmosMessageToolDefinition = {
  name: 'cmos_message',
  description:
    'Agent messaging tool for cross-project communication via cmos-dashboard. ' +
    'Actions: send (send message to another project), list (byte-capped inbox/sent summaries), ' +
    'get (full body + notes + evidence for one message by id), ' +
    'respond (accept/decline/reply to a message), ack (mark a pending message read/acknowledged), ' +
    'directory (discover addressable projects), whoami (diagnose sender attribution). ' +
    'Send auto-detects senderProjectId, normalizes addresses (spaces→hyphens, lowercase), ' +
    'and validates target against the project directory before sending. ' +
    'Requires CMOS_DASHBOARD_URL, CMOS_DASHBOARD_USER, and CMOS_DASHBOARD_PASSWORD environment variables. ' +
    UNTRUSTED_CONTENT_CONTRACT,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...CMOS_MESSAGE_ACTIONS],
        description: 'Message action: send | list | get | respond | ack | directory | whoami',
      },
      targetAddress: {
        type: 'string',
        description:
          'cmos:// address of the recipient. Format: cmos://username/project-name[/mission-id]',
      },
      type: {
        type: 'string',
        enum: [...VALID_MESSAGE_TYPES],
        description:
          'Message type: backlog_request | question | status_update | info_push | intel_request | intel_alert',
      },
      summary: {
        type: 'string',
        description: 'Short description displayed in inbox list',
      },
      body: { type: 'string', description: 'Full message content' },
      senderProjectId: {
        type: 'string',
        description:
          "Sender's project UUID. Resolved from local metadata.dashboard_project_id when omitted; falls back to matching local cmos_address against /api/projects/me. Agents typically do not need to pass this.",
      },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'Evidence type' },
            id: { type: 'string', description: 'Evidence identifier' },
          },
          required: ['type', 'id'],
        },
        description: 'TraceLab evidence references [{type, id}]',
      },
      tab: {
        type: 'string',
        enum: [...VALID_MESSAGE_TABS],
        description: 'inbox (default) or sent',
      },
      status: {
        type: 'string',
        enum: [...VALID_MESSAGE_STATUSES],
        description: 'Filter by message status for list action',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        description: 'Max messages to return (default 20)',
      },
      messageId: {
        type: 'string',
        description: 'UUID of the message to respond to (respond) or acknowledge (ack)',
      },
      respondStatus: {
        type: 'string',
        enum: [...VALID_RESPOND_STATUSES],
        description: 'Response status: accepted | declined | replied',
      },
      notes: { type: 'string', description: 'Response notes' },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
} as const;

// ─── Action Type Guard ───────────────────────────────────────────────────────

function isMessageAction(value: string): value is CmosMessageAction {
  return (CMOS_MESSAGE_ACTIONS as readonly string[]).includes(value);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalize a cmos:// address: lowercase, replace spaces with hyphens,
 * collapse multiple hyphens, trim whitespace from segments.
 * Handles input like "cmos://Derek/CMOS Dashboard" → "cmos://derek/cmos-dashboard".
 */
function normalizeAddress(address: string): string {
  if (!address.startsWith('cmos://')) return address;
  const body = address.slice('cmos://'.length);
  const normalized = body.toLowerCase().replace(/\s+/g, '-').replace(/-{2,}/g, '-');
  return `cmos://${normalized}`;
}

function normalizeOptionalEnvPath(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

function formatCandidateLine(candidate: ResolutionCandidate): string {
  const status = candidate.accepted ? '✓' : '✗';
  const location = candidate.projectRoot ? ` ${candidate.projectRoot}` : '';
  const rejectReason =
    !candidate.accepted && candidate.rejectReason ? ` — ${candidate.rejectReason}` : '';
  return `  ${status} ${candidate.source}${location}${rejectReason}`;
}

function resolvedFromContext(context: SenderContext | undefined): MessageWhoamiResult['resolved'] {
  if (!context) {
    return {
      projectRoot: null,
      source: null,
      dashboardProjectId: null,
      cmosAddress: null,
    };
  }

  return {
    projectRoot: context.projectRoot,
    source: context.source,
    dashboardProjectId: context.dashboardProjectId,
    cmosAddress: context.cmosAddress,
    ...(context.healed ? { healed: context.healed } : {}),
  };
}

function buildWhoamiWarnings(
  strictError: SenderResolutionError | undefined,
  relaxedContext: SenderContext | undefined,
  cwd: string,
  serverInstallRoot: string,
  envCmosProjectRoot: string | null,
  mcpRoots?: readonly string[]
): string[] {
  const warnings: string[] = [];

  if (envCmosProjectRoot) {
    warnings.push(
      `${CMOS_PROJECT_ROOT_ENV} is set to ${envCmosProjectRoot}. Sprint 53 removed it from tool-call resolution; it now exists only for .env bootstrap.`
    );
  }

  if (cwd === serverInstallRoot) {
    warnings.push(
      'cwd equals server install root; this path must never be the implicit sender for another project.'
    );
  }

  if ((!mcpRoots || mcpRoots.length === 0) && !relaxedContext?.projectRoot) {
    warnings.push(
      'No MCP roots were advertised and no local CMOS database was resolved; diagnosis is limited to cwd/registry inspection.'
    );
  }

  if (relaxedContext?.healed) {
    warnings.push(
      `Healed stale cmos_address from ${relaxedContext.healed.previous} to ${relaxedContext.healed.next}.`
    );
  }

  if (strictError) {
    warnings.push(
      'Next outbound send would fail-closed until sender identity resolves authoritatively.'
    );
  }

  return warnings;
}

export interface MessageWhoamiOptions {
  explicitProjectRoot?: string;
  mcpRoots?: readonly string[];
  cwdOverride?: string;
  serverInstallRootOverride?: string;
}

export async function getWhoamiDiagnostics(
  options: MessageWhoamiOptions = {}
): Promise<CmosToolResult<MessageWhoamiResult>> {
  const cwd = path.resolve(options.cwdOverride ?? process.cwd());
  const serverInstallRoot = path.resolve(options.serverInstallRootOverride ?? SERVER_INSTALL_ROOT);
  const envCmosProjectRoot = normalizeOptionalEnvPath(process.env[CMOS_PROJECT_ROOT_ENV]);
  const serverInstall = {
    root: serverInstallRoot,
    wouldHaveBeenUsed:
      cwd === serverInstallRoot ||
      (envCmosProjectRoot !== null && path.resolve(envCmosProjectRoot) === serverInstallRoot),
    envCmosProjectRoot,
  };

  let strictContext: SenderContext | undefined;
  let strictError: SenderResolutionError | undefined;
  try {
    strictContext = await resolveSenderContext({
      explicitProjectRoot: options.explicitProjectRoot,
      mcpRoots: options.mcpRoots,
      requireSenderIdentity: true,
      cwdOverride: options.cwdOverride,
      serverInstallRootOverride: options.serverInstallRootOverride,
    });
  } catch (err) {
    if (err instanceof SenderResolutionError) {
      strictError = err;
    } else {
      throw err;
    }
  }

  let relaxedContext: SenderContext | undefined;
  let relaxedError: SenderResolutionError | undefined;
  if (!strictContext) {
    try {
      relaxedContext = await resolveSenderContext({
        explicitProjectRoot: options.explicitProjectRoot,
        mcpRoots: options.mcpRoots,
        requireSenderIdentity: false,
        cwdOverride: options.cwdOverride,
        serverInstallRootOverride: options.serverInstallRootOverride,
      });
    } catch (err) {
      if (err instanceof SenderResolutionError) {
        relaxedError = err;
      } else {
        throw err;
      }
    }
  }

  const resolvedContext = strictContext ?? relaxedContext;
  const candidates =
    strictContext?.candidates ??
    strictError?.candidates ??
    relaxedContext?.candidates ??
    relaxedError?.candidates ??
    [];

  // Sprint 57 m04: attach the local credential store + last deliveryAck snapshot
  // so agents see auth state without a separate cmos_auth(action=list) call.
  // Best-effort — never fail whoami because credential-store I/O hiccupped.
  let authState: AuthState | undefined;
  try {
    const authProjectRoot =
      resolvedContext?.projectRoot ?? options.explicitProjectRoot ?? undefined;
    authState = await computeAuthState(authProjectRoot ? { projectRoot: authProjectRoot } : {});
  } catch {
    authState = undefined;
  }

  const data: MessageWhoamiResult = {
    resolved: resolvedFromContext(resolvedContext),
    candidates: [...candidates],
    serverInstall,
    wouldAttributeAs: {
      senderProjectId: strictContext?.dashboardProjectId ?? null,
      senderAddress: strictContext?.cmosAddress ?? null,
    },
    ...(authState ? { authState } : {}),
  };

  const warnings = buildWhoamiWarnings(
    strictError,
    relaxedContext,
    cwd,
    serverInstallRoot,
    envCmosProjectRoot,
    options.mcpRoots
  );
  if (authState?.warning) {
    warnings.push(authState.warning);
  }

  if (strictContext) {
    return createSuccess<MessageWhoamiResult>(data, warnings);
  }

  return {
    success: false,
    data,
    error: {
      code: strictError?.code ?? 'SENDER_UNRESOLVABLE',
      message:
        strictError?.message ??
        'Could not authoritatively resolve sender context for the next outbound send.',
      suggestion:
        'Pass projectRoot explicitly, run from a directory with cmos/db/cmos.sqlite, or ensure the local CMOS DB has a UUID metadata.dashboard_project_id and canonical project_identity.cmos_address.',
    },
    warnings,
  };
}

/**
 * Fetch the project directory and return addresses that are close matches
 * to the given target. Uses simple substring matching on address components.
 */
async function getSuggestedAddresses(
  client: DashboardClient,
  targetAddress: string
): Promise<string[]> {
  const dirResult = await client.listDirectory();
  if (!dirResult.success || !dirResult.data?.projects) {
    return [];
  }

  // Extract the project slug from the target (e.g. "cmos-dashboard" from "cmos://derek/cmos-dashboard")
  const parts = targetAddress.replace('cmos://', '').split('/');
  const targetSlug = parts[1] ?? '';
  const targetOwner = parts[0] ?? '';

  return dirResult.data.projects
    .filter((p) => {
      const addr = p.address;
      const addrParts = addr.replace('cmos://', '').split('/');
      const slug = addrParts[1] ?? '';
      const owner = addrParts[0] ?? '';
      // Match on same owner, or slug contains/is-contained-by target slug
      return owner === targetOwner || slug.includes(targetSlug) || targetSlug.includes(slug);
    })
    .slice(0, 5)
    .map((p) => p.address);
}

// ─── Action Handlers ─────────────────────────────────────────────────────────

async function handleSend(
  params: InternalCmosMessageParams,
  client: DashboardClient
): Promise<CmosToolResult<MessageSendResult>> {
  // Validate required params
  if (!params.targetAddress) {
    return createError(CmosErrors.missingParameter('targetAddress'));
  }
  if (!params.type) {
    return createError(CmosErrors.missingParameter('type'));
  }
  if (!params.summary) {
    return createError(CmosErrors.missingParameter('summary'));
  }

  // Normalize address: lowercase, spaces → hyphens
  const targetAddress = normalizeAddress(params.targetAddress);

  // Validate cmos:// address format (after normalization)
  if (!CMOS_ADDRESS_REGEX.test(targetAddress)) {
    return createError(
      CmosErrors.invalidParameter('targetAddress', params.targetAddress, [
        'cmos://username/project-name',
        'cmos://username/project-name/mission-id',
      ])
    );
  }

  // Pre-send address resolution — validate target exists
  const resolveResult = await client.resolveAddress({ address: targetAddress });
  if (!resolveResult.success) {
    // On 404, try to suggest close matches from directory
    if (resolveResult.error?.code === 'DASHBOARD_NOT_FOUND') {
      const suggestions = await getSuggestedAddresses(client, targetAddress);
      const hint =
        suggestions.length > 0
          ? `Did you mean: ${suggestions.join(', ')}?`
          : 'Use cmos_message action="directory" to see all addressable projects.';
      return createError(
        CmosErrors.dashboardNotFound(
          targetAddress,
          `Address '${targetAddress}' not found in project directory`,
          hint
        )
      );
    }
    // For other errors (auth, network), pass through
    return createError<MessageSendResult>(resolveResult.error!);
  }

  // Sprint 53 m02: the dispatcher already ran `resolveSenderContext` with
  // `requireSenderIdentity=true` and passed the resolved projectRoot through in
  // `params.projectRoot`, so `readLocalSenderIdentity` opens the right DB. The
  // `assertSenderIdentityValid` call below is defense-in-depth — if any future
  // caller bypasses the dispatcher boundary and invokes `handleSend` directly
  // with an unresolvable project, we fail-closed here with
  // `SENDER_ATTRIBUTION_INCOMPLETE` rather than silently publishing a null sender.
  // (The dispatcher's `SENDER_UNRESOLVABLE` and this layer's
  // `SENDER_ATTRIBUTION_INCOMPLETE` are distinct so operators can tell which
  // gate rejected the send.)
  const localIdentity = await readLocalSenderIdentity(params.projectRoot);
  const senderProjectId =
    params.senderProjectId ?? (await resolveLocalSenderProjectId(client, localIdentity));
  const senderAddress = localIdentity.cmosAddress ?? undefined;

  try {
    assertSenderIdentityValid(localIdentity, senderProjectId);
  } catch (err) {
    if (err instanceof SenderAttributionIncompleteError) {
      return createError<MessageSendResult>({
        code: err.code,
        message: err.message,
        suggestion:
          'The dispatcher should have caught this via resolveSenderContext — report the call site so ' +
          'it can be routed through the audited boundary. Verify CMOS DB has a UUID ' +
          'metadata.dashboard_project_id and a canonical project_identity.cmos_address.',
      });
    }
    throw err;
  }

  if (senderAddress && params.advertisedRoots && params.advertisedRoots.length > 0) {
    let matchedAdvertisedRoot = false;
    for (const root of params.advertisedRoots) {
      const validation = await validateProject(root, { heal: false });
      if (validation.cmosAddress === senderAddress) {
        matchedAdvertisedRoot = true;
        break;
      }
    }

    if (!matchedAdvertisedRoot) {
      return createError<MessageSendResult>({
        code: 'SENDER_ATTRIBUTION_MISMATCH',
        message: `Resolved sender address '${senderAddress}' does not match any advertised MCP root.`,
        suggestion:
          'Verify the MCP client is advertising the intended workspace roots and that the local sender identity belongs to one of them before retrying the send.',
      });
    }
  }

  // Map type to verb/object
  const mapping = MESSAGE_TYPE_MAP[params.type];

  const result = await client.sendMessage({
    targetAddress,
    type: params.type,
    summary: params.summary,
    body: params.body,
    evidence: params.evidence,
    senderProjectId,
    senderAddress,
  });

  if (!result.success) {
    return createError<MessageSendResult>(result.error!);
  }

  const response = result.data!;
  const out: MessageSendResult = {
    messageId: response.id,
    targetAddress,
    status: response.status ?? 'pending',
    summary: params.summary,
    verb: mapping.verb,
    object: mapping.object,
  };
  // Echo the address we sent — useful for callers that want to verify attribution
  // without opening the DB themselves. Only included when we actually sent one.
  if (senderAddress) out.senderAddress = senderAddress;
  // Forward dashboard-reported routing/delivery status when present. Absence here
  // is expected today and does not imply failure; see DashboardMessage.deliveryStatus.
  if (response.deliveryStatus) out.deliveryStatus = response.deliveryStatus;
  return createSuccess<MessageSendResult>(out);
}

/**
 * s80-m05 — the human-readable source for a message's foreign-provenance descriptor.
 * Uses the fields the dashboard actually populates (probe 2026-07-09): `senderProject` /
 * `senderDisplayName` on inbox, `targetProject` on sent. The legacy `from` / `senderAddress`
 * / `from_project_id` are empty on live rows, which is why the old provenance read
 * "unknown source" — reading them last is a harmless fallback for older payloads.
 */
export function attributionSource(msg: DashboardMessage, tab: string): string | undefined {
  if (tab === 'sent') {
    // s80-m05 review: keep the `to_project_id` fallback symmetric with the inbox
    // `from_project_id` rung below, so an intel/sent row that populated only the
    // recipient id still labels a source instead of "unknown".
    return msg.targetProject ?? msg.to ?? msg.to_project_id ?? undefined;
  }
  return (
    msg.senderProject ??
    msg.senderDisplayName ??
    msg.from ??
    msg.senderAddress ??
    msg.from_project_id ??
    undefined
  );
}

/**
 * s80-m05 — map a raw dashboard row to the byte-capped {@link MessageSummary}. KEEPS the
 * light identity + attribution fields; DROPS the heavy `payload.body` / `responseNotes` /
 * `evidence` (those come via `cmos_message(get, messageId)`). Provenance `source` is the
 * labeled sender/recipient, not a misleading "unknown source".
 */
export function mapToMessageSummary(msg: DashboardMessage, tab: string): MessageSummary {
  const summary: MessageSummary = {
    id: msg.id,
    type: msg.type,
    verb: msg.verb,
    objectType: msg.objectType,
    status: msg.status,
    summary: msg.summary,
    createdAt: msg.createdAt,
    respondedAt: msg.respondedAt ?? null,
    provenance: foreignDescriptor(attributionSource(msg, tab)),
  };
  if (tab === 'sent') {
    summary.targetProject = msg.targetProject ?? null;
    summary.targetMissionId = msg.targetMissionId ?? null;
  } else {
    summary.senderProject = msg.senderProject ?? null;
    summary.senderDisplayName = msg.senderDisplayName ?? null;
  }
  return summary;
}

async function handleList(
  params: CmosMessageParams,
  client: DashboardClient
): Promise<CmosToolResult<MessageListResult>> {
  const tab = params.tab ?? 'inbox';
  const limit = params.limit ?? 20;

  const result = await client.listMessages({
    tab,
    status: params.status,
    limit,
  });

  if (!result.success) {
    return createError<MessageListResult>(result.error!);
  }

  // s80-m05: byte-capped summaries — full body/notes/evidence come via `get`. The
  // summary + provenance are inbound foreign content (untrusted DATA, not instructions).
  const messages = result.data!.messages.map((msg) => mapToMessageSummary(msg, tab));

  // s80-m05: the sent tab is user-scoped across every project the operator owns; the
  // dashboard does not yet scope it by project key. Surface that as a non-fatal warning
  // rather than silently over-returning (row-count project-pin is best-effort).
  const warnings =
    tab === 'sent'
      ? [
          'sent is user-scoped across all your projects; per-project attribution is pending dashboard support.',
        ]
      : undefined;

  return createSuccess<MessageListResult>({
    messages,
    unreadCount: result.data!.unreadCount,
    totalCount: result.data!.totalCount,
    tab,
    statusFilter: params.status ?? null,
    ...(warnings ? { warnings } : {}),
  });
}

async function handleGet(
  params: CmosMessageParams,
  client: DashboardClient
): Promise<CmosToolResult<MessageGetResult>> {
  if (!params.messageId) {
    return createError<MessageGetResult>(CmosErrors.missingParameter('messageId'));
  }
  if (!UUID_REGEX.test(params.messageId)) {
    return createError<MessageGetResult>(
      CmosErrors.invalidParameter('messageId', params.messageId, [
        'UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      ])
    );
  }

  // s80-m05 (F4=A): there is no dashboard GET /api/messages/:id yet (notify-not-block
  // ask). Serve body-on-get client-side by paging the most recent messages per tab and
  // selecting by id. Best-effort: bounded to the newest `FETCH_LIMIT` per tab, UNFILTERED
  // (get is NOT project-pinned — see index.ts — so a message from any of the operator's
  // projects is visible). s80-m05 review: a transient failure on ONE tab must not hide a
  // message in the OTHER, so remember the error and keep looking.
  const FETCH_LIMIT = 100;
  let lastError: NonNullable<CmosToolResult<MessageGetResult>['error']> | undefined;
  for (const tab of ['inbox', 'sent'] as const) {
    const result = await client.listMessages({ tab, limit: FETCH_LIMIT });
    if (!result.success) {
      lastError = result.error!;
      continue;
    }
    const found = result.data!.messages.find((m) => m.id === params.messageId);
    if (found) {
      const message: FramedMessage = {
        ...found,
        provenance: foreignDescriptor(attributionSource(found, tab)),
      };
      return createSuccess<MessageGetResult>({ message });
    }
  }

  // Not found on any tab that we could read. If a tab fetch actually FAILED, surface
  // that transport error (the search was incomplete) rather than a misleading not-found.
  if (lastError) {
    return createError<MessageGetResult>(lastError);
  }
  return createError<MessageGetResult>({
    code: 'MESSAGE_NOT_FOUND',
    message: `Message ${params.messageId} was not found in the newest ${FETCH_LIMIT} inbox or sent messages.`,
    suggestion:
      'It may predate the fetch window, or have been surfaced only under a status filter (get pages UNFILTERED). A dashboard GET /api/messages/:id endpoint is a pending notify-not-block ask that will make get exact.',
  });
}

async function handleRespond(
  params: CmosMessageParams,
  client: DashboardClient
): Promise<CmosToolResult<MessageRespondResult>> {
  // Validate required params
  if (!params.messageId) {
    return createError(CmosErrors.missingParameter('messageId'));
  }
  if (!params.respondStatus) {
    return createError(CmosErrors.missingParameter('respondStatus'));
  }

  // Validate UUID format
  if (!UUID_REGEX.test(params.messageId)) {
    return createError(
      CmosErrors.invalidParameter('messageId', params.messageId, [
        'UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      ])
    );
  }

  const result = await client.respondToMessage({
    messageId: params.messageId,
    status: params.respondStatus,
    notes: params.notes,
  });

  if (!result.success) {
    return createError<MessageRespondResult>(result.error!);
  }

  return createSuccess<MessageRespondResult>({
    messageId: params.messageId,
    previousStatus: 'pending',
    currentStatus: params.respondStatus,
    respondedAt: result.data!.updatedAt ?? new Date().toISOString(),
  });
}

/**
 * Acknowledge (mark-read) a pending message (Sprint 72 m04). A status-only round-trip to
 * the dashboard's POST /api/messages/:id/ack (LIVE, migration 031) — modeled on
 * handleRespond. Returns the dashboard's data verbatim ({messageId, previousStatus,
 * status, ackedAt}); do NOT hardcode previousStatus. 404/403/409 surface as structured
 * CmosErrors via the client's request error mapping (parity with respond).
 */
async function handleAck(
  params: CmosMessageParams,
  client: DashboardClient
): Promise<CmosToolResult<MessageAckResult>> {
  if (!params.messageId) {
    return createError(CmosErrors.missingParameter('messageId'));
  }
  if (!UUID_REGEX.test(params.messageId)) {
    return createError(
      CmosErrors.invalidParameter('messageId', params.messageId, [
        'UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      ])
    );
  }

  const result = await client.ackMessage({ messageId: params.messageId });
  if (!result.success) {
    return createError<MessageAckResult>(result.error!);
  }

  // Return the dashboard's data verbatim (previousStatus is authoritative, not hardcoded).
  return createSuccess<MessageAckResult>(result.data!);
}

async function handleDirectory(
  _params: CmosMessageParams,
  client: DashboardClient
): Promise<CmosToolResult<MessageDirectoryResult>> {
  const result = await client.listDirectory();

  if (!result.success) {
    return createError<MessageDirectoryResult>(result.error!);
  }

  // s78-m05: directory descriptions are authored by other users — tag each with a
  // foreign-provenance descriptor (own-project entries stay 'local').
  const framedProjects: FramedDirectoryProject[] = result.data!.projects.map((p) => ({
    ...p,
    provenance: p.isOwner
      ? { source: p.address, trust: 'local' as const }
      : foreignDescriptor(p.address),
  }));

  return createSuccess<MessageDirectoryResult>({
    projects: framedProjects,
    totalCount: result.data!.totalCount,
  });
}

async function handleWhoami(
  params: CmosMessageParams
): Promise<CmosToolResult<MessageWhoamiResult>> {
  return getWhoamiDiagnostics({ explicitProjectRoot: params.projectRoot });
}

// ─── Main Dispatcher ─────────────────────────────────────────────────────────

/**
 * Consolidated cmos_message tool.
 * Creates a DashboardClient from env and dispatches to action handlers.
 */
export async function cmosMessage(
  params: InternalCmosMessageParams
): Promise<CmosToolResult<CmosMessageResult>> {
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';

  if (!isMessageAction(actionValue)) {
    return createError<CmosMessageResult>(
      CmosErrors.invalidAction('cmos_message', actionValue, CMOS_MESSAGE_ACTIONS)
    );
  }

  if (actionValue === 'whoami') {
    return handleWhoami(params);
  }

  // Create client via the credential-store-aware factory so device-code-minted
  // user-scoped keys (Sprint 57) reach the messaging surface. The legacy fromEnv()
  // factory only consults env-var auth and silently 401s when only a user-scoped
  // key in the credential store is available.
  const clientResult = await DashboardClient.fromEnvForProject(params.projectRoot);
  if (!clientResult.success) {
    return createError<CmosMessageResult>(clientResult.error!);
  }

  const client = clientResult.data!.client;

  switch (actionValue) {
    case 'send':
      return handleSend(params, client);
    case 'list':
      return handleList(params, client);
    case 'get':
      return handleGet(params, client);
    case 'respond':
      return handleRespond(params, client);
    case 'ack':
      return handleAck(params, client);
    case 'directory':
      return handleDirectory(params, client);
  }
}

// ─── LLM Formatter ───────────────────────────────────────────────────────────

function formatSendForLLM(result: CmosToolResult<MessageSendResult>): string {
  if (!result.success) {
    return `Failed to send message: ${result.error?.message ?? 'Unknown error'}\n${result.error?.suggestion ?? ''}`;
  }

  const d = result.data!;
  const lines = [
    `Message sent successfully`,
    `  ID: ${d.messageId}`,
    `  To: ${d.targetAddress}`,
    `  Summary: ${d.summary}`,
    `  Type: ${d.verb}/${d.object}`,
    `  Status: ${d.status}`,
  ];
  return lines.join('\n');
}

function formatListForLLM(result: CmosToolResult<MessageListResult>): string {
  if (!result.success) {
    return `Failed to list messages: ${result.error?.message ?? 'Unknown error'}\n${result.error?.suggestion ?? ''}`;
  }

  const d = result.data!;
  const lines = [`Messages (${d.tab}) — ${d.totalCount} total, ${d.unreadCount} unread`];

  if (d.statusFilter) {
    lines[0] += ` (filtered: ${d.statusFilter})`;
  }

  for (const w of d.warnings ?? []) {
    lines.push(`  ⚠ ${w}`);
  }

  if (d.messages.length === 0) {
    lines.push('  No messages');
  } else {
    for (const msg of d.messages) {
      // s78-m05: the summary is inbound foreign content — render it inside an untrusted
      // fence labeled with the sender, never as a bare instruction-looking line. s80-m05:
      // the label comes from the populated senderProject/targetProject (was "unknown sender").
      const src =
        msg.provenance?.source ??
        msg.senderProject ??
        msg.senderDisplayName ??
        msg.targetProject ??
        'unknown sender';
      lines.push(`  [${msg.status}] (${msg.id}) ${frameForeignInline(msg.summary, src)}`);
    }
  }
  lines.push('  (use cmos_message get, messageId=<id> for the full body)');

  return lines.join('\n');
}

function formatGetForLLM(result: CmosToolResult<MessageGetResult>): string {
  if (!result.success) {
    return `Failed to get message: ${result.error?.message ?? 'Unknown error'}\n${result.error?.suggestion ?? ''}`;
  }
  const m = result.data!.message;
  const src = m.provenance?.source ?? m.senderProject ?? m.senderDisplayName ?? 'unknown sender';
  const body = m.payload?.body ?? m.body ?? '(no body)';
  const lines = [
    `Message ${m.id} [${m.status}]`,
    `  Type: ${m.verb ?? m.type}/${m.objectType ?? ''}`,
    `  Summary: ${frameForeignInline(m.summary, src)}`,
    `  Body:`,
    frameForeignInline(body, src),
  ];
  if (m.responseNotes) lines.push(`  Response notes: ${frameForeignInline(m.responseNotes, src)}`);
  return lines.join('\n');
}

function formatRespondForLLM(result: CmosToolResult<MessageRespondResult>): string {
  if (!result.success) {
    return `Failed to respond to message: ${result.error?.message ?? 'Unknown error'}\n${result.error?.suggestion ?? ''}`;
  }

  const d = result.data!;
  return [
    `Response recorded`,
    `  Message: ${d.messageId}`,
    `  Status: ${d.previousStatus} → ${d.currentStatus}`,
    `  Responded at: ${d.respondedAt}`,
  ].join('\n');
}

function formatAckForLLM(result: CmosToolResult<MessageAckResult>): string {
  if (!result.success) {
    return `Failed to acknowledge message: ${result.error?.message ?? 'Unknown error'}\n${result.error?.suggestion ?? ''}`;
  }

  const d = result.data!;
  return [
    `Message acknowledged`,
    `  Message: ${d.messageId}`,
    `  Status: ${d.previousStatus} → ${d.status}`,
    `  Acked at: ${d.ackedAt}`,
  ].join('\n');
}

function formatDirectoryForLLM(result: CmosToolResult<MessageDirectoryResult>): string {
  if (!result.success) {
    return `Failed to list project directory: ${result.error?.message ?? 'Unknown error'}\n${result.error?.suggestion ?? ''}`;
  }

  const d = result.data!;
  const lines = [`Project Directory — ${d.totalCount} addressable project(s)`];

  if (d.projects.length === 0) {
    lines.push('  No projects found');
  } else {
    for (const p of d.projects) {
      // s78-m05: descriptions are foreign-authored — frame non-owner descriptions untrusted.
      const desc = p.description
        ? p.provenance?.trust === 'foreign'
          ? ` — ${frameForeignInline(p.description, p.address)}`
          : ` — ${p.description}`
        : '';
      lines.push(`  ${p.address} (${p.id})${desc}`);
    }
  }

  return lines.join('\n');
}

function formatWhoamiForLLM(result: CmosToolResult<MessageWhoamiResult>): string {
  const d = result.data;
  const lines = ['Attribution diagnosis'];

  if (result.success) {
    const sender = d?.wouldAttributeAs.senderAddress ?? 'unknown sender';
    const senderId = d?.wouldAttributeAs.senderProjectId
      ? ` (${d.wouldAttributeAs.senderProjectId})`
      : '';
    lines.push(`  Next outbound send would attribute as: ${sender}${senderId}`);
  } else {
    lines.push('  Next outbound send would fail closed');
    if (result.error?.message) {
      lines.push(`  Error: ${result.error.message}`);
    }
  }

  lines.push(`  Resolved root: ${d?.resolved.projectRoot ?? 'none'}`);
  lines.push(`  Source: ${d?.resolved.source ?? 'none'}`);
  lines.push(`  Dashboard project ID: ${d?.resolved.dashboardProjectId ?? 'none'}`);
  lines.push(`  CMOS address: ${d?.resolved.cmosAddress ?? 'none'}`);
  if (d?.resolved.healed) {
    lines.push(`  Healed address: ${d.resolved.healed.previous} -> ${d.resolved.healed.next}`);
  }
  lines.push(`  Server install root: ${d?.serverInstall.root ?? SERVER_INSTALL_ROOT}`);
  lines.push(
    `  Legacy server-install fallback risk: ${d?.serverInstall.wouldHaveBeenUsed ? 'yes' : 'no'}`
  );
  lines.push(`  ${CMOS_PROJECT_ROOT_ENV}: ${d?.serverInstall.envCmosProjectRoot ?? 'unset'}`);

  if (result.warnings && result.warnings.length > 0) {
    lines.push('Warnings:');
    for (const warning of result.warnings) {
      lines.push(`  - ${warning}`);
    }
  }

  lines.push('Candidate trace:');
  if (!d || d.candidates.length === 0) {
    lines.push('  No candidates recorded');
  } else {
    for (const candidate of d.candidates) {
      lines.push(formatCandidateLine(candidate));
    }
  }

  return lines.join('\n');
}

export function formatMessageForLLM(
  action: string | undefined,
  result: CmosToolResult<CmosMessageResult>
): string {
  if (!result.success && result.error?.code === 'INVALID_ACTION') {
    const availableActions =
      result.error.availableActions ??
      result.error.available_actions ??
      result.error.validValues ??
      [];

    const lines = ['Failed to execute cmos_message', '', `Error: ${result.error.message}`];

    if (availableActions.length > 0) {
      lines.push('', `Available actions: ${availableActions.join(', ')}`);
    }

    if (result.error.suggestion) {
      lines.push('', `Suggestion: ${result.error.suggestion}`);
    }

    return lines.join('\n');
  }

  switch (action) {
    case 'send':
      return formatSendForLLM(result as CmosToolResult<MessageSendResult>);
    case 'list':
      return formatListForLLM(result as CmosToolResult<MessageListResult>);
    case 'get':
      return formatGetForLLM(result as CmosToolResult<MessageGetResult>);
    case 'respond':
      return formatRespondForLLM(result as CmosToolResult<MessageRespondResult>);
    case 'ack':
      return formatAckForLLM(result as CmosToolResult<MessageAckResult>);
    case 'directory':
      return formatDirectoryForLLM(result as CmosToolResult<MessageDirectoryResult>);
    case 'whoami':
      return formatWhoamiForLLM(result as CmosToolResult<MessageWhoamiResult>);
    default:
      return result.success ? 'Message action completed' : 'Failed to execute cmos_message';
  }
}
