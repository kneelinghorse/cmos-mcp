#!/usr/bin/env node

// ABOUTME: Main MCP server entry point, including tool dispatch and startup diagnostics.
// ABOUTME: Runs an attribution self-test at boot so sender-resolution regressions surface immediately.

/**
 * Mission Protocol v2 MCP Server
 *
 * Main entry point for the MCP server that exposes domain discovery tools.
 * Uses stdio transport for Claude Desktop integration.
 *
 * @module index
 */

import * as fs from 'fs';
import * as path from 'path';

// Load .env if present (before any other imports that read process.env).
// Resolve project root from: env var → directory containing this script.
// Overrides empty values (present-but-unset is treated as absent) so IDE
// spawns that pass empty env keys don't shadow .env values.
const __projectRoot = process.env.CMOS_PROJECT_ROOT ?? path.resolve(__dirname, '..');
const envPath = path.join(__projectRoot, '.env');
try {
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    let loaded = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
        loaded++;
      }
    }
    process.stderr.write(`[env-loader] loaded ${loaded} vars from ${envPath}\n`);
  } else {
    process.stderr.write(`[env-loader] .env not found at ${envPath}\n`);
  }
} catch (err) {
  process.stderr.write(
    `[env-loader] failed to load ${envPath}: ${err instanceof Error ? err.message : String(err)}\n`
  );
}

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  RootsListChangedNotificationSchema,
  ErrorCode,
  McpError,
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import { CmosDetector } from './intelligence/cmos-detector';
import { ProjectRegistry } from './intelligence/project-registry';
import {
  resolveSenderContext,
  SenderResolutionError,
  SERVER_INSTALL_ROOT,
  type SenderContext,
} from './intelligence/sender-context';
import { isReadAction, type MultiClientEntry } from './tools/cmos/client';
import {
  CMOS_TOOL_DEFINITIONS,
  // Consolidated entity tools (Sprint 24)
  cmosMission,
  formatMissionForLLM,
  cmosMissionTransition,
  formatMissionTransitionForLLM,
  cmosSprint,
  formatSprintForLLM,
  cmosContext,
  formatContextForLLM,
  cmosSession,
  formatSessionForLLM,
  cmosDecisions,
  formatDecisionsForLLM,
  cmosLearnings,
  formatLearningsForLLM,
  cmosFeedback,
  formatFeedbackForLLM,
  cmosStatus,
  formatStatusForLLM,
  cmosAuth,
  formatAuthForLLM,
  cmosDb,
  formatDbForLLM,
  cmosProject,
  formatProjectForLLM,
  // Messaging tool (Sprint 28)
  cmosMessage,
  formatMessageForLLM,
  getWhoamiDiagnostics,
  // Agent utility tools
  cmosAgentOnboard,
  formatAgentOnboardForLLM,
  // Bundled session-opener digest (Sprint 64 m03)
  cmosReview,
  formatReviewForLLM,
  // Utility
  resolveProjectRoot,
  CMOS_PROJECT_ROOT_ENV,
  CMOS_ERROR_CODES,
} from './tools/cmos';
import type {
  CmosMissionParams,
  CmosMissionTransitionParams,
  CmosSprintParams,
  CmosContextParams,
  CmosSessionParams,
  CmosDecisionsParams,
  CmosLearningsParams,
  CmosFeedbackParams,
  CmosStatusParams,
  CmosAuthParams,
  CmosDbParams,
  CmosProjectParams,
  CmosAgentOnboardParams,
  CmosMessageParams,
  CmosReviewParams,
} from './tools/cmos';
import { TokenCounter } from './intelligence/token-counters';
import { ensureTokenizersReady, getTokenizerHealth } from './intelligence/tokenizer-bootstrap';
import { SupportedModel } from './intelligence/types';
import { ErrorHandler } from './errors/handler';
import { ErrorLogger } from './errors/logger';
import type { JsonValue } from './errors/types';
import { initServerHealth, getServerHealth } from './server-health';
import {
  runStartupProjectKeyRecovery,
  runStartupCredentialCheck,
} from './auth/project-key-capture';

/**
 * MCP Server Configuration
 */
const SERVER_CONFIG = {
  name: 'mission-protocol',
  version: '2.0.0',
} as const;

/**
 * Main server instance
 */
const server = new Server(
  {
    name: SERVER_CONFIG.name,
    version: SERVER_CONFIG.version,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const errorLogger = new ErrorLogger();
ErrorHandler.useLogger(errorLogger);

/**
 * Mission Protocol server context shared across handlers
 */
export interface MissionProtocolContext {
  baseDir: string;
  defaultModel: SupportedModel;
  tokenCounter: TokenCounter;
  /** Whether CMOS is detected in the project */
  cmosDetected: boolean;
  /** Path to CMOS database if detected */
  cmosDatabasePath?: string;
  /** Client's project root from MCP roots (set after connection) */
  clientProjectRoot?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
}

/**
 * Get tool definitions for the MCP surface.
 *
 * @returns Array of CMOS tool definitions
 */
export function getToolDefinitions(): readonly ToolDefinition[] {
  return [...(CMOS_TOOL_DEFINITIONS as unknown as ToolDefinition[])];
}

export function summarizeValue(value: unknown): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 5).map((item) => summarizeValue(item)) as JsonValue;
  }
  if (typeof value === 'object') {
    return '[object]';
  }
  if (typeof value === 'string' && value.length > 200) {
    return `${value.slice(0, 197)}…`;
  }
  return value as JsonValue;
}

