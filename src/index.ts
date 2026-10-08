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
import { debugEnabled, debugLog } from './debug-log';

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
    // s92-m07: diagnostics, behind CMOS_DEBUG (checked after loading, so the .env can set it).
    if (debugEnabled())
      process.stderr.write(`[env-loader] loaded ${loaded} vars from ${envPath}\n`);
  } else if (debugEnabled()) {
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
import {
  ProjectGraphRegistry,
  reconfirmDefaultCall,
  unappliedDefaultNotice,
} from './intelligence/project-graph-registry';
import {
  resolveSenderContext,
  SenderResolutionError,
  SERVER_INSTALL_ROOT,
  type ResolvedBy,
  type SenderContext,
} from './intelligence/sender-context';
import {
  findEnclosingStore,
  getServerProjectRoot,
  parseProjectRootArg,
  PROJECT_ROOT_ARG,
  setServerProjectRoot,
} from './intelligence/resolution-policy';
import {
  assertReadOnlyAgentAllowed,
  ReadOnlyAgentGuardError,
} from './tools/cmos/read-only-agent-guard';
import { classifyAction } from './tools/cmos/action-taxonomy';
import {
  captureToolCall,
  currentToolCallActionMode,
  projectIdentityDisclosuresForError,
  unwrapCapturedToolCallError,
} from './tools/cmos/tool-call-context';
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
  CmosErrors,
} from './tools/cmos';
import type {
  CmosToolError,
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
import { findWrongTypedStringParam } from './tools/cmos/param-type-guard';
import { classifySenderResolutionError } from './tools/cmos/sender-refusal';
import { toWireDefinition } from './tools/cmos/wire-descriptions';
import { SERVER_INSTRUCTIONS } from './server-instructions';
import { closeOwnImplicitSessions } from './tools/cmos/implicit-session-lifecycle';
import { findUnknownTopLevelParam } from './tools/cmos/unknown-param-guard';
import { TokenCounter } from './intelligence/token-counters';
import { SupportedModel } from './intelligence/types';
import { CMOS_SCHEMA_VERSION } from './tools/cmos/schema';
import { ErrorHandler } from './errors/handler';
import { ErrorLogger } from './errors/logger';
import type { JsonValue } from './errors/types';
import { initServerHealth, getServerHealth } from './server-health';
import {
  runStartupProjectKeyRecovery,
  runStartupCredentialCheck,
} from './auth/project-key-capture';

/**
 * Resolve the server version from package.json at runtime — shared by both bins.
 *
 * s77-m04: a sync fs read of the sibling package.json (dist/ sits one level below
 * package.json in both the repo and the installed tarball) with a hardcoded
 * fallback, so bumping package.json changes the announced version with NO code
 * edit (chosen over a JSON import or the build-manifest to keep the announce
 * decoupled from the build step).
 */
export function getServerVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // fall through to the hardcoded fallback below
  }
  return '2.0.0';
}

/**
 * MCP Server Configuration — one truthful identity (s77-m04). The server NAME is
 * the literal 'cmos-mcp' (not the retired 'mission-protocol', nor the scoped
 * '@aquex/cmos-mcp'); the version is sourced from package.json.
 */
const SERVER_CONFIG = {
  name: 'cmos-mcp',
  version: getServerVersion(),
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
    // s92-m08: the loop, for every client, without a rules file.
    instructions: SERVER_INSTRUCTIONS,
  }
);

const errorLogger = new ErrorLogger();
ErrorHandler.useLogger(errorLogger);

/**
 * Mission Protocol server context shared across handlers
 */
export interface MissionProtocolContext {
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
/**
 * What tools/list sends: every published definition in its fixed, declared order, with the short
 * wire text (s92-m08). The full text stays on CMOS_TOOL_DEFINITIONS and in TOOL_REFERENCE.md.
 */
export function getToolDefinitions(): readonly ToolDefinition[] {
  return (CMOS_TOOL_DEFINITIONS as unknown as ToolDefinition[]).map(toWireDefinition);
}

/**
 * Parameters whose malformed JSON type can throw before a CMOS handler gets a chance to return
 * its normal structured validation error. This boundary list is intentionally unconditional:
 * every published tool accepts `projectRoot` as a string, and resolution reads it before the
 * action router for most tools.
 */
export const PREFLIGHT_PARAMS = ['projectRoot'] as const;

interface PublishedSchemaProperty {
  readonly enum?: readonly unknown[];
}

interface PublishedToolSchema {
  readonly properties?: Readonly<Record<string, PublishedSchemaProperty | undefined>>;
}

/** Return a known, schema-derived refusal before sender resolution; unknown tools pass through. */
function preflightMissionProtocolTool(name: string, args: unknown): CmosToolError | null {
  const definition = (CMOS_TOOL_DEFINITIONS as readonly ToolDefinition[]).find(
    (candidate) => candidate.name === name
  );
  if (!definition) return null;

  const actionProperty = (definition.inputSchema as PublishedToolSchema).properties?.['action'];
  const availableActions = actionProperty?.enum;
  if (Array.isArray(availableActions)) {
    const providedAction =
      args && typeof args === 'object' ? (args as Record<string, unknown>)['action'] : undefined;
    if (!availableActions.includes(providedAction)) {
      return CmosErrors.invalidAction(name, providedAction, availableActions.map(String));
    }
  }

  const wrongTyped = findWrongTypedStringParam(definition.inputSchema, PREFLIGHT_PARAMS, args);
  if (wrongTyped) return wrongTyped;

  // s91-m02: precedence is action, then projectRoot type, then unknown top-level keys.
  return findUnknownTopLevelParam(name, definition.inputSchema, args);
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
  defaultModel?: SupportedModel;
}): Promise<MissionProtocolContext> {
  const defaultModel = options?.defaultModel ?? 'claude';

  // Initialize token counter for intelligence tools
  const tokenCounter = new TokenCounter();

  // Detect CMOS in the project (respects CMOS_PROJECT_ROOT env var)
  const projectRoot = resolveProjectRoot();
  const detector = CmosDetector.getInstance({ cacheTtlMs: 60_000 });
  const cmosResult = await detector.detect(projectRoot);
  const cmosDetected = cmosResult.hasCmosDirectory && cmosResult.hasDatabase;

  return {
    defaultModel,
    tokenCounter,
    cmosDetected,
    cmosDatabasePath: cmosResult.databasePath,
  };
}

