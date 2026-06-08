/**
 * cmos_resolve_references Tool
 *
 * MCP tool for parsing mission reference_docs and categorizing references
 * by type (TraceLab URIs, local docs, web URLs).
 *
 * This tool does NOT fetch TraceLab content - it only parses and categorizes.
 * Agents use TraceLab MCP tools directly for fetching.
 *
 * @module tools/cmos/cmos-resolve-references
 */

import { z } from 'zod';
import { withClientValidated } from './client';
import type { CmosToolResult, Mission } from './types';
import { createError, createSuccess, CmosErrors } from './errors';

/**
 * TraceLab URI types supported.
 */
export const TRACELAB_URI_TYPES = [
  'project',
  'collection',
  'report',
  'document',
  'chunk',
  'search',
] as const;

export type TracelabUriType = (typeof TRACELAB_URI_TYPES)[number];

/**
 * Parsed TraceLab reference.
 */
export interface TracelabRef {
  /** Original URI string */
  uri: string;

  /** Type of TraceLab resource */
  type: TracelabUriType | 'unknown';

  /** Resource ID extracted from URI */
  resourceId: string | null;

  /** Any additional path segments */
  path: string | null;
}

/**
 * Local document reference.
 */
export interface LocalDocRef {
  /** Original reference string */
  ref: string;

  /** Path to the document */
  path: string;
}

/**
 * Web URL reference.
 */
export interface WebUrlRef {
  /** Original URL string */
  url: string;

  /** URL hostname */
  hostname: string | null;
}

/**
 * Result of reference resolution.
 */
export interface CmosResolveReferencesResult {
  /** Mission ID */
  missionId: string;

  /** TraceLab references (tracelab:// URIs) */
  tracelabRefs: TracelabRef[];

  /** Local document references (relative paths) */
  localDocs: LocalDocRef[];

  /** Web URL references (http:// or https://) */
  webUrls: WebUrlRef[];

  /** Total reference count */
  totalRefs: number;

  /** Message describing the result */
  message: string;
}

/**
 * Input parameters schema for cmos_resolve_references tool.
 */