export function sanitizeArgs(args: unknown): Record<string, JsonValue> | undefined {
  if (!args || typeof args !== 'object') {
    return undefined;
  }
  const entries = Object.entries(args as Record<string, unknown>).slice(0, 10);
  const sanitized: Record<string, JsonValue> = {};
  for (const [key, value] of entries) {
    sanitized[key] = summarizeValue(value);
  }
  return sanitized;
}

export async function buildMissionProtocolContext(options?: {
  baseDir?: string;
  defaultModel?: SupportedModel;
}): Promise<MissionProtocolContext> {
  const baseDir = options?.baseDir ?? path.resolve(__dirname, '../templates');
  const defaultModel = options?.defaultModel ?? 'claude';

  // Initialize token counter for intelligence tools
  const tokenCounter = new TokenCounter();

  // Detect CMOS in the project (respects CMOS_PROJECT_ROOT env var)
  const projectRoot = resolveProjectRoot();
  const detector = CmosDetector.getInstance({ cacheTtlMs: 60_000 });
  const cmosResult = await detector.detect(projectRoot);
  const cmosDetected = cmosResult.hasCmosDirectory && cmosResult.hasDatabase;

  return {
    baseDir,
    defaultModel,
    tokenCounter,
    cmosDetected,
    cmosDatabasePath: cmosResult.databasePath,
  };
}

let contextBuilder: typeof buildMissionProtocolContext = buildMissionProtocolContext;
let whoamiCliRunner: typeof runWhoamiCli = runWhoamiCli;
let startupAttributionSelfTestRunner: typeof runStartupAttributionSelfTest =
  runStartupAttributionSelfTest;

interface StartupAttributionSelfTestResult {
  projectRoot: string | null;
  source: SenderContext['source'] | null;
  errorCode: string | null;
  warning: string | null;
}

/**
 * Cached client project roots from MCP roots (all of them, not just the first).
 * Updated lazily on first CMOS tool call and cleared on `notifications/roots/list_changed`.
 *
 * `undefined` means "never probed"; empty array means "probed, none advertised".
 */
let cachedClientProjectRoots: string[] | undefined;

/**
 * Get ALL client project roots from MCP roots.
 *
 * Sprint 53 m02: changed from `Promise<string | undefined>` (first root only) to
 * `Promise<string[]>` so `resolveSenderContext` can walk every advertised root and
 * pick the one that owns a valid `dashboard_project_id`. The former first-only
 * behavior silently mis-attributed whenever the client advertised multiple roots
 * in a different order than the operator expected.
 *
 * @returns Array of file-system paths. Empty when the client advertises no roots
 *   or does not support the roots capability.
 */
async function getClientProjectRoots(): Promise<string[]> {
  if (cachedClientProjectRoots !== undefined) {
    return cachedClientProjectRoots;
  }

  const roots: string[] = [];
  try {
    const rootsResult = await server.listRoots();
    if (rootsResult.roots && rootsResult.roots.length > 0) {
      for (const root of rootsResult.roots) {
        if (root.uri.startsWith('file://')) {
          roots.push(decodeURIComponent(root.uri.slice(7)));
        }
      }
      if (roots.length > 0) {
        console.error(`[INFO] Client project roots from MCP roots: ${roots.join(', ')}`);
      }
    }
  } catch (error) {
    // Client may not support roots - this is fine, fall back to other methods
    console.error(
      `[DEBUG] Could not get client roots: ${error instanceof Error ? error.message : 'unknown'}`
    );
  }

  cachedClientProjectRoots = roots;
  return cachedClientProjectRoots;
}

/**
 * Fan out a read-only operation across all registered CMOS instances.
 *
 * Returns an entry per registered project. Partial failures are included
 * (not thrown) so callers can surface provenance alongside any errors.
 *
 * @param fn - Async service call to run for each projectRoot
 * @returns Success with per-instance entries, or error if no projects registered
 */
async function fanOutRead<T>(
  fn: (projectRoot: string) => Promise<{ success: boolean; data?: T; error?: unknown }>
): Promise<{ success: boolean; data?: Array<MultiClientEntry<T>>; error?: unknown }> {
  const registry = ProjectRegistry.getInstance();
  const projects = await registry.list();

  if (projects.length === 0) {
    return {
      success: false,
      error: {
        code: 'CMOS_NOT_DETECTED',
        message: 'No CMOS projects registered. Cannot fan out without an explicit projectRoot.',
        suggestion:
          'Provide an explicit projectRoot, set CMOS_PROJECT_ROOT, or register a project with cmos_project(action="register").',
      },
    };
  }

  const entries: Array<MultiClientEntry<T>> = await Promise.all(
    projects.map(async (project): Promise<MultiClientEntry<T>> => {
      const result = await fn(project.projectRoot);
      return {
        resolvedFrom: project.projectRoot,
        success: result.success,
        data: result.data,
        error: result.error as import('./tools/cmos/types').CmosToolError | undefined,
      };
    })
  );

  return { success: true, data: entries };
}

/**
 * Format fan-out results for LLM consumption.
 *
 * Each entry is labelled with its source project and separated by a divider.
 */
function formatFanOut<T>(
  entries: Array<MultiClientEntry<T>>,
  formatEntry: (result: { success: boolean; data?: T; error?: unknown }) => string
): string {
  if (entries.length === 0) {
    return 'No registered CMOS instances found.';
  }
  return entries
    .map((e) => `[${path.basename(e.resolvedFrom)}] ${e.resolvedFrom}\n${formatEntry(e)}`)
    .join('\n\n---\n\n');
}

