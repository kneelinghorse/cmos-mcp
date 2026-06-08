import { promises as fs } from 'fs';
import path from 'path';
import YAML from 'yaml';
import { z } from 'zod';
import { SanitizationError, SchemaError, normalizeValidationError } from './errors';

const DEFAULT_MAX_PATH_LENGTH = 4096;
const DEFAULT_MAX_CONTENT_SIZE = 1024 * 1024; // 1MB

const pathStringSchema = z
  .string({
    required_error: 'Path value is required',
    invalid_type_error: 'Path must be a string',
  })
  .min(1, 'Path cannot be empty')
  .max(DEFAULT_MAX_PATH_LENGTH, 'Path is too long')
  .refine((value) => !value.includes('\0'), {
    message: 'Path cannot contain null bytes',
  });

const missionIdStringSchema = z
  .string({
    required_error: 'Mission ID is required',
    invalid_type_error: 'Mission ID must be a string',
  })
  .min(3)
  .max(64)
  .regex(/^M\d{2}(?:-[A-Za-z0-9]+)*$/, 'Mission ID must follow format M##(-segment)*');

const domainNameStringSchema = z
  .string({
    required_error: 'Domain name is required',
    invalid_type_error: 'Domain name must be a string',
  })
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z0-9-]+$/, 'Domain name must be lowercase alphanumeric with hyphens');

export interface SafeFilePathOptions {
  readonly baseDir?: string;
  readonly allowRelative?: boolean;
  readonly allowedExtensions?: readonly string[];
  readonly maxLength?: number;
  readonly allowSymbolicLinks?: boolean;
}

function ensureAllowedExtension(filePath: string, allowed?: readonly string[]): void {
  if (!allowed || allowed.length === 0) {
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const normalizedList = allowed.map((value) =>
    value.startsWith('.') ? value.toLowerCase() : `.${value.toLowerCase()}`
  );

  if (!normalizedList.includes(ext)) {
    throw new SanitizationError('File extension is not permitted', {
      data: { filePath, allowedExtensions: normalizedList },
    });
  }
}

function ensureWithinBaseDir(resolvedPath: string, baseDir: string): void {
  const normalizedBase = path.resolve(baseDir);
  const normalizedPath = path.resolve(resolvedPath);

  const baseWithSep = normalizedBase.endsWith(path.sep)
    ? normalizedBase
    : `${normalizedBase}${path.sep}`;
  const isWithin = normalizedPath === normalizedBase || normalizedPath.startsWith(baseWithSep);

  if (!isWithin) {
    throw new SanitizationError('Path escapes allowed base directory', {
      data: { resolvedPath, baseDir: normalizedBase },
    });
  }
}

async function tryRealpath(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return null;
    }
    throw new SanitizationError('Unable to resolve real path', {
      cause: error,
      data: { path: target },
    });
  }
}

function isWithinBase(actualPath: string, basePath: string): boolean {
  const normalizedBase = basePath.endsWith(path.sep) ? basePath : `${basePath}${path.sep}`;
  return actualPath === basePath || actualPath.startsWith(normalizedBase);
}

