import path from 'path';
import { safeFilePath, SafeFilePathOptions } from '../validation/common';
import { SanitizationError } from '../validation/errors';

const WORKSPACE_ROOT_ENV_VARS = [
  'MISSION_PROTOCOL_WORKSPACE_ROOT',
  'MCP_WORKSPACE_ROOT',
  'WORKSPACE_ROOT',
] as const;

const WORKSPACE_ALLOWLIST_ENV_VAR = 'MISSION_PROTOCOL_WORKSPACE_ALLOWLIST';

function normalizePath(value: string): string {
  return path.resolve(value);
}

function splitAllowlist(value: string): string[] {
  return value
    .split(path.delimiter)
    .flatMap((segment) => segment.split(','))
    .flatMap((segment) => segment.split('\n'))
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function isWithinBase(targetPath: string, basePath: string): boolean {
  const normalizedBase = normalizePath(basePath);
  const normalizedTarget = normalizePath(targetPath);
  if (normalizedTarget === normalizedBase) {
    return true;
  }

  const baseWithSep = normalizedBase.endsWith(path.sep)
    ? normalizedBase
    : `${normalizedBase}${path.sep}`;
  return normalizedTarget.startsWith(baseWithSep);
}

function uniqueAllowlist(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const entry of entries) {
    const normalized = normalizePath(entry);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      ordered.push(normalized);
    }
  }

  return ordered;
}

export function getWorkspaceRoot(): string {
  for (const envVar of WORKSPACE_ROOT_ENV_VARS) {
    const value = process.env[envVar];
    if (value && value.trim().length > 0) {
      return normalizePath(value);
    }
  }

  return process.cwd();
}

export function getWorkspaceAllowlist(): string[] {
  const envValue = process.env[WORKSPACE_ALLOWLIST_ENV_VAR];
  const candidates = envValue ? splitAllowlist(envValue) : [];
  const normalized = uniqueAllowlist(candidates);

  if (normalized.length === 0) {
    return [getWorkspaceRoot()];
  }

  return normalized;
}

function ensureBaseInAllowlist(baseDir: string, allowlist: readonly string[]): string {
  const normalizedBase = normalizePath(baseDir);

  const allowed = allowlist.some((entry) => isWithinBase(normalizedBase, entry));
  if (!allowed) {
    throw new SanitizationError('Base directory is not within the configured workspace allowlist', {
      data: {
        baseDir: normalizedBase,
        allowlist,
      },
    });
  }

  return normalizedBase;
}

export interface WorkspacePathOptions extends SafeFilePathOptions {
  readonly allowRelative?: boolean;
  readonly baseDir?: string;
}

export async function resolveWorkspacePath(
  inputPath: string,
  options: WorkspacePathOptions = {}
): Promise<string> {
  const allowlist = getWorkspaceAllowlist();
  const candidateBases = options.baseDir
    ? [ensureBaseInAllowlist(options.baseDir, allowlist)]
    : allowlist;

  let lastError: unknown;

  for (const base of candidateBases) {
    try {
      return await safeFilePath(inputPath, {
        ...options,
        baseDir: base,
      });
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new SanitizationError('Path is not within allowed workspace directories', {
    data: {
      path: inputPath,
      allowlist,
    },
  });
}

export function isPathWithinWorkspace(targetPath: string): boolean {
  const allowlist = getWorkspaceAllowlist();
  const normalizedTarget = normalizePath(targetPath);
  return allowlist.some((entry) => isWithinBase(normalizedTarget, entry));
}