export const cmosResolveReferencesSchema = z.object({
  /** Mission ID to resolve references for */
  missionId: z
    .string()
    .min(1)
    .describe('The mission ID to resolve references for (e.g., "s18-m01")'),

  /** Optional project root */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosResolveReferencesParams = z.infer<typeof cmosResolveReferencesSchema>;

/**
 * MCP Tool Definition for cmos_resolve_references.
 */
export const cmosResolveReferencesToolDefinition = {
  name: 'cmos_resolve_references',
  description:
    'Parse mission reference_docs field and categorize references by type. Returns TraceLab URIs, local docs, and web URLs. Does NOT fetch content - use TraceLab tools for that.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'The mission ID to resolve references for (e.g., "s18-m01")',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['missionId'],
    additionalProperties: false,
  },
} as const;

/**
 * Parse a TraceLab URI into its components.
 *
 * URI format: tracelab://<type>/<resource-id>[/<path>]
 * Examples:
 *   tracelab://project/abc123
 *   tracelab://collection/abc123
 *   tracelab://report/abc123
 *   tracelab://document/abc123
 *   tracelab://chunk/abc123
 *   tracelab://search?q=query
 */
export function parseTracelabUri(uri: string): TracelabRef {
  const tracelabPrefix = 'tracelab://';

  if (!uri.startsWith(tracelabPrefix)) {
    return {
      uri,
      type: 'unknown',
      resourceId: null,
      path: null,
    };
  }

  const remainder = uri.slice(tracelabPrefix.length);
  const parts = remainder.split('/');

  const typeStr = parts[0] || '';
  const type: TracelabUriType | 'unknown' = TRACELAB_URI_TYPES.includes(typeStr as TracelabUriType)
    ? (typeStr as TracelabUriType)
    : 'unknown';

  const resourceId = parts[1] || null;
  const path = parts.length > 2 ? parts.slice(2).join('/') : null;

  return {
    uri,
    type,
    resourceId,
    path,
  };
}

/**
 * Determine if a reference is a TraceLab URI.
 */
export function isTracelabUri(ref: string): boolean {
  return ref.startsWith('tracelab://');
}

/**
 * Determine if a reference is a web URL.
 */
export function isWebUrl(ref: string): boolean {
  return ref.startsWith('http://') || ref.startsWith('https://');
}

/**
 * Parse a web URL to extract hostname.
 */
export function parseWebUrl(url: string): WebUrlRef {
  try {
    const parsed = new URL(url);
    return {
      url,
      hostname: parsed.hostname,
    };
  } catch {
    return {
      url,
      hostname: null,
    };
  }
}

/**
 * Parse a local document reference.
 */
export function parseLocalDoc(ref: string): LocalDocRef {
  return {
    ref,
    path: ref,
  };
}

/**
 * Execute the cmos_resolve_references tool.
 *
 * @param params - Tool parameters
 * @returns CmosToolResult with categorized references
 */
export async function cmosResolveReferences(
  params: CmosResolveReferencesParams
): Promise<CmosToolResult<CmosResolveReferencesResult>> {
  const { missionId } = params;

  if (!missionId || missionId.trim() === '') {
    return createError(CmosErrors.missingParameter('missionId'));
  }

  return withClientValidated(
    (client) => {
      // Fetch the mission
      const missionResult = client.getOne<Mission>(
        'SELECT id, reference_docs FROM missions WHERE id = ?',
        [missionId]
      );

      if (!missionResult.success) {
        return createError<CmosResolveReferencesResult>(
          missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
        );
      }

      if (!missionResult.data) {
        return createError<CmosResolveReferencesResult>(CmosErrors.missionNotFound(missionId));
      }

      const mission = missionResult.data;

      // Parse reference_docs JSON
      let refs: string[] = [];
      if (mission.reference_docs) {
        try {
          const parsed = JSON.parse(mission.reference_docs);
          if (Array.isArray(parsed)) {
            refs = parsed.filter((r): r is string => typeof r === 'string');
          }
        } catch {
          // Invalid JSON, treat as empty
          refs = [];
        }
      }

      // Categorize references
      const tracelabRefs: TracelabRef[] = [];
      const localDocs: LocalDocRef[] = [];
      const webUrls: WebUrlRef[] = [];

      for (const ref of refs) {
        const trimmedRef = ref.trim();
        if (!trimmedRef) continue;

        if (isTracelabUri(trimmedRef)) {
          tracelabRefs.push(parseTracelabUri(trimmedRef));
        } else if (isWebUrl(trimmedRef)) {
          webUrls.push(parseWebUrl(trimmedRef));
        } else {
          localDocs.push(parseLocalDoc(trimmedRef));
        }
      }

      const totalRefs = tracelabRefs.length + localDocs.length + webUrls.length;

      const messageParts: string[] = [];
      if (tracelabRefs.length > 0) {
        messageParts.push(`${tracelabRefs.length} TraceLab`);
      }
      if (localDocs.length > 0) {
        messageParts.push(`${localDocs.length} local`);
      }
      if (webUrls.length > 0) {
        messageParts.push(`${webUrls.length} web`);
      }

      const message =
        totalRefs === 0
          ? `Mission '${missionId}' has no reference docs`
          : `Mission '${missionId}' has ${totalRefs} refs: ${messageParts.join(', ')}`;

      return createSuccess<CmosResolveReferencesResult>({
        missionId,
        tracelabRefs,
        localDocs,
        webUrls,
        totalRefs,
        message,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Format resolve references result for LLM readability.
 */
export function formatResolveReferencesForLLM(
  result: CmosToolResult<CmosResolveReferencesResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      'Failed to resolve references',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    return lines.join('\n');
  }

  const data = result.data;
  const lines = [`**References for ${data.missionId}**`, ''];

  if (data.totalRefs === 0) {
    lines.push('No reference docs found.');
    return lines.join('\n');
  }

  if (data.tracelabRefs.length > 0) {
    lines.push(`**TraceLab References** (${data.tracelabRefs.length})`);
    for (const ref of data.tracelabRefs) {
      lines.push(`  - [${ref.type}] ${ref.uri}`);
    }
    lines.push('');
  }

  if (data.localDocs.length > 0) {
    lines.push(`**Local Docs** (${data.localDocs.length})`);
    for (const doc of data.localDocs) {
      lines.push(`  - ${doc.path}`);
    }
    lines.push('');
  }

  if (data.webUrls.length > 0) {
    lines.push(`**Web URLs** (${data.webUrls.length})`);
    for (const url of data.webUrls) {
      lines.push(`  - ${url.url}`);
    }
    lines.push('');
  }

  lines.push(`**Total**: ${data.totalRefs} references`);

  return lines.join('\n');
}
