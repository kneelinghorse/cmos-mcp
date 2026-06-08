/**
 * Secure YAML Loader with Three-Layer Defense
 *
 * Layer 1: Path Sanitization - Prevents directory traversal attacks
 * Layer 2: Safe Parsing - Prevents code execution via YAML tags
 * Layer 3: Schema Validation - Ensures structural integrity
 *
 * @module loaders/yaml-loader
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import Ajv, { ValidateFunction } from 'ajv';
import { PathTraversalError, SchemaValidationError, UnsafeYAMLError } from '../types/errors';
import { IOError } from '../errors/io-error';
import { JSONSchema } from '../types/schemas';
import { pathExists } from '../utils/fs';

export interface SecureYAMLLoaderOptions {
  /**
   * Base directory for all file operations
   * All loaded files must be within this directory
   */
  baseDir: string;

  /**
   * Whether to follow symbolic links (default: false)
   */
  followSymlinks?: boolean;

  /**
   * Maximum file size in bytes (default: 10MB)
   */
  maxFileSize?: number;
}

/**
 * SecureYAMLLoader provides defense-in-depth for loading YAML files
 */
export class SecureYAMLLoader {
  private readonly baseDir: string;
  private readonly followSymlinks: boolean;
  private readonly maxFileSize: number;
  private ajv?: Ajv;
  private readonly schemaValidatorCache: WeakMap<JSONSchema, ValidateFunction>;

  constructor(options: SecureYAMLLoaderOptions) {
    // Normalize and resolve base directory
    this.baseDir = path.resolve(options.baseDir);
    this.followSymlinks = options.followSymlinks ?? false;
    this.maxFileSize = options.maxFileSize ?? 10 * 1024 * 1024; // 10MB default

    // Ajv is created lazily only when schema validation is requested to avoid per-call overhead
    this.schemaValidatorCache = new WeakMap();
  }

  /**
   * Layer 1: Path Sanitization
   * Prevents directory traversal attacks by ensuring the resolved path
   * is within the base directory
   *
   * @param filePath - Relative or absolute file path
   * @returns Sanitized absolute path
   * @throws PathTraversalError if path escapes base directory
   */
  sanitizePath(filePath: string): string {
    // Resolve the path relative to base directory
    const resolvedPath = path.resolve(this.baseDir, filePath);

    // Get the relative path from base to resolved
    const relativePath = path.relative(this.baseDir, resolvedPath);

    // Check if path escapes base directory
    // If it starts with '..' or is absolute, it's outside baseDir
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new PathTraversalError(filePath);
    }

    // Additional check: ensure resolved path starts with baseDir
    if (!resolvedPath.startsWith(this.baseDir + path.sep) && resolvedPath !== this.baseDir) {
      throw new PathTraversalError(filePath);
    }

    return resolvedPath;
  }

  /**
   * Layer 2: Safe YAML Parsing
   * Uses YAML.parse which is safe by default (no custom tags)
   * Prevents code execution via malicious YAML constructs
   *
   * @param content - YAML string content
   * @returns Parsed object
   * @throws UnsafeYAMLError if parsing fails or detects unsafe content
   */
  private safeParse(content: string): unknown {
    try {
      // YAML.parse is safe - it doesn't evaluate custom tags
      // Unlike js-yaml's load(), it won't execute code
      const parsed = YAML.parse(content);

      // Additional safety check: ensure no functions in parsed data
      this.validateNoFunctions(parsed);

      return parsed;
    } catch (error) {
      if (error instanceof Error) {
        throw new UnsafeYAMLError(error.message);
      }
      throw new UnsafeYAMLError('Unknown parsing error');
    }
  }

  /**
   * Recursively check for function objects in parsed data
   * This prevents any executable code from being loaded
   */
  private validateNoFunctions(obj: unknown, path: string = 'root'): void {
    if (typeof obj === 'function') {
      throw new UnsafeYAMLError(`Function detected at ${path}`);
    }

    if (obj && typeof obj === 'object') {
      for (const [key, value] of Object.entries(obj)) {
        this.validateNoFunctions(value, `${path}.${key}`);
      }
    }
  }

  /**
   * Layer 3: Schema Validation
   * Validates parsed data against a JSON Schema
   *
   * @param data - Parsed data to validate
   * @param schema - JSON Schema for validation
   * @returns Validated and typed data
   * @throws SchemaValidationError if validation fails
   */
  validateSchema<T>(data: unknown, schema: JSONSchema): T {
    const ajv = this.getAjv();
    const validate = this.getValidator(schema);
    const valid = validate(data);

    if (!valid) {
      throw new SchemaValidationError(ajv.errorsText(validate.errors), validate.errors || []);
    }

    return data as T;
  }

  /**
   * Load and parse a YAML file with all security layers
   *
   * @param filePath - Path to YAML file (relative to baseDir)
   * @param schema - Optional JSON Schema for validation
   * @returns Parsed and validated data
   * @throws PathTraversalError, UnsafeYAMLError, SchemaValidationError
   */
  async load<T = unknown>(filePath: string, schema?: JSONSchema): Promise<T> {
    // Layer 1: Sanitize path
    const sanitizedPath = this.sanitizePath(filePath);

    // Check file exists and get stats
    if (!(await pathExists(sanitizedPath))) {
      throw new IOError(`File not found: ${filePath}`, {
        code: 'IO_NOT_FOUND',
        context: {
          requestedPath: filePath,
          resolvedPath: sanitizedPath,
        },
      });
    }

    // Use lstatSync to detect symlinks (statSync follows them)
    const stats = await fs.lstat(sanitizedPath);

    // Check if symlink when not allowed
    if (stats.isSymbolicLink() && !this.followSymlinks) {
      throw new PathTraversalError(`Symbolic links not allowed: ${filePath}`);
    }

    // Check file size
    if (stats.size > this.maxFileSize) {
      throw new IOError(`File too large: ${stats.size} bytes (max: ${this.maxFileSize})`, {
        code: 'IO_SIZE_LIMIT',
        context: {
          resolvedPath: sanitizedPath,
          fileSize: stats.size,
          maxSize: this.maxFileSize,
        },
      });
    }

    // Read file content
    const content = await fs.readFile(sanitizedPath, 'utf-8');

    // Layer 2: Safe parse
    const parsed = this.safeParse(content);

    // Layer 3: Schema validation (if provided)
    if (schema) {
      return this.validateSchema<T>(parsed, schema);
    }

    return parsed as T;
  }

  /**
   * Retrieve (or compile) a validator for the supplied schema.
   * WeakMap cache ensures we only compile static schemas once.
   */
  private getAjv(): Ajv {
    if (!this.ajv) {
      this.ajv = new Ajv({ allErrors: true, strict: false });
    }
    return this.ajv;
  }

  private getValidator(schema: JSONSchema): ValidateFunction {
    const cached = this.schemaValidatorCache.get(schema);
    if (cached) {
      return cached;
    }

    const ajv = this.getAjv();
    const validator = ajv.compile(schema);
    this.schemaValidatorCache.set(schema, validator);
    return validator;
  }

  /**
   * Load multiple YAML files
   *
   * @param filePaths - Array of file paths
   * @param schema - Optional schema to validate each file
   * @returns Array of parsed data
   */
  async loadMultiple<T = unknown>(filePaths: string[], schema?: JSONSchema): Promise<T[]> {
    return Promise.all(filePaths.map((filePath) => this.load<T>(filePath, schema)));
  }

  /**
   * Get the base directory
   */
  getBaseDir(): string {
    return this.baseDir;
  }
}