async function findExistingAncestor(target: string): Promise<string | null> {
  let current = target;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const real = await tryRealpath(current);
    if (real) {
      return real;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function ensureNoSymlinkEscape(
  sanitizedPath: string,
  options: SafeFilePathOptions
): Promise<void> {
  if (!options.baseDir || options.allowSymbolicLinks) {
    return;
  }

  const realBase = (await tryRealpath(options.baseDir)) ?? path.resolve(options.baseDir);
  const targetReal = await tryRealpath(sanitizedPath);

  if (targetReal) {
    if (!isWithinBase(targetReal, realBase)) {
      throw new SanitizationError('Path escapes allowed base directory via symlink resolution', {
        data: { resolvedPath: targetReal, baseDir: realBase },
      });
    }

    try {
      const stats = await fs.lstat(sanitizedPath);
      if (stats.isSymbolicLink() && !options.allowSymbolicLinks) {
        throw new SanitizationError(
          'Symbolic links are not permitted for paths within base directory',
          {
            data: { path: sanitizedPath },
          }
        );
      }
    } catch (error) {
      throw new SanitizationError('Unable to inspect filesystem entry for symbolic links', {
        cause: error,
        data: { path: sanitizedPath },
      });
    }
    return;
  }

  const ancestorReal = await findExistingAncestor(sanitizedPath);
  if (ancestorReal && !isWithinBase(ancestorReal, realBase)) {
    throw new SanitizationError('Path escapes allowed base directory via unresolved symlink', {
      data: { resolvedPath: ancestorReal, baseDir: realBase },
    });
  }
}

export async function safeFilePath(
  rawPath: string,
  options: SafeFilePathOptions = {}
): Promise<string> {
  const maxLength = options.maxLength ?? DEFAULT_MAX_PATH_LENGTH;
  const parsedPath = pathStringSchema.parse(rawPath);

  if (parsedPath.length > maxLength) {
    throw new SanitizationError(`Path must be <= ${maxLength} characters`, {
      data: { path: parsedPath, maxLength },
    });
  }

  const normalized = path.normalize(parsedPath);

  const segments = normalized.split(path.sep).filter(Boolean);
  if (segments.some((segment) => segment === '..')) {
    throw new SanitizationError('Path cannot contain parent directory traversals', {
      data: { path: parsedPath },
    });
  }

  const isAbsolute = path.isAbsolute(normalized);
  const allowRelative = options.allowRelative ?? true;
  if (!allowRelative && !isAbsolute) {
    throw new SanitizationError('Path must be absolute', { data: { path: parsedPath } });
  }

  let sanitizedPath = normalized;

  if (options.baseDir) {
    sanitizedPath = isAbsolute ? normalized : path.resolve(options.baseDir, normalized);
    ensureWithinBaseDir(sanitizedPath, options.baseDir);
    await ensureNoSymlinkEscape(sanitizedPath, options);
  }

  ensureAllowedExtension(sanitizedPath, options.allowedExtensions);

  return sanitizedPath;
}

export function missionId(value: string): string {
  return missionIdStringSchema.parse(value);
}

export function domainName(value: string): string {
  return domainNameStringSchema.parse(value);
}

export interface StructuredContentOptions<T extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly schema?: T;
  readonly maxSize?: number;
}

export function yamlContent<TOutput = unknown, TSchema extends z.ZodTypeAny = z.ZodTypeAny>(
  rawContent: string,
  options: StructuredContentOptions<TSchema> = {}
): TOutput {
  const contentSchema = z
    .string({
      required_error: 'YAML content is required',
      invalid_type_error: 'YAML content must be a string',
    })
    .min(1, 'YAML content cannot be empty')
    .max(options.maxSize ?? DEFAULT_MAX_CONTENT_SIZE, 'YAML content exceeds maximum allowed size')
    .refine((value) => !value.includes('\0'), 'Content cannot contain null bytes');

  const sanitized = contentSchema.parse(rawContent);

  try {
    const parsed = YAML.parse(sanitized);
    if (options.schema) {
      const result = options.schema.parse(parsed);
      return result as TOutput;
    }
    return parsed as TOutput;
  } catch (error) {
    throw new SchemaError('Failed to parse YAML content', {
      cause: error,
      data: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

export function jsonContent<TOutput = unknown, TSchema extends z.ZodTypeAny = z.ZodTypeAny>(
  rawContent: string,
  options: StructuredContentOptions<TSchema> = {}
): TOutput {
  const contentSchema = z
    .string({
      required_error: 'JSON content is required',
      invalid_type_error: 'JSON content must be a string',
    })
    .min(2, 'JSON content cannot be empty')
    .max(options.maxSize ?? DEFAULT_MAX_CONTENT_SIZE, 'JSON content exceeds maximum allowed size');

  const sanitized = contentSchema.parse(rawContent);

  try {
    const parsed = JSON.parse(sanitized);
    if (options.schema) {
      const result = options.schema.parse(parsed);
      return result as TOutput;
    }
    return parsed as TOutput;
  } catch (error) {
    throw new SchemaError('Failed to parse JSON content', {
      cause: error,
      data: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

export const MissionIdSchema = missionIdStringSchema;
export const DomainNameSchema = domainNameStringSchema;

export const FilePathSchema = z
  .string()
  .transform(async (value, ctx) => {
    try {
      return await safeFilePath(value, { allowRelative: true });
    } catch (error) {
      const normalized = normalizeValidationError(error);
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: normalized.message,
      });
      return z.NEVER;
    }
  })
  .brand<'FilePath'>();