let contextBuilder: typeof buildMissionProtocolContext = buildMissionProtocolContext;
let whoamiCliRunner: typeof runWhoamiCli = runWhoamiCli;
// s92-m07: the second startup line; replaceable so a test never resolves the real working directory.
let startupProjectDescriber: () => Promise<string> = describeStartupProject;
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
        debugLog(`[INFO] Client project roots from MCP roots: ${roots.join(', ')}`);
      }
    }
  } catch (error) {
    // Client may not support roots - this is fine, fall back to other methods
    debugLog(
      `[DEBUG] Could not get client roots: ${error instanceof Error ? error.message : 'unknown'}`
    );
  }

  cachedClientProjectRoots = roots;
  return cachedClientProjectRoots;
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
 * s92-m04 — whether the project was NAMED rather than inferred: an explicit projectRoot, the
 * client's roots, or the operator's --project-root. A named project is not ambiguous for want of
 * advertised roots, so onboard and the review opener stop prescribing whoami for it.
 */
function callerNamedProject(explicitRoot: unknown, source: ResolvedBy): boolean {
  return (
    typeof explicitRoot === 'string' ||
    source === 'explicit' ||
    source === 'mcp-roots' ||
    source === 'server-project-root'
  );
}

/**
 * s92-m01 — which store a call touched and how it was chosen. Stamped onto every success
 * payload so an agent never has to infer the project from context.
 */
export interface ResolutionStamp {
  readonly projectRoot: string | null;
  readonly resolvedBy: ResolvedBy;
  /** Rendered instead of the plain "resolved by" label when the route needs saying out loud. */
  readonly note?: string;
}

/** A call that touched no single project store: a portfolio, registry or dashboard-only action. */
const NO_PROJECT: ResolutionStamp = { projectRoot: null, resolvedBy: 'none' };

function stampOf(ctx: SenderContext | null): ResolutionStamp {
  if (!ctx) return NO_PROJECT;
  // The client advertised workspace roots, none of them is inside a CMOS project, and the
  // server's working directory answered instead. That is the documented order, but the caller
  // may be working in one of those roots — say so rather than resolve silently.
  const rootsSkipped =
    ctx.source === 'cwd' &&
    ctx.candidates.some((candidate) => candidate.source === 'mcp-roots' && !candidate.accepted);
  return rootsSkipped
    ? {
        projectRoot: ctx.projectRoot,
        resolvedBy: ctx.source,
        note: "resolved by the server's working directory — the client's MCP roots hold no CMOS project",
      }
    : { projectRoot: ctx.projectRoot, resolvedBy: ctx.source };
}

/**
 * The sources an agent may not expect, so the answer says them out loud. `explicit` (the caller
 * named it) and `cwd` (the caller is standing in it) stay silent.
 */
const RESOLVED_BY_LABELS: Partial<Record<ResolvedBy, string>> = {
  'mcp-roots': "the client's MCP roots",
  'server-project-root': "--project-root in this server's config",
  'registry-default': 'the registry default project',
};

/**
 * Build the MCP answer for a CMOS tool result. On success, `projectRoot` and `resolvedBy` are
 * added to `data` (a handler's own `projectRoot` is kept), and one line naming the project is
 * rendered when it was chosen by anything other than an explicit root or the cwd.
 */
export function buildResolvedToolResult(
  result: { success: boolean; data?: unknown },
  formatted: string,
  stamp: ResolutionStamp
): CallToolResult {
  const structured: Record<string, unknown> = { ...result };
  let text = formatted;
  if (result.success) {
    const data = result.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const record = data as Record<string, unknown>;
      structured.data = {
        ...record,
        projectRoot:
          typeof record.projectRoot === 'string' ? record.projectRoot : stamp.projectRoot,
        resolvedBy: stamp.resolvedBy,
      };
    } else {
      structured.projectRoot = stamp.projectRoot;
      structured.resolvedBy = stamp.resolvedBy;
    }
    const label = RESOLVED_BY_LABELS[stamp.resolvedBy];
    const reason = stamp.note ?? (label ? `resolved by ${label}` : null);
    if (reason && stamp.projectRoot) {
      text = `Project: ${stamp.projectRoot} (${reason})\n\n${formatted}`;
    }
  }
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
    isError: result.success === false,
  };
}

/** whoami reports resolution itself; its stamp is the local project its resolution found. */
function whoamiStamp(result: {
  data?: { resolved?: { projectRoot: string | null; source: ResolvedBy | null } };
}): ResolutionStamp {
  const resolved = result.data?.resolved;
  return resolved?.projectRoot && resolved.source
    ? { projectRoot: resolved.projectRoot, resolvedBy: resolved.source }
    : NO_PROJECT;
}

