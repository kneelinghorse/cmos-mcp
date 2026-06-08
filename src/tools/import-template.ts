/**
 * MCP Tool: import_template
 *
 * Exposes the secure template import functionality as an MCP tool
 * for use in Claude Desktop and other MCP-compatible environments.
 *
 * Implements the 6-layer security validation pipeline from R3.2.
 */

import path from 'path';
import { z } from 'zod';
import { TemplateImporter, ImportResult } from '../import-export/template-importer';
import { ImportOptions, SemanticValidationRules } from '../import-export/types';
import { safeFilePath } from '../validation/common';
import { validateAndSanitize } from '../validation/middleware';
import { createFilePathSchema } from '../validation/schemas/file-path-schema';
import { ValidationError as InputValidationError } from '../validation/errors';

/**
 * MCP Tool Interface for Template Import
 */
export interface ImportTemplateParams {
  /** Path to the template file to import */
  templatePath: string;

  /** Optional: Base directory for import operations (defaults to current directory) */
  baseDir?: string;

  /** Optional: Skip signature verification (for testing only, NOT for production) */
  skipSignatureVerification?: boolean;

  /** Optional: Trust level (verified-internal, signed-known, untrusted) */
  trustLevel?: 'verified-internal' | 'signed-known' | 'untrusted';

  /** Optional: Maximum resource memory in MB */
  maxResourceMemory?: number;

  /** Optional: Maximum resource CPU cores */
  maxResourceCpu?: number;

  /** Optional: Allowed actions (if empty, all actions allowed) */
  allowedActions?: string[];

  /** Optional: URL allowlist for dependencies */
  urlAllowlist?: string[];
}

/**
 * Result returned by import_template tool
 */
export interface ImportTemplateResult {
  success: boolean;
  template?: {
    name: string;
    version: string;
    author: string;
    apiVersion: string;
    spec: unknown;
  };
  validationReport: {
    valid: boolean;
    performanceMs: number;
    layers: Array<{
      layer: string;
      passed: boolean;
      message?: string;
    }>;
    errors: string[];
    warnings: string[];
  };
  dependencies?: {
    [name: string]: {
      name: string;
      version: string;
    };
  };
  message: string;
}

/**
 * Main entry point for the import_template MCP tool
 */
export async function importTemplate(params: ImportTemplateParams): Promise<ImportTemplateResult> {
  try {
    const validated = await validateParams(params);

    // Determine base directory
    const baseDir = validated.baseDir
      ? await safeFilePath(path.resolve(validated.baseDir), { allowRelative: false })
      : process.cwd();

    // Build semantic validation rules
    const semanticRules: SemanticValidationRules = {
      maxResourceMemory: validated.maxResourceMemory,
      maxResourceCpu: validated.maxResourceCpu,
      allowedActions: validated.allowedActions ?? [],
      urlAllowlist: validated.urlAllowlist ?? [],
    };

    // Build import options
    const options: ImportOptions = {
      skipSignatureVerification: validated.skipSignatureVerification || false,
      semanticRules,
      trustLevel: validated.trustLevel,
    };

    // Create importer
    const importer = new TemplateImporter(baseDir, options);

    // Execute import with full 6-layer validation
    const sanitizedPath = await safeFilePath(validated.templatePath, {
      allowRelative: true,
      maxLength: 2048,
      allowedExtensions: ['.yaml', '.yml'],
    });

    const result: ImportResult = await importer.import(sanitizedPath, options);

    // Convert dependencies map to object for JSON serialization
    const dependencies: { [name: string]: { name: string; version: string } } = {};
    result.resolvedDependencies.forEach((template, name) => {
      dependencies[name] = {
        name: template.metadata.name,
        version: template.metadata.version,
      };
    });

    // Build success response
    return {
      success: true,
      template: {
        name: result.template.metadata.name,
        version: result.template.metadata.version,
        author: result.template.metadata.author,
        apiVersion: result.template.apiVersion,
        spec: result.template.spec,
      },
      validationReport: {
        valid: result.validationReport.valid,
        performanceMs: result.validationReport.performanceMs,
        layers: result.validationReport.layers,
        errors: result.validationReport.errors,
        warnings: result.validationReport.warnings,
      },
      dependencies: Object.keys(dependencies).length > 0 ? dependencies : undefined,
      message: `Template "${result.template.metadata.name}" v${result.template.metadata.version} imported successfully in ${result.validationReport.performanceMs}ms`,
    };
  } catch (error) {
    if (error instanceof InputValidationError) {
      const maybeMessages = error.data?.messages;
      const dataMessages = Array.isArray(maybeMessages)
        ? maybeMessages.filter((message): message is string => typeof message === 'string')
        : undefined;
      const detailMessages =
        dataMessages && dataMessages.length > 0
          ? dataMessages
          : error.issues?.map((issue) => issue.message).filter(Boolean);
      const detail =
        detailMessages && detailMessages.length > 0 ? detailMessages[0] : error.message;

      const errorsList = detailMessages && detailMessages.length > 0 ? detailMessages : [detail];

      return {
        success: false,
        validationReport: {
          valid: false,
          performanceMs: 0,
          layers: [],
          errors: errorsList,
          warnings: [],
        },
        message: `Import failed: ${detail}`,
      };
    }

    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      success: false,
      validationReport: {
        valid: false,
        performanceMs: 0,
        layers: [],
        errors: [errorMessage],
        warnings: [],
      },
      message: `Import failed: ${errorMessage}`,
    };
  }
}