/**
 * Resolve the sender context for a dispatched tool call.
 *
 * Sprint 53 m02: replaces the old `resolveCmosProjectRoot` (which silently fell
 * back to `CMOS_PROJECT_ROOT` env) with the single audited boundary from
 * `src/intelligence/sender-context.ts`. Every dispatcher case now flows through
 * this function. `CMOS_PROJECT_ROOT` is no longer consulted at tool dispatch
 * time — it is retained only for `.env` bootstrap at src/index.ts:17 so the
 * server can locate its own environment file.
 *
 * @param explicitRoot - `params.projectRoot` from the tool call, if any
 * @param options.requireSenderIdentity - Pass `true` for any call that will hit
 *   the dashboard with authoritative attribution (today: cmos_message send;
 *   Sprint 53 m04 adds checkpoint-backfill, registerProject, purge). Defaults to
 *   `false` for local-DB ops.
 * @throws SenderResolutionError when no candidate produces an acceptable project.
 */
async function resolveToolSenderContext(
  explicitRoot: string | undefined,
  options: { requireSenderIdentity?: boolean } = {}
): Promise<SenderContext> {
  const mcpRoots = await getClientProjectRoots();
  return resolveSenderContext({
    explicitProjectRoot: explicitRoot,
    mcpRoots,
    requireSenderIdentity: options.requireSenderIdentity ?? false,
  });
}

/**
 * Register tool handlers
 */
export function registerToolHandlers(
  context: MissionProtocolContext,
  serverInstance?: Server
): void {
  const targetServer = serverInstance || server;
  // Listen for roots changes and clear cache
  targetServer.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    console.error(`[INFO] Client roots changed, clearing cache`);
    cachedClientProjectRoots = undefined;
  });

  // List available tools (includes CMOS tools when detected)
  targetServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: getToolDefinitions(),
    };
  });

  // Handle tool execution
  targetServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (!context) {
        throw new McpError(ErrorCode.InternalError, 'Server context not initialized');
      }

      return await executeMissionProtocolTool(name, args, context);
    } catch (error) {
      // Sprint 74 m03: a tool HANDLER that throws an unhandled exception (a
      // write-path crash — e.g. cmos_sprint(complete)/cmos_session(capture)
      // hitting a store-specific failure) is a tool-EXECUTION failure, not a
      // protocol error. Surface it as a structured CmosToolResult error
      // (code + real message + suggestion) returned as an isError result —
      // never a bare JSON-RPC -32603 that swallows the cause (aquex.ai aa124685).
      // Genuine protocol errors (McpError: unknown tool, uninitialized context)
      // keep their JSON-RPC error shape — they already carry a clear message.
      if (!(error instanceof McpError)) {
        return buildToolExecutionErrorResult(name, args, error);
      }

      const sanitizedArgs = sanitizeArgs(args);
      const data: Record<string, JsonValue> = {
        tool: name,
      };
      if (sanitizedArgs) {
        data.args = sanitizedArgs;
      }

      const missionError = ErrorHandler.handle(
        error,
        'server.execute_tool',
        {
          module: 'server',
          data,
        },
        {
          rethrow: false,
          userMessage: 'Tool execution failed. Please check inputs and try again.',
        }
      );

      const publicError = ErrorHandler.toPublicError(missionError);
      const correlationFragment = publicError.correlationId
        ? ` (correlationId=${publicError.correlationId})`
        : '';

      throw new McpError(
        ErrorCode.InternalError,
        `Tool execution failed${correlationFragment}: ${publicError.message}`
      );
    }
  });
}

/**
 * Sprint 74 m03 — convert an unhandled tool-handler exception into a structured
 * CmosToolResult error returned as an `isError` tool result, so the caller sees a
 * real `{code, message, suggestion}` instead of a bare JSON-RPC -32603 that hides
 * the cause. Logs the underlying error (via ErrorHandler.handle, never re-throws)
 * to keep the correlationId trail, then surfaces the REAL exception message —
 * NOT the generic userMessage that toPublicError would substitute.
 */
export function buildToolExecutionErrorResult(
  toolName: string,
  args: unknown,
  error: unknown
): CallToolResult {
  const sanitizedArgs = sanitizeArgs(args);
  const data: Record<string, JsonValue> = { tool: toolName };
  if (sanitizedArgs) {
    data.args = sanitizedArgs;
  }

  const missionError = ErrorHandler.handle(
    error,
    'server.execute_tool',
    { module: 'server', data },
    { rethrow: false, userMessage: 'Tool execution failed. Please check inputs and try again.' }
  );

  const correlationId = missionError.context?.correlationId;
  const correlationSuffix =
    typeof correlationId === 'string' && correlationId.length > 0
      ? ` (correlationId=${correlationId})`
      : '';
  const detail =
    typeof missionError.message === 'string' && missionError.message.trim().length > 0
      ? missionError.message.trim()
      : 'unexpected internal error';

  const structured = {
    success: false as const,
    error: {
      code: CMOS_ERROR_CODES.TOOL_EXECUTION_ERROR,
      message: `The '${toolName}' tool failed with an unhandled internal error: ${detail}`,
      suggestion: `This is an internal error, not an input-validation problem — retry the call; if it persists, capture the tool inputs and report this${correlationSuffix}.`,
    },
  };

  const text =
    `Tool execution error [${structured.error.code}]: ${structured.error.message}\n` +
    `Suggestion: ${structured.error.suggestion}\n\n` +
    JSON.stringify(structured, null, 2);

  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
    isError: true,
  };
}