/**
 * Resolve a project for an action that can run without one (a user-level dashboard action):
 * use the caller's project when one resolves, and run project-free when none does. An explicit
 * projectRoot is still final — naming a folder that is not a CMOS project is refused.
 */
async function resolveOptionalSenderContext(
  explicitRoot: string | undefined
): Promise<SenderContext | null> {
  if (explicitRoot !== undefined) return resolveToolSenderContext(explicitRoot);
  try {
    return await resolveToolSenderContext(undefined);
  } catch (error) {
    if (error instanceof SenderResolutionError) return null;
    throw error;
  }
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
    debugLog(`[INFO] Client roots changed, clearing cache`);
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

      // Establish the outer request carrier here so failures retain this call's disclosures.
      // executeMissionProtocolTool sees the active ALS context and runs its switch directly.
      const actionMode = classifyAction(name, extractActionArg(args));
      const captured = await captureToolCall(actionMode, () =>
        executeMissionProtocolTool(name, args, context)
      );
      return attachProjectIdentityDisclosures(captured.value, captured.projectIdentityDisclosures);
    } catch (error) {
      const originalError = unwrapCapturedToolCallError(error);
      if (originalError instanceof SenderResolutionError) {
        return attachProjectIdentityDisclosures(
          buildKnownToolErrorResult(
            await classifySenderResolutionError(
              originalError,
              refusalMode(classifyAction(name, extractActionArg(args)))
            )
          ),
          projectIdentityDisclosuresForError(error)
        );
      }
      // Sprint 74 m03: a tool HANDLER that throws an unhandled exception (a
      // write-path crash — e.g. cmos_sprint(complete)/cmos_session(capture)
      // hitting a store-specific failure) is a tool-EXECUTION failure, not a
      // protocol error. Surface it as a structured CmosToolResult error
      // (code + real message + suggestion) returned as an isError result —
      // never a bare JSON-RPC -32603 that swallows the cause (aquex.ai aa124685).
      // Genuine protocol errors (McpError: unknown tool, uninitialized context)
      // keep their JSON-RPC error shape — they already carry a clear message.
      if (originalError instanceof McpError) {
        throw originalError;
      }
      return attachProjectIdentityDisclosures(
        buildToolExecutionErrorResult(name, args, originalError),
        projectIdentityDisclosuresForError(error)
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
  const reportableError =
    error instanceof Error ? error : new Error(typeof error === 'string' ? error : String(error));
  const sanitizedArgs = sanitizeArgs(args);
  const data: Record<string, JsonValue> = { tool: toolName };
  if (sanitizedArgs) {
    data.args = sanitizedArgs;
  }

  const missionError = ErrorHandler.handle(
    reportableError,
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

  const structuredError: CmosToolError = {
    code: CMOS_ERROR_CODES.TOOL_EXECUTION_ERROR,
    message: `The '${toolName}' tool failed with an unhandled internal error: ${detail}`,
    // s89-m08 CLASS 3. This used to open "This is an internal error, not an input-validation
    // problem". That is a UNIVERSAL claim about the CAUSE, made by a catch-all boundary that
    // has only an unhandled exception and a correlationId and cannot know it — and it was
    // measurably FALSE for the whole wrong-typed-parameter class (42 triples), where the cause
    // was exactly an input-validation problem. It also prescribed "retry the call", a loop with
    // no exit for any deterministic fault. Say only what this frame knows.
    suggestion: `The tool raised an exception this boundary did not expect, so the cause is not classified here; the message above is the raw failure. If it repeats with the same inputs, it is deterministic — capture the tool inputs and report this${correlationSuffix}.`,
  };
  return buildKnownToolErrorResult(structuredError);
}

/**
 * Render a refusal whose cause is already known. Unlike the catch-all execution-error boundary,
 * this helper performs no logging and creates no correlation id: expected client/setup faults are
 * not internal incidents.
 */
export function buildKnownToolErrorResult(error: CmosToolError): CallToolResult {
  const structured = { success: false as const, error };
  const suggestion = error.suggestion ? `\nSuggestion: ${error.suggestion}` : '';
  const text =
    `Tool execution error [${error.code}]: ${error.message}${suggestion}\n\n` +
    JSON.stringify(structured, null, 2);

  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
    isError: true,
  };
}

/** s92-m01: a refusal tells a read how to read and anything else how to write. */
function refusalMode(actionMode: string | undefined): 'read' | 'write' {
  return actionMode === 'read' ? 'read' : 'write';
}

/** Best-effort read of the `action` discriminator from a tool's args, for the
 *  read-only-agent guard. Returns undefined for action-less tools or malformed args. */
function extractActionArg(args: unknown): string | undefined {
  if (args && typeof args === 'object' && 'action' in args) {
    const value = (args as { action?: unknown }).action;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

// s92-m01: `classifySenderResolutionError` moved to `tools/cmos/sender-refusal.ts` so the suggestion
// oracle can drive it in-process; re-exported here for existing importers.
export { classifySenderResolutionError };

/** Attach request-local fallback-identity disclosures to both MCP answer channels. */
function attachProjectIdentityDisclosures(
  result: CallToolResult,
  disclosures: readonly string[]
): CallToolResult {
  if (disclosures.length === 0) return result;

  const structured =
    result.structuredContent && typeof result.structuredContent === 'object'
      ? (result.structuredContent as Record<string, unknown>)
      : {};
  const existingWarnings = Array.isArray(structured.warnings)
    ? structured.warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
  const warnings = [...new Set([...existingWarnings, ...disclosures])];
  const section =
    `Project identity disclosure${disclosures.length === 1 ? '' : 's'}:\n` +
    disclosures.map((disclosure) => `- ${disclosure}`).join('\n');
  const content = [...result.content];
  const textIndex = content.findIndex((part) => part.type === 'text');
  if (textIndex >= 0) {
    const part = content[textIndex];
    if (part.type === 'text') {
      content[textIndex] = { ...part, text: `${part.text}\n\n${section}` };
    }
  } else {
    content.push({ type: 'text', text: section });
  }

  return {
    ...result,
    content,
    structuredContent: { ...structured, warnings },
  };
}

export async function executeMissionProtocolTool(
  name: string,
  args: unknown,
  _context: MissionProtocolContext
): Promise<CallToolResult> {
  // s88-m08: establish one concurrency-safe request context before resolution or DB open. The
  // recursive call sees the active context and executes the existing switch unchanged; keeping
  // the switch in this exported function preserves the static router-param audit's reach.
  if (currentToolCallActionMode() === undefined) {
    const actionMode = classifyAction(name, extractActionArg(args));
    try {
      const captured = await captureToolCall(actionMode, () =>
        executeMissionProtocolTool(name, args, _context)
      );
      return attachProjectIdentityDisclosures(captured.value, captured.projectIdentityDisclosures);
    } catch (error) {
      const originalError = unwrapCapturedToolCallError(error);
      if (originalError instanceof SenderResolutionError) {
        return attachProjectIdentityDisclosures(
          buildKnownToolErrorResult(
            await classifySenderResolutionError(originalError, refusalMode(actionMode))
          ),
          projectIdentityDisclosuresForError(error)
        );
      }
      // Direct callers retain the established McpError instanceof/code contract. Known sender
      // setup refusals above are the deliberate exception: they now use the same structured
      // result and disclosure carrier as the registered CallTool boundary.
      throw originalError;
    }
  }

  // Client/schema failures and protocol method lookup precede the authorization guard: neither can
  // mutate state, and they retain INVALID_ACTION / MethodNotFound even in a review-role process.
  const definitionExists = (CMOS_TOOL_DEFINITIONS as readonly ToolDefinition[]).some(
    (definition) => definition.name === name
  );
  if (!definitionExists) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }

  const preflightError = preflightMissionProtocolTool(name, args);
  if (preflightError) {
    return buildKnownToolErrorResult(preflightError);
  }

  // Sprint 78 m04 (FORK-5): read-only review-agent guard. It still runs before the switch and any
  // resolveToolSenderContext / DB open, so a blocked valid write opens no DB and mutates no row.
  // Strict no-op unless CMOS_AGENT_ROLE=review; then write-classified calls are hard-rejected.
  try {
    assertReadOnlyAgentAllowed(name, extractActionArg(args));
  } catch (error) {
    if (error instanceof ReadOnlyAgentGuardError) {
      return buildToolExecutionErrorResult(name, args, error);
    }
    throw error;
  }

  switch (name) {
    // ========================================
    // CMOS Tools (always available, return graceful error if not detected)
    // ========================================

    // Consolidated DB admin tool (Sprint 24)
    case 'cmos_db': {
      const params = args as CmosDbParams;
      const ctx = await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx.projectRoot;
      const result = await cmosDb({ ...params, projectRoot });
      const formatted = formatDbForLLM(params.action, result);

      return buildResolvedToolResult(result, formatted, stampOf(ctx));
    }

    // Consolidated mission CRUD tool (Sprint 24)
    case 'cmos_mission': {
      const params = args as CmosMissionParams;

      // s79-m04/m05 — no per-handler fan-out. cmos_mission(status) with no
      // projectRoot resolves to the sender; "active missions across the portfolio"
      // is served by acrossProjects=true (the graph-backed queryAcrossStores),
      // which must NOT require a resolvable LOCAL store.
      // s92-m01: ONLY that portfolio read skips the local requirement (the local project is
      // still used, when one resolves, to label rows local or foreign). Every other action
      // resolves normally, so the flag can never redirect a write: add/update with
      // acrossProjects=true used to drop an explicit projectRoot and write the cwd project.
      const portfolioRead = params.acrossProjects === true && params.action === 'status';
      const ctx = portfolioRead
        ? await resolveOptionalSenderContext(params.projectRoot)
        : await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx?.projectRoot;
      const result = await cmosMission({ ...params, projectRoot });
      const formatted = formatMissionForLLM(params.action, result);

      return buildResolvedToolResult(result, formatted, portfolioRead ? NO_PROJECT : stampOf(ctx));
    }

    // Consolidated mission transition tool (Sprint 24)
    case 'cmos_mission_transition': {
      const params = args as CmosMissionTransitionParams;
      const ctx = await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx.projectRoot;
      const result = await cmosMissionTransition({ ...params, projectRoot });
      const formatted = formatMissionTransitionForLLM(params.action, result);

      return buildResolvedToolResult(result, formatted, stampOf(ctx));
    }

    // Consolidated context tool (Sprint 24)
    case 'cmos_context': {
      const params = args as CmosContextParams;

      const ctx = await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx.projectRoot;
      const result = await cmosContext({ ...params, projectRoot });
      const formatted = formatContextForLLM(params.action, result, params.contextType);

      return buildResolvedToolResult(result, formatted, stampOf(ctx));
    }

    // Consolidated session tool (Sprint 24)
    case 'cmos_session': {
      const params = args as CmosSessionParams;

      // s79-m04 — cmos_session(list) with no projectRoot pins to the sender (no
      // §5.4 named portfolio query; documented deviation from the master-plan wording).
      const ctx = await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx.projectRoot;
      const result = await cmosSession({ ...params, projectRoot });
      const formatted = formatSessionForLLM(params.action, result);

      return buildResolvedToolResult(result, formatted, stampOf(ctx));
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
      // s92-m01: only list is the portfolio read. record/update/search with acrossProjects=true
      // used to skip resolution too, drop an explicit projectRoot and write the cwd project.
      const portfolioRead = params.acrossProjects === true && params.action === 'list';
      const ctx = portfolioRead
        ? await resolveOptionalSenderContext(params.projectRoot)
        : await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx?.projectRoot;
      const result = await cmosDecisions({ ...params, projectRoot });
      const formatted = formatDecisionsForLLM(params.action, result);

      return buildResolvedToolResult(result, formatted, portfolioRead ? NO_PROJECT : stampOf(ctx));
    }

    // Consolidated learnings tool (Sprint 38)
    case 'cmos_learnings': {
      const params = args as CmosLearningsParams;
      // s79-m05: acrossProjects (list) is a graph-backed portfolio query — skip
      // local-root resolution (mirrors cmos_decisions / cmos_mission).
      // s92-m01: only list is the portfolio read; every other action resolves normally.
      const portfolioRead = params.acrossProjects === true && params.action === 'list';
      const ctx = portfolioRead
        ? await resolveOptionalSenderContext(params.projectRoot)
        : await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx?.projectRoot;
      const result = await cmosLearnings({ ...params, projectRoot });
      const formatted = formatLearningsForLLM(params.action, result);

      return buildResolvedToolResult(result, formatted, portfolioRead ? NO_PROJECT : stampOf(ctx));
    }

    // Consolidated feedback tool (Sprint 56 m03)
    case 'cmos_feedback': {
      const params = args as CmosFeedbackParams;
      const ctx = await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx.projectRoot;
      const result = await cmosFeedback({ ...params, projectRoot });
      const formatted = formatFeedbackForLLM(params.action, result);

      return buildResolvedToolResult(result, formatted, stampOf(ctx));
    }

    // Credential lifecycle (Sprint 57 m03)
    case 'cmos_auth': {
      const params = args as CmosAuthParams;
      // s92-m01: login, list and logout are USER-level — they need a dashboard credential, not a
      // project. Once the registry-singleton auto-pick was removed they would otherwise refuse from
      // any non-CMOS folder, so they use the caller's project when one resolves and run
      // project-free when none does. revoke takes the same route: with a keyId it needs no
      // project, and without one its handler refuses "revoke requires either keyId or
      // projectRoot". rotate and reissue act on a project's key and still require one. An
      // explicit projectRoot is final on every route.
      const userLevel =
        params.action === 'login_init' ||
        params.action === 'login_complete' ||
        params.action === 'login' ||
        params.action === 'list' ||
        params.action === 'logout' ||
        params.action === 'revoke';
      const ctx = userLevel
        ? await resolveOptionalSenderContext(params.projectRoot)
        : await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx?.projectRoot;
      const result = await cmosAuth({ ...params, projectRoot });
      const formatted = formatAuthForLLM(params.action, result);

      return buildResolvedToolResult(result, formatted, stampOf(ctx));
    }

    // At-a-glance status payload (Sprint 62 m06)
    case 'cmos_status': {
      const params = args as CmosStatusParams;
      const ctx = await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx.projectRoot;
      const result = await cmosStatus({ ...params, projectRoot });
      const formatted = formatStatusForLLM(result);

      return buildResolvedToolResult(result, formatted, stampOf(ctx));
    }

    // Sprint tools
    case 'cmos_sprint': {
      const params = args as CmosSprintParams;

      const ctx = await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx.projectRoot;
      const result = await cmosSprint({ ...params, projectRoot });
      const formatted = formatSprintForLLM(params.action, result);

      return buildResolvedToolResult(result, formatted, stampOf(ctx));
    }

    case 'cmos_agent_onboard': {
      const params = args as CmosAgentOnboardParams;
      const advertisedRoots = await getClientProjectRoots();
      const ctx = await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx.projectRoot;
      const result = await cmosAgentOnboard({
        ...params,
        projectRoot,
        advertisedRoots,
        callerProvidedProjectRoot: callerNamedProject(params.projectRoot, ctx.source),
      });
      const formatted = formatAgentOnboardForLLM(result);

      return buildResolvedToolResult(result, formatted, stampOf(ctx));
    }

    // Bundled session-opener digest (Sprint 64 m03).
    // Project-scoped by design — does NOT walk the project registry.
    case 'cmos_review': {
      const params = args as CmosReviewParams;
      const advertisedRoots = await getClientProjectRoots();
      const ctx = await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx.projectRoot;
      // s92-m01: the digest carries projectRoot/resolvedBy inside its own 4KB budget.
      // s92-m04: the roots and "the caller named the project" reach the nested onboard, so a
      // project the client or operator named is not reported as ambiguous (the whoami nudge).
      const result = await cmosReview(
        { ...params, projectRoot },
        {
          resolvedBy: ctx.source,
          advertisedRoots,
          callerProvidedProjectRoot: callerNamedProject(params.projectRoot, ctx.source),
        }
      );
      const formatted = formatReviewForLLM(result);

      return buildResolvedToolResult(result, formatted, stampOf(ctx));
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

        // whoami reports resolution itself; its stamp is the relaxed (local) resolution it found.
        return buildResolvedToolResult(result, formatted, whoamiStamp(result));
      }

      // Sprint 53 m02: `send` must resolve through the audited boundary with
      // `requireSenderIdentity=true`. The former path bypassed root resolution
      // entirely (see sprint-53-attribution-rebuild.md §Verified Root Cause #2)
      // and was the structural source of the Stage1→OODS P0. Non-send actions
      // (list/respond/directory) hit the dashboard directly and don't need a
      // local project identity, so they skip resolution.
      let projectRoot: string | undefined;
      let stamp: ResolutionStamp = NO_PROJECT;
      if (params.action === 'send') {
        const ctx = await resolveSenderContext({
          explicitProjectRoot: params.projectRoot,
          mcpRoots: advertisedRoots,
          requireSenderIdentity: true,
        });
        projectRoot = ctx.projectRoot;
        stamp = stampOf(ctx);
      } else if (params.projectRoot !== undefined) {
        // s92-m01: an explicit projectRoot is final on every action. The dashboard-only actions
        // used to pass it through unchecked (and a non-CMOS folder would have been reported as
        // the project the call used).
        const ctx = await resolveToolSenderContext(params.projectRoot);
        projectRoot = ctx.projectRoot;
        stamp = stampOf(ctx);
      } else if (params.action === 'list') {
        // s80-m05: best-effort project-pin for LIST only — resolve the sender RELAXED so
        // a project-scoped credential (when one exists) scopes the dashboard query and
        // trims the payload. A read must NEVER fail closed, so an unresolvable sender
        // fails OPEN: leave projectRoot undefined and fall through to user-scoped auth.
        // NB: `get` is deliberately NOT pinned — pinning would narrow its client-side
        // paging to one project, hiding a valid messageId from another of the operator's
        // projects (s80-m05 review). get uses user-scoped (widest) visibility.
        try {
          const ctx = await resolveSenderContext({
            explicitProjectRoot: params.projectRoot,
            mcpRoots: advertisedRoots,
            requireSenderIdentity: false,
          });
          projectRoot = ctx.projectRoot;
          stamp = stampOf(ctx);
        } catch {
          // fail-open — user-scoped auth returns the operator's full inbox
        }
      }
      const result = await cmosMessage({ ...params, projectRoot, advertisedRoots });
      const formatted = formatMessageForLLM(params.action, result);

      return buildResolvedToolResult(result, formatted, stamp);
    }

    // Consolidated project tool (Sprint 24)
    case 'cmos_project': {
      const params = args as CmosProjectParams;
      // init/register/unregister take a literal user-supplied path (destination for a new
      // workspace, a path to register, a path to forget). Routing through resolveToolSenderContext
      // would substitute the caller's own project: before s92-m01 an unregister of a deleted
      // project fell through to the cwd project and unregistered THAT. The action handlers
      // validate the path themselves and reject empty/missing input.
      const isLiteralPathAction =
        params.action === 'init' || params.action === 'register' || params.action === 'unregister';
      // list/validate/prune/sweep read or tidy the registry itself and never open a project store,
      // so they do not need — and must not refuse for lack of — a resolvable local project.
      const isRegistryAction =
        params.action === 'list' ||
        params.action === 'validate' ||
        params.action === 'prune' ||
        params.action === 'sweep';
      let stamp: ResolutionStamp = NO_PROJECT;
      let projectRoot: string | undefined = params.projectRoot;
      if (isLiteralPathAction) {
        if (typeof projectRoot === 'string' && projectRoot.trim() !== '') {
          stamp = { projectRoot: path.resolve(projectRoot), resolvedBy: 'explicit' };
        }
      } else if (!isRegistryAction) {
        const ctx = await resolveToolSenderContext(params.projectRoot);
        projectRoot = ctx.projectRoot;
        stamp = stampOf(ctx);
      }
      const result = await cmosProject({ ...params, projectRoot });
      const formatted = formatProjectForLLM(params.action, result, {
        validate: params.validate,
      });

      return buildResolvedToolResult(result, formatted, stamp);
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
    // s79-m03 — prune/archive against the project-graph registry (rows whose
    // store's cmos/db/cmos.sqlite vanished). s80-m02: the graph is the single
    // discovery source — no JSON mirror to re-derive.
    const graph = await ProjectGraphRegistry.create();
    const before = graph.list().length;
    const pruned = graph.pruneMissingStores();
    const remaining = graph.list().length;
    return { totalBefore: before, pruned, remaining, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return { totalBefore: null, pruned: 0, remaining: null, error: message };
  }
}

let startupRegistryPruneRunner: typeof runStartupRegistryPrune = runStartupRegistryPrune;

// Sprint 57 m02: startup recovery for partial-failure auto-issue. Non-fatal.
/** Result of the s78-m06 startup topology diagnostic. */
export interface StartupTopologyResult {
  /** True when the ambiguous-attribution topology was detected and warned. */
  warned: boolean;
  /** Whether CMOS_PROJECT_ROOT is pinned (non-empty). */
  projectRootPinned: boolean;
  /** Registered project count consulted for the ambiguity check. */
  registryProjectCount: number;
}

/**
 * s78-m06 topology diagnostic. WARNs ONLY in the single ambiguous-attribution
 * topology: a global MCP entry with CMOS_PROJECT_ROOT pinned to one repo WHILE more
 * than one project is registered — the config where one env pins .env bootstrap +
 * fallback attribution to a single repo that every sibling session shares. Silent for
 * the safe cases (local per-project server, or a single registered project). Pure so
 * it is unit-testable without booting.
 */
export function evaluateStartupTopology(
  projectRootEnv: string | undefined,
  registryProjectCount: number
): StartupTopologyResult {
  const projectRootPinned = (projectRootEnv ?? '').trim().length > 0;
  return {
    warned: projectRootPinned && registryProjectCount > 1,
    projectRootPinned,
    registryProjectCount,
  };
}

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
  // s92-m01: the cwd-vs-install-root guard is retired (fork 1), so this self-test no longer warns
  // when the install root resolves: a cwd equal to the install root resolves by cwd when it holds a
  // store, which is the intended route for work in this repository.
  try {
    const resolved = await resolveSenderContext({
      requireSenderIdentity: true,
    });
    return {
      projectRoot: resolved.projectRoot,
      source: resolved.source,
      errorCode: null,
      warning: null,
    };
  } catch (error) {
    if (error instanceof SenderResolutionError) {
      return {
        projectRoot: null,
        source: null,
        errorCode: error.code,
        warning: null,
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
    debugLog(`[INFO] Initializing MCP server...`);
    const context = await contextBuilder();
    debugLog(`[INFO] CMOS bundled seed schema version: ${CMOS_SCHEMA_VERSION}`);
    debugLog(`[INFO] Default intelligence model: ${context.defaultModel}`);

    // Sprint 53 m02 / m04: startup diagnostic for attribution. `SERVER_INSTALL_ROOT`
    // is the one path that must never be the *implicit* sender for another project;
    // operators see it here so they can verify before debugging misrouted sends.
    const envProjectRoot = process.env[CMOS_PROJECT_ROOT_ENV];
    debugLog(`[INFO] Server install root: ${SERVER_INSTALL_ROOT}`);
    debugLog(
      `[INFO] Sender attribution diagnostics: Server install root: ${SERVER_INSTALL_ROOT}. ` +
        `${CMOS_PROJECT_ROOT_ENV} env: ${envProjectRoot ?? 'unset'}. Roots support: probed on first call.`
    );
    if (envProjectRoot) {
      console.error(
        `[WARN] ${CMOS_PROJECT_ROOT_ENV}=${envProjectRoot} is set. It does not select a project for ` +
          `tool calls; the server reads it only to find its own .env. If you relied on ` +
          `this env to pin attribution, pass projectRoot explicitly or ensure your MCP client advertises ` +
          `roots. Every outbound send will fail-closed rather than silently attribute to the server's ` +
          `own project.`
      );
    } else {
      debugLog(`[INFO] ${CMOS_PROJECT_ROOT_ENV} env: unset (it does not select a project).`);
    }
    const registryPrune = await startupRegistryPruneRunner();
    if (registryPrune.error) {
      console.error(
        `[WARN] Registry prune skipped: ${registryPrune.error} — continuing startup with unpruned registry.`
      );
    } else if (registryPrune.pruned > 0) {
      debugLog(
        `[INFO] pruned ${registryPrune.pruned} stale entries from project registry (${registryPrune.remaining} remaining)`
      );
    } else {
      debugLog(
        `[INFO] Project registry healthy: ${registryPrune.remaining ?? 0} entries, no stale entries pruned`
      );
    }

    // s92-m01: say which defaults a contextless call can use, and which it cannot.
    const serverProjectRoot = getServerProjectRoot();
    if (serverProjectRoot) {
      const configured = findEnclosingStore(serverProjectRoot);
      if (configured?.hasDatabase && configured.root === serverProjectRoot) {
        debugLog(
          `[INFO] ${PROJECT_ROOT_ARG}: ${serverProjectRoot} (used for calls with no project context)`
        );
      } else {
        console.error(
          `[WARN] ${PROJECT_ROOT_ARG}: ${serverProjectRoot} holds no CMOS database; calls with no project context will be refused until it does.`
        );
      }
    }
    try {
      const status = (await ProjectGraphRegistry.create()).getDefaultStatus();
      const notice = unappliedDefaultNotice(status);
      if (notice && status.entry) {
        // Stays visible (s92-m07): an upgrader must re-confirm a pre-3.2.0 default, and this line,
        // whoami and cmos_review are where they learn it.
        console.error(`[INFO] ${notice}: ${reconfirmDefaultCall(status.entry)}`);
      }
    } catch {
      // Best-effort: the registry prune above already reported an unreadable registry.
    }

    const attributionSelfTest = await startupAttributionSelfTestRunner();
    if (attributionSelfTest.projectRoot && attributionSelfTest.source) {
      debugLog(
        `[INFO] Sender attribution self-test: ${attributionSelfTest.source} -> ${attributionSelfTest.projectRoot}`
      );
    } else {
      debugLog(
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
        debugLog(`[INFO] Project key recovery: ${recovery.message}`);
      } else if (recovery.status === 'error') {
        console.error(`[WARN] Project key recovery: ${recovery.message}`);
      } else if (
        // s86-m06: both attribution-failure statuses are WARN, not INFO. In either
        // one, auto-recovery is structurally impossible until the operator acts —
        // that is not information. The single status they replaced was logged at
        // INFO and named a cause ("run device code") that is false in one of them.
        recovery.status === 'skipped-no-user-scoped-key' ||
        recovery.status === 'skipped-unattributable-credential'
        // s87-m07 — VERIFIED, NOT CHANGED. This mission's critic pass proposed adding `'error'`
        // here, on the belief that the internal-inconsistency status fell through to [INFO]. It
        // does not: `error` is already routed to [WARN] by the branch above, so the new producer
        // this mission adds (the typed-unreachable null-client branch) is correctly logged. The
        // check is recorded rather than the non-change being silent.
      ) {
        console.error(`[WARN] Project key recovery: ${recovery.status} — ${recovery.message}`);
      } else {
        debugLog(`[INFO] Project key recovery: ${recovery.status} — ${recovery.message}`);
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

    // Sprint 78 m06: topology diagnostic. WARN only in the ambiguous-attribution
    // config — CMOS_PROJECT_ROOT pinned while >1 project is registered. Non-fatal.
    try {
      const topology = evaluateStartupTopology(
        process.env[CMOS_PROJECT_ROOT_ENV],
        registryPrune.remaining ?? 0
      );
      if (topology.warned) {
        console.error(
          `[WARN] cmos-mcp: ${CMOS_PROJECT_ROOT_ENV}=${process.env[CMOS_PROJECT_ROOT_ENV]} is pinned ` +
            `while ${topology.registryProjectCount} projects are registered. A single global MCP entry ` +
            `with this env pins .env bootstrap (and any dashboard key that .env holds) to one repo ` +
            `that every sibling session shares. Prefer a project-local server, or pass projectRoot ` +
            `explicitly per call. ` +
            `See SECURITY.md "Sanctioned deployment shape".`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(
        `[WARN] Startup topology diagnostic threw (non-fatal): ${message}. Continuing startup.`
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

    // s77-m03: the boot-time tokenizer preload + health log was removed. The
    // Claude (@xenova) tokenizer now loads lazily on first count(); Gemini is a
    // heuristic. No startup preload, no '[INFO] Tokenizer preload status' line.
    // Initialize server health tracking (build staleness detection)
    initServerHealth();
    const serverHealth = getServerHealth();
    debugLog(
      `[INFO] Server health: pid=${serverHealth.pid} build=${serverHealth.startupBuild?.buildHash.slice(0, 12) ?? 'none'}…`
    );

    debugLog(`[INFO] Server components initialized successfully`);

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
 * s92-m07: the second startup line. It names the project a call with no projectRoot and no MCP
 * roots would use, through the same resolution such a call runs. A client's roots arrive only after
 * initialize, so they can still name another project.
 */
async function describeStartupProject(): Promise<string> {
  try {
    const ctx = await resolveSenderContext({ requireSenderIdentity: false });
    const how =
      ctx.source === 'cwd'
        ? 'the working directory'
        : (RESOLVED_BY_LABELS[ctx.source] ?? ctx.source);
    return `project: ${ctx.projectRoot} (from ${how})`;
  } catch (error) {
    if (error instanceof SenderResolutionError) {
      return (
        'project: none at startup; each call names one with projectRoot, ' +
        "the client's MCP roots, or a working directory inside a project"
      );
    }
    return `project: not resolved at startup (${error instanceof Error ? error.message : 'unknown error'})`;
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    // s77-m04: --version / --help short-circuit in main() BEFORE initializeServer()
    // and server.connect() (mirror the --whoami branch) — else they would hang the
    // stdio server for every MCP host. Both print to stdout and exit 0.
    if (process.argv.includes('--version')) {
      process.stdout.write(`cmos-mcp ${getServerVersion()}\n`);
      process.exit(0);
    }
    if (process.argv.includes('--help')) {
      process.stdout.write(
        `cmos-mcp ${getServerVersion()} — MCP server for CMOS project management over SQLite.\n\n` +
          `Usage:\n` +
          `  cmos-mcp              Run the MCP server over stdio (default).\n` +
          `  cmos-mcp --version    Print the version and exit.\n` +
          `  cmos-mcp --help       Print this help and exit.\n` +
          `  cmos-mcp --whoami     Print sender-attribution diagnostics and exit.\n` +
          `  cmos-mcp ${PROJECT_ROOT_ARG} <dir>\n` +
          `                        Use <dir> for calls that carry no project context (no projectRoot,\n` +
          `                        no MCP roots, and a working directory of /, $HOME or the install\n` +
          `                        root) — the Claude Desktop recipe. Set it per server config.\n\n` +
          `The server speaks the Model Context Protocol on stdio; launch it from an MCP\n` +
          `host (Claude Code, Claude Desktop, Cursor, VS Code), not directly.\n`
      );
      process.exit(0);
    }

    // s92-m01: record --project-root before anything resolves (whoami included).
    setServerProjectRoot(parseProjectRootArg(process.argv));

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

    // s92-m03: when the client goes away, close this process's implicit sessions. Best effort, and
    // through the session handler, so nothing is uploaded on the way out; whatever is left open is
    // closed by the next reconcile once this process is gone.
    process.stdin.once('end', () => {
      void closeOwnImplicitSessions().catch(() => undefined);
    });

    debugLog(`[INFO] ${SERVER_CONFIG.name} MCP server running on stdio`);
    debugLog(`[INFO] Server: ${SERVER_CONFIG.name} v${SERVER_CONFIG.version}`);
    const totalTools = getToolDefinitions().length;
    debugLog(`[INFO] ${totalTools} tools registered`);
    if (context.cmosDetected) {
      debugLog(`[INFO] CMOS detected, ${CMOS_TOOL_DEFINITIONS.length} CMOS tools enabled`);
      debugLog(`[INFO] CMOS database: ${context.cmosDatabasePath}`);
    }

    // s92-m07: the two lines a normal start writes. Everything above is behind CMOS_DEBUG=1.
    console.error(`[cmos-mcp] v${SERVER_CONFIG.version} ready on stdio (${totalTools} tools)`);
    console.error(`[cmos-mcp] ${await startupProjectDescriber()}`);
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
  setStartupProjectDescriber: (describer: () => Promise<string>) => {
    startupProjectDescriber = describer;
  },
  resetStartupProjectDescriber: () => {
    startupProjectDescriber = describeStartupProject;
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
  await closeOwnImplicitSessions().catch(() => undefined);
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
  await closeOwnImplicitSessions().catch(() => undefined);
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