/**
 * Validate input parameters
 */
const ImportTemplateParamsSchema = z
  .object({
    templatePath: createFilePathSchema({
      allowRelative: true,
      allowedExtensions: ['.yaml', '.yml'],
    }),
    baseDir: createFilePathSchema({ allowRelative: true }).optional(),
    skipSignatureVerification: z.boolean().optional(),
    trustLevel: z.enum(['verified-internal', 'signed-known', 'untrusted']).optional(),
    maxResourceMemory: z.number().int().positive().max(32_768).optional(),
    maxResourceCpu: z.number().int().positive().max(128).optional(),
    allowedActions: z.array(z.string().min(1).max(128)).max(128).optional(),
    urlAllowlist: z.array(z.string().url()).max(128).optional(),
  })
  .strict();

type ValidatedImportTemplateParams = z.infer<typeof ImportTemplateParamsSchema>;

async function validateParams(
  params: ImportTemplateParams
): Promise<ValidatedImportTemplateParams> {
  const validated = await validateAndSanitize(params, ImportTemplateParamsSchema);

  if (validated.skipSignatureVerification) {
    console.warn('⚠️  WARNING: Signature verification is DISABLED. Only use this for testing!');
  }

  return validated;
}

/**
 * MCP Tool Registration
 * Canonical specification for template import
 */
export const createTemplateImportToolDefinition = {
  name: 'create_template_import',
  description:
    'Securely import a mission template with 6-layer security validation (path sanitization, safe parsing, schema validation, signature verification, semantic validation, dependency resolution)',
  inputSchema: {
    type: 'object',
    properties: {
      templatePath: {
        type: 'string',
        description: 'Path to the template file to import (YAML format)',
      },
      baseDir: {
        type: 'string',
        description:
          'Base directory for import operations (optional, defaults to current directory)',
      },
      skipSignatureVerification: {
        type: 'boolean',
        description: 'Skip signature verification (TESTING ONLY - NOT for production use)',
      },
      trustLevel: {
        type: 'string',
        enum: ['verified-internal', 'signed-known', 'untrusted'],
        description:
          'Trust level for the template: verified-internal (core team), signed-known (known author), untrusted (requires approval)',
      },
      maxResourceMemory: {
        type: 'number',
        description: 'Maximum allowed memory resource in MB (optional)',
      },
      maxResourceCpu: {
        type: 'number',
        description: 'Maximum allowed CPU cores (optional)',
      },
      allowedActions: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of allowed actions in the template (optional, empty means all allowed)',
      },
      urlAllowlist: {
        type: 'array',
        items: { type: 'string' },
        description:
          'List of allowed URL domains for dependencies (optional, empty means deny all)',
      },
    },
    required: ['templatePath'],
  },
} as const;

/**
 * Legacy alias maintained for one release cycle
 */
export const importTemplateToolDefinitionDeprecated = {
  ...createTemplateImportToolDefinition,
  name: 'import_template',
  description:
    '[DEPRECATED] Use create_template_import instead. Provides the same secure template import workflow.',
} as const;