export async function executeMissionProtocolTool(
  name: string,
  args: unknown,
  _context: MissionProtocolContext
): Promise<CallToolResult> {
  switch (name) {
    // ========================================
    // CMOS Tools (always available, return graceful error if not detected)
    // ========================================

    // Consolidated DB admin tool (Sprint 24)
    case 'cmos_db': {
      const params = args as CmosDbParams;
      const projectRoot = (await resolveToolSenderContext(params.projectRoot)).projectRoot;
      const result = await cmosDb({ ...params, projectRoot });
      const formatted = formatDbForLLM(params.action, result);

      return {
        content: [{ type: 'text', text: formatted }],
        structuredContent: { ...result },
        isError: result.success === false,
      };
    }

    // Consolidated mission CRUD tool (Sprint 24)
    case 'cmos_mission': {
      const params = args as CmosMissionParams;

      if (!params.projectRoot && isReadAction('cmos_mission', params.action)) {
        const fanResult = await fanOutRead((root) => cmosMission({ ...params, projectRoot: root }));
        const formatted = fanResult.success
          ? formatFanOut(fanResult.data!, (e) =>
              formatMissionForLLM(params.action, {
                success: e.success,
                data: e.data,
                error: e.error as import('./tools/cmos/types').CmosToolError | undefined,
              })
            )
          : String((fanResult.error as { message?: string })?.message ?? 'Fan-out failed');
        return {
          content: [{ type: 'text', text: formatted }],
          structuredContent: fanResult,
          isError: !fanResult.success,
        };
      }

      const projectRoot = (await resolveToolSenderContext(params.projectRoot)).projectRoot;
      const result = await cmosMission({ ...params, projectRoot });
      const formatted = formatMissionForLLM(params.action, result);

      return {
        content: [{ type: 'text', text: formatted }],
        structuredContent: { ...result },
        isError: result.success === false,
      };
    }

    // Consolidated mission transition tool (Sprint 24)
    case 'cmos_mission_transition': {
      const params = args as CmosMissionTransitionParams;
      const projectRoot = (await resolveToolSenderContext(params.projectRoot)).projectRoot;
      const result = await cmosMissionTransition({ ...params, projectRoot });
      const formatted = formatMissionTransitionForLLM(params.action, result);

      return {
        content: [{ type: 'text', text: formatted }],
        structuredContent: { ...result },
        isError: result.success === false,
      };
    }

    // Consolidated context tool (Sprint 24)
    case 'cmos_context': {
      const params = args as CmosContextParams;

      if (!params.projectRoot && isReadAction('cmos_context', params.action)) {
        const fanResult = await fanOutRead((root) => cmosContext({ ...params, projectRoot: root }));
        const formatted = fanResult.success
          ? formatFanOut(fanResult.data!, (e) =>
              formatContextForLLM(
                params.action,
                {
                  success: e.success,
                  data: e.data,
                  error: e.error as import('./tools/cmos/types').CmosToolError | undefined,
                },
                params.contextType
              )
            )
          : String((fanResult.error as { message?: string })?.message ?? 'Fan-out failed');
        return {
          content: [{ type: 'text', text: formatted }],
          structuredContent: fanResult,
          isError: !fanResult.success,
        };
      }

      const projectRoot = (await resolveToolSenderContext(params.projectRoot)).projectRoot;
      const result = await cmosContext({ ...params, projectRoot });
      const formatted = formatContextForLLM(params.action, result, params.contextType);

      return {
        content: [{ type: 'text', text: formatted }],
        structuredContent: { ...result },
        isError: result.success === false,
      };
    }

    // Consolidated session tool (Sprint 24)
    case 'cmos_session': {
      const params = args as CmosSessionParams;

      if (!params.projectRoot && isReadAction('cmos_session', params.action)) {
        const fanResult = await fanOutRead((root) => cmosSession({ ...params, projectRoot: root }));
        const formatted = fanResult.success
          ? formatFanOut(fanResult.data!, (e) =>
              formatSessionForLLM(params.action, {
                success: e.success,
                data: e.data,
                error: e.error as import('./tools/cmos/types').CmosToolError | undefined,
              })
            )
          : String((fanResult.error as { message?: string })?.message ?? 'Fan-out failed');
        return {
          content: [{ type: 'text', text: formatted }],
          structuredContent: fanResult,
          isError: !fanResult.success,
        };
      }

      const projectRoot = (await resolveToolSenderContext(params.projectRoot)).projectRoot;
      const result = await cmosSession({ ...params, projectRoot });
      const formatted = formatSessionForLLM(params.action, result);

      return {
        content: [{ type: 'text', text: formatted }],
        structuredContent: { ...result },
        isError: result.success === false,
      };
    }

    // Consolidated decisions tool (Sprint 24)
    case 'cmos_decisions': {
      const params = args as CmosDecisionsParams;
      // s69-m06: the acrossProjects (list) path discovers stores via the project-graph
      // registry, NOT the sender root — so it must NOT require a resolvable LOCAL store
      // at the boundary. resolveToolSenderContext throws when no local store resolves,
      // which is the NORMAL case for a portfolio query run from a neutral directory
      // (and the registry-singleton fallback only accepts a 1-project registry, never a
      // real multi-project portfolio). Skip resolution for that path; cmosDecisionsList
      // ignores projectRoot on the acrossProjects branch anyway.
      const projectRoot = params.acrossProjects
        ? undefined
        : (await resolveToolSenderContext(params.projectRoot)).projectRoot;
      const result = await cmosDecisions({ ...params, projectRoot });
      const formatted = formatDecisionsForLLM(params.action, result);

      return {
        content: [{ type: 'text', text: formatted }],
        structuredContent: { ...result },
        isError: result.success === false,
      };
    }

    // Consolidated learnings tool (Sprint 38)
    case 'cmos_learnings': {
      const params = args as CmosLearningsParams;
      const projectRoot = (await resolveToolSenderContext(params.projectRoot)).projectRoot;
      const result = await cmosLearnings({ ...params, projectRoot });
      const formatted = formatLearningsForLLM(params.action, result);

      return {
        content: [{ type: 'text', text: formatted }],
        structuredContent: { ...result },
        isError: result.success === false,
      };
    }

    // Consolidated feedback tool (Sprint 56 m03)
    case 'cmos_feedback': {
      const params = args as CmosFeedbackParams;
      const projectRoot = (await resolveToolSenderContext(params.projectRoot)).projectRoot;
      const result = await cmosFeedback({ ...params, projectRoot });
      const formatted = formatFeedbackForLLM(params.action, result);

      return {
        content: [{ type: 'text', text: formatted }],
        structuredContent: { ...result },
        isError: result.success === false,
      };
    }

    // Credential lifecycle (Sprint 57 m03)
    case 'cmos_auth': {
      const params = args as CmosAuthParams;
      const projectRoot = (await resolveToolSenderContext(params.projectRoot)).projectRoot;
      const result = await cmosAuth({ ...params, projectRoot });
      const formatted = formatAuthForLLM(params.action, result);

      return {
        content: [{ type: 'text', text: formatted }],
        structuredContent: { ...result },
        isError: result.success === false,
      };
    }

    // At-a-glance status payload (Sprint 62 m06)
    case 'cmos_status': {
      const params = args as CmosStatusParams;
      const projectRoot = (await resolveToolSenderContext(params.projectRoot)).projectRoot;
      const result = await cmosStatus({ ...params, projectRoot });
      const formatted = formatStatusForLLM(result);

      return {
        content: [{ type: 'text', text: formatted }],
        structuredContent: { ...result },
        isError: result.success === false,
      };
    }

    // Sprint tools
    case 'cmos_sprint': {
      const params = args as CmosSprintParams;

      if (!params.projectRoot && isReadAction('cmos_sprint', params.action)) {
        const fanResult = await fanOutRead((root) => cmosSprint({ ...params, projectRoot: root }));
        const formatted = fanResult.success
          ? formatFanOut(fanResult.data!, (e) =>
              formatSprintForLLM(params.action, {
                success: e.success,
                data: e.data,
                error: e.error as import('./tools/cmos/types').CmosToolError | undefined,
              })
            )
          : String((fanResult.error as { message?: string })?.message ?? 'Fan-out failed');
        return {
          content: [{ type: 'text', text: formatted }],
          structuredContent: fanResult,
          isError: !fanResult.success,
        };
      }

      const projectRoot = (await resolveToolSenderContext(params.projectRoot)).projectRoot;
      const result = await cmosSprint({ ...params, projectRoot });
      const formatted = formatSprintForLLM(params.action, result);

      return {
        content: [{ type: 'text', text: formatted }],
        structuredContent: { ...result },
        isError: result.success === false,
      };
    }

    case 'cmos_agent_onboard': {
      const params = args as CmosAgentOnboardParams;
      const advertisedRoots = await getClientProjectRoots();
      const callerProvidedProjectRoot = typeof params.projectRoot === 'string';
      const projectRoot = (await resolveToolSenderContext(params.projectRoot)).projectRoot;
      const result = await cmosAgentOnboard({
        ...params,
        projectRoot,
        advertisedRoots,
        callerProvidedProjectRoot,
      });
      const formatted = formatAgentOnboardForLLM(result);

      return {
        content: [{ type: 'text', text: formatted }],
        structuredContent: { ...result },
        isError: result.success === false,
      };
    }

    // Bundled session-opener digest (Sprint 64 m03).
    // Project-scoped by design — does NOT walk the project registry.
    case 'cmos_review': {
      const params = args as CmosReviewParams;
      const projectRoot = (await resolveToolSenderContext(params.projectRoot)).projectRoot;
      const result = await cmosReview({ ...params, projectRoot });
      const formatted = formatReviewForLLM(result);

      return {
        content: [{ type: 'text', text: formatted }],
        structuredContent: { ...result },
        isError: result.success === false,
      };
    }

    // Consolidated message tool (Sprint 28)
    case 'cmos_message': {
      const params = args as CmosMessageParams;
      const advertisedRoots = await getClientProjectRoots();

      if (params.action === 'whoami') {
        const result = await getWhoamiDiagnostics({
          explicitProjectRoot: params.projectRoot,
          mcpRoots: advertisedRoots,
        });
        const formatted = formatMessageForLLM(params.action, result);

        return {
          content: [{ type: 'text', text: formatted }],
          structuredContent: { ...result },
          isError: result.success === false,
        };
      }

      // Sprint 53 m02: `send` must resolve through the audited boundary with
      // `requireSenderIdentity=true`. The former path bypassed root resolution
      // entirely (see sprint-53-attribution-rebuild.md §Verified Root Cause #2)
      // and was the structural source of the Stage1→OODS P0. Non-send actions
      // (list/respond/directory) hit the dashboard directly and don't need a
      // local project identity, so they skip resolution.
      let projectRoot: string | undefined = params.projectRoot;
      if (params.action === 'send') {
        const ctx = await resolveSenderContext({
          explicitProjectRoot: params.projectRoot,
          mcpRoots: advertisedRoots,
          requireSenderIdentity: true,
        });
        projectRoot = ctx.projectRoot;
      }
      const result = await cmosMessage({ ...params, projectRoot, advertisedRoots });
      const formatted = formatMessageForLLM(params.action, result);

      return {
        content: [{ type: 'text', text: formatted }],
        structuredContent: { ...result },
        isError: result.success === false,
      };
    }

    // Consolidated project tool (Sprint 24)
    case 'cmos_project': {
      const params = args as CmosProjectParams;
      // init/register take a literal user-supplied path (destination for a new
      // workspace, or path to register). Routing through resolveToolSenderContext
      // would fall back to the caller's own project when the path has no CMOS DB,
      // which for init clobbers the caller's metadata with a fresh seed. The
      // action handlers validate the path themselves and reject empty/missing input.
      const isLiteralPathAction = params.action === 'init' || params.action === 'register';
      const projectRoot = isLiteralPathAction
        ? params.projectRoot
        : (await resolveToolSenderContext(params.projectRoot)).projectRoot;
      const result = await cmosProject({ ...params, projectRoot });
      const formatted = formatProjectForLLM(params.action, result, {
        validate: params.validate,
      });

      return {
        content: [{ type: 'text', text: formatted }],
        structuredContent: { ...result },
        isError: result.success === false,
      };
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}

async function runWhoamiCli(): Promise<number> {
  const result = await getWhoamiDiagnostics();
  console.log(formatMessageForLLM('whoami', result));
  return result.success ? 0 : 1;
}

/**
 * Registry prune result emitted by the startup hook.
 */
interface StartupRegistryPruneResult {
  /** Total entries before the prune (null on failure before load). */
  totalBefore: number | null;
  /** Entries removed (stale directory or missing CMOS database). */
  pruned: number;
  /** Remaining entries after prune. */
  remaining: number | null;
  /** Error message when the prune could not run; null on success. */
  error: string | null;
}

/**
 * Walk the registry, drop entries whose `projectRoot` no longer contains a
 * CMOS database, and emit a concise log line so the operator can see drift.
 *
 * Sprint 56 m01: registry pollution was blowing the fanout response cap on
 * read surfaces. Auto-prune at boot keeps the registry bounded by live
 * projects without requiring a manual `cmos_project(action="validate")`.
 */
async function runStartupRegistryPrune(): Promise<StartupRegistryPruneResult> {
  try {
    const registry = await ProjectRegistry.create();
    const before = (await registry.list()).length;
    const pruned = await registry.prune();
    const remaining = (await registry.list()).length;
    return { totalBefore: before, pruned, remaining, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return { totalBefore: null, pruned: 0, remaining: null, error: message };
  }
}

let startupRegistryPruneRunner: typeof runStartupRegistryPrune = runStartupRegistryPrune;

// Sprint 57 m02: startup recovery for partial-failure auto-issue. Non-fatal.
let startupProjectKeyRecoveryRunner: typeof runStartupProjectKeyRecovery =
  runStartupProjectKeyRecovery;

// Sprint 58 m02: startup credential-store empty-check. Non-fatal.
let startupCredentialCheckRunner: typeof runStartupCredentialCheck = runStartupCredentialCheck;

/**
 * Sprint 62 m02: detect a `.env` file accidentally bundled inside the npm
 * tarball. Defends against the worst-case "shipped credentials to npm" leak.
 *
 * Detection: only fires when the running script lives under a `node_modules`
 * path (i.e. installed from npm), to avoid false positives on dev tree where
 * a `.env` file is normal. Logs a [WARN] — never throws — so a misconfig
 * doesn't break startup.
 *
 * Exported for unit testing.
 */
export interface BundledEnvCheckResult {
  installedFromNpm: boolean;
  envFilePath: string | null;
  envFileBundled: boolean;
}

export function runStartupBundledEnvCheck(
  serverInstallRoot: string = SERVER_INSTALL_ROOT
): BundledEnvCheckResult {
  const installedFromNpm = serverInstallRoot.includes(`${path.sep}node_modules${path.sep}`);
  if (!installedFromNpm) {
    return { installedFromNpm: false, envFilePath: null, envFileBundled: false };
  }
  const envFilePath = path.join(serverInstallRoot, '.env');
  const envFileBundled = fs.existsSync(envFilePath);
  return { installedFromNpm: true, envFilePath, envFileBundled };
}

let startupBundledEnvCheckRunner: typeof runStartupBundledEnvCheck = runStartupBundledEnvCheck;

async function runStartupAttributionSelfTest(): Promise<StartupAttributionSelfTestResult> {
  try {
    const resolved = await resolveSenderContext({
      requireSenderIdentity: true,
    });
    return {
      projectRoot: resolved.projectRoot,
      source: resolved.source,
      errorCode: null,
      warning:
        resolved.projectRoot === SERVER_INSTALL_ROOT
          ? 'SERVER_INSTALL_ROOT resolved as the sender. Remediation: run the server from the client project or rely on advertised MCP roots.'
          : null,
    };
  } catch (error) {
    if (error instanceof SenderResolutionError) {
      const installRootGuardCandidate = error.candidates.find(
        (candidate) =>
          candidate.source === 'cwd' &&
          candidate.projectRoot === SERVER_INSTALL_ROOT &&
          candidate.rejectReason?.includes('cwd-vs-SERVER_INSTALL_ROOT guard')
      );

      return {
        projectRoot: null,
        source: null,
        errorCode: error.code,
        warning: installRootGuardCandidate
          ? 'SERVER_INSTALL_ROOT would have been the implicit sender. Remediation: run the server from the client project or rely on advertised MCP roots.'
          : null,
      };
    }

    const message = error instanceof Error ? error.message : 'unknown error';
    return {
      projectRoot: null,
      source: null,
      errorCode: 'SELF_TEST_FAILED',
      warning: `Startup attribution self-test failed unexpectedly: ${message}`,
    };
  }
}

/**
 * Initialize server components
 */
async function initializeServer(): Promise<MissionProtocolContext> {
  try {
    console.error(`[INFO] Initializing MCP server...`);
    const context = await contextBuilder();
    console.error(`[INFO] Template base directory: ${context.baseDir}`);
    console.error(`[INFO] Default intelligence model: ${context.defaultModel}`);

    // Sprint 53 m02 / m04: startup diagnostic for attribution. `SERVER_INSTALL_ROOT`
    // is the one path that must never be the *implicit* sender for another project;
    // operators see it here so they can verify before debugging misrouted sends.
    const envProjectRoot = process.env[CMOS_PROJECT_ROOT_ENV];
    console.error(`[INFO] Server install root: ${SERVER_INSTALL_ROOT}`);
    console.error(
      `[INFO] Sender attribution diagnostics: Server install root: ${SERVER_INSTALL_ROOT}. ` +
        `${CMOS_PROJECT_ROOT_ENV} env: ${envProjectRoot ?? 'unset'}. Roots support: probed on first call.`
    );
    if (envProjectRoot) {
      console.error(
        `[WARN] ${CMOS_PROJECT_ROOT_ENV}=${envProjectRoot} is set. Sprint 53 removed this from the ` +
          `tool-dispatch resolution chain — it is retained only for .env bootstrap. If you relied on ` +
          `this env to pin attribution, pass projectRoot explicitly or ensure your MCP client advertises ` +
          `roots. Every outbound send will fail-closed rather than silently attribute to the server's ` +
          `own project.`
      );
    } else {
      console.error(`[INFO] ${CMOS_PROJECT_ROOT_ENV} env: unset (expected post-Sprint-53).`);
    }
    const registryPrune = await startupRegistryPruneRunner();
    if (registryPrune.error) {
      console.error(
        `[WARN] Registry prune skipped: ${registryPrune.error} — continuing startup with unpruned registry.`
      );
    } else if (registryPrune.pruned > 0) {
      console.error(
        `[INFO] pruned ${registryPrune.pruned} stale entries from project registry (${registryPrune.remaining} remaining)`
      );
    } else {
      console.error(
        `[INFO] Project registry healthy: ${registryPrune.remaining ?? 0} entries, no stale entries pruned`
      );
    }

    const attributionSelfTest = await startupAttributionSelfTestRunner();
    if (attributionSelfTest.projectRoot && attributionSelfTest.source) {
      console.error(
        `[INFO] Sender attribution self-test: ${attributionSelfTest.source} -> ${attributionSelfTest.projectRoot}`
      );
    } else {
      console.error(
        `[INFO] Sender attribution self-test: unresolved (${attributionSelfTest.errorCode ?? 'unknown'})`
      );
    }
    if (attributionSelfTest.warning) {
      console.error(`[P0] Sender attribution self-test warning: ${attributionSelfTest.warning}`);
    }

    // Sprint 57 m02: partial-failure recovery for projects registered on the
    // dashboard but with no local project key. Non-fatal — startup continues
    // regardless of the outcome.
    try {
      const recoveryRoot = attributionSelfTest.projectRoot ?? undefined;
      const recovery = await startupProjectKeyRecoveryRunner({
        ...(recoveryRoot ? { projectRoot: recoveryRoot } : {}),
      });
      if (recovery.status === 'recovered') {
        console.error(`[INFO] Project key recovery: ${recovery.message}`);
      } else if (recovery.status === 'error') {
        console.error(`[WARN] Project key recovery: ${recovery.message}`);
      } else {
        console.error(`[INFO] Project key recovery: ${recovery.status} — ${recovery.message}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(
        `[WARN] Project key recovery hook threw (non-fatal): ${message}. Continuing startup.`
      );
    }

    // Sprint 58 m02: surface an empty credential store with a one-line
    // [WARN] pointing at cmos_auth(action="login"). Makes the "just nothing
    // happens" first-run state audible. Non-fatal.
    try {
      await startupCredentialCheckRunner();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(
        `[WARN] Startup credential check threw (non-fatal): ${message}. Continuing startup.`
      );
    }

    // Sprint 62 m02: detect a .env file accidentally bundled inside the npm
    // package — protects against accidental credential leaks to the registry.
    // Non-fatal; only fires when running from a node_modules install.
    try {
      const bundledEnv = startupBundledEnvCheckRunner();
      if (bundledEnv.envFileBundled && bundledEnv.envFilePath) {
        console.error(
          `[WARN] cmos-mcp: a .env file was found inside the installed package at ${bundledEnv.envFilePath}. ` +
            `This may contain credentials that should not have been published. ` +
            `Inspect the file, treat any contained secrets as compromised, and report the issue at ` +
            `https://github.com/kneelinghorse/cmos-mcp/issues. The server will continue running.`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(
        `[WARN] Startup bundled-env check threw (non-fatal): ${message}. Continuing startup.`
      );
    }

    await ensureTokenizersReady();
    const tokenizerHealth = getTokenizerHealth();
    console.error(
      `[INFO] Tokenizer preload status: GPT ready=${tokenizerHealth.models.gpt.ready} (attempts=${tokenizerHealth.models.gpt.attempts}), ` +
        `Claude ready=${tokenizerHealth.models.claude.ready} (attempts=${tokenizerHealth.models.claude.attempts}), ` +
        `fallbacks=${JSON.stringify(tokenizerHealth.fallbacks)}`
    );
    // Initialize server health tracking (build staleness detection)
    initServerHealth();
    const serverHealth = getServerHealth();
    console.error(
      `[INFO] Server health: pid=${serverHealth.pid} build=${serverHealth.startupBuild?.buildHash.slice(0, 12) ?? 'none'}…`
    );

    console.error(`[INFO] Server components initialized successfully`);

    return context;
  } catch (error) {
    const missionError = ErrorHandler.handle(
      error,
      'server.initialize',
      {
        module: 'server',
      },
      {
        rethrow: false,
        userMessage: 'Failed to initialize Mission Protocol server components.',
      }
    );
    throw missionError;
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    if (process.argv.includes('--whoami')) {
      const exitCode = await whoamiCliRunner();
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
      return;
    }

    // Initialize all server components
    const context = await initializeServer();

    // Register tool handlers
    registerToolHandlers(context);

    // Create stdio transport
    const transport = new StdioServerTransport();

    // Connect server to transport
    await server.connect(transport);

    console.error(`[INFO] Mission Protocol MCP server running on stdio`);
    console.error(`[INFO] Server: ${SERVER_CONFIG.name} v${SERVER_CONFIG.version}`);
    const totalTools = getToolDefinitions().length;
    console.error(`[INFO] ${totalTools} tools registered`);
    if (context.cmosDetected) {
      console.error(`[INFO] CMOS detected, ${CMOS_TOOL_DEFINITIONS.length} CMOS tools enabled`);
      console.error(`[INFO] CMOS database: ${context.cmosDatabasePath}`);
    }
  } catch (error) {
    const missionError = ErrorHandler.handle(
      error,
      'server.startup',
      {
        module: 'server',
        data: {
          stage: 'startup',
        },
      },
      {
        rethrow: false,
        userMessage: 'Mission Protocol server startup failed.',
      }
    );
    const publicError = ErrorHandler.toPublicError(missionError);
    const correlationFragment = publicError.correlationId
      ? ` (correlationId=${publicError.correlationId})`
      : '';
    console.error(`[FATAL] Server startup failed${correlationFragment}: ${publicError.message}`);
    process.exit(1);
  }
}

export const __test__ = {
  registerToolHandlers,
  initializeServer,
  main,
  runWhoamiCli,
  server,
  setContextBuilder: (builder: typeof buildMissionProtocolContext) => {
    contextBuilder = builder;
  },
  resetContextBuilder: () => {
    contextBuilder = buildMissionProtocolContext;
  },
  setWhoamiCliRunner: (runner: typeof runWhoamiCli) => {
    whoamiCliRunner = runner;
  },
  resetWhoamiCliRunner: () => {
    whoamiCliRunner = runWhoamiCli;
  },
  setStartupAttributionSelfTestRunner: (runner: typeof runStartupAttributionSelfTest) => {
    startupAttributionSelfTestRunner = runner;
  },
  resetStartupAttributionSelfTestRunner: () => {
    startupAttributionSelfTestRunner = runStartupAttributionSelfTest;
  },
  runStartupRegistryPrune,
  setStartupRegistryPruneRunner: (runner: typeof runStartupRegistryPrune) => {
    startupRegistryPruneRunner = runner;
  },
  resetStartupRegistryPruneRunner: () => {
    startupRegistryPruneRunner = runStartupRegistryPrune;
  },
  setStartupProjectKeyRecoveryRunner: (runner: typeof runStartupProjectKeyRecovery) => {
    startupProjectKeyRecoveryRunner = runner;
  },
  resetStartupProjectKeyRecoveryRunner: () => {
    startupProjectKeyRecoveryRunner = runStartupProjectKeyRecovery;
  },
  setStartupCredentialCheckRunner: (runner: typeof runStartupCredentialCheck) => {
    startupCredentialCheckRunner = runner;
  },
  resetStartupCredentialCheckRunner: () => {
    startupCredentialCheckRunner = runStartupCredentialCheck;
  },
  runStartupBundledEnvCheck,
  setStartupBundledEnvCheckRunner: (runner: typeof runStartupBundledEnvCheck) => {
    startupBundledEnvCheckRunner = runner;
  },
  resetStartupBundledEnvCheckRunner: () => {
    startupBundledEnvCheckRunner = runStartupBundledEnvCheck;
  },
};

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.error(`[INFO] Received SIGINT, shutting down gracefully...`);
  try {
    await server.close();
  } catch (error) {
    ErrorHandler.handle(
      error,
      'server.shutdown',
      {
        module: 'server',
        data: {
          signal: 'SIGINT',
        },
      },
      {
        rethrow: false,
        userMessage: 'Graceful shutdown encountered an issue.',
      }
    );
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error(`[INFO] Received SIGTERM, shutting down gracefully...`);
  try {
    await server.close();
  } catch (error) {
    ErrorHandler.handle(
      error,
      'server.shutdown',
      {
        module: 'server',
        data: {
          signal: 'SIGTERM',
        },
      },
      {
        rethrow: false,
        userMessage: 'Graceful shutdown encountered an issue.',
      }
    );
  }
  process.exit(0);
});

// Start the server
if (require.main === module) {
  main().catch((error) => {
    const missionError = ErrorHandler.handle(
      error,
      'server.unhandled',
      {
        module: 'server',
      },
      {
        rethrow: false,
        userMessage: 'Mission Protocol encountered an unrecoverable error.',
      }
    );
    const publicError = ErrorHandler.toPublicError(missionError);
    const correlationFragment = publicError.correlationId
      ? ` (correlationId=${publicError.correlationId})`
      : '';
    console.error(`[FATAL] Unhandled error${correlationFragment}: ${publicError.message}`);
    process.exit(1);
  });
}
