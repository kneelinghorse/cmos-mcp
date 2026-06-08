/**
 * MCP Tool: export_template
 *
 * Exposes the template export functionality as an MCP tool
 * for use in Claude Desktop and other MCP-compatible environments.
 *
 * Exports templates in Strict YAML format (safe for import).
 */

import path from 'path';
import { z } from 'zod';
import { ValidationError } from '../errors/validation-error';
import { ErrorHandler } from '../errors/handler';
import { TemplateExporter } from '../import-export/template-exporter';
import { ExportOptions, MissionTemplate } from '../import-export/types';
import { safeFilePath } from '../validation/common';
import { validateAndSanitize } from '../validation/middleware';
import { createFilePathSchema } from '../validation/schemas/file-path-schema';
import { MissionTemplateSchema } from '../validation/schemas/template-schema';
import { ValidationError as InputValidationError } from '../validation/errors';

/**
 * MCP Tool Interface for Template Export
 */
export interface ExportTemplateParams {
  /** Template object to export (must conform to mission-template.v1 schema) */
  template: MissionTemplate;

  /** Output file path (relative to baseDir) */
  outputPath: string;

  /** Optional: Base directory for export operations (defaults to current directory) */
  baseDir?: string;

  /** Optional: Export format (yaml or json, defaults to yaml) */
  format?: 'yaml' | 'json';

  /** Optional: Include header comments (defaults to true for YAML) */
  includeComments?: boolean;

  /** Optional: Pretty print output (defaults to true) */
  pretty?: boolean;
}

/**
 * Result returned by export_template tool
 */
export interface ExportTemplateResult {
  success: boolean;
  outputPath?: string;
  format?: string;
  message: string;
  preview?: string; // First 500 chars of exported content
}

/**
 * Main entry point for the export_template MCP tool
 */
export async function exportTemplate(params: ExportTemplateParams): Promise<ExportTemplateResult> {
  let contextData = {
    outputPath: params.outputPath,
    format: params.format ?? 'yaml',
    templateName: params.template?.metadata?.name,
    templateVersion: params.template?.metadata?.version,
  };

  try {
    const validated = await validateParams(params);
    contextData = {
      outputPath: validated.outputPath,
      format: validated.format ?? 'yaml',
      templateName: validated.template.metadata.name,
      templateVersion: validated.template.metadata.version,
    };

    // Determine base directory
    const baseDir = validated.baseDir
      ? await safeFilePath(path.resolve(validated.baseDir), { allowRelative: false })
      : process.cwd();

    // Build export options
    const options: ExportOptions = {
      format: validated.format ?? 'yaml',
      includeComments: validated.includeComments !== false, // Default true
      pretty: validated.pretty !== false, // Default true
    };

    // Create exporter
    const exporter = new TemplateExporter(baseDir);

    const allowedExtensions = options.format === 'json' ? ['.json'] : ['.yaml', '.yml'];
    const sanitizedOutputPath = await safeFilePath(validated.outputPath, {
      allowRelative: true,
      allowedExtensions,
    });

    // Execute export
    const success = await exporter.export(validated.template, sanitizedOutputPath, options);

    if (!success) {
      throw new ValidationError('Export operation failed', {
        context: contextData,
      });
    }

    // Generate preview
    const content = exporter.exportToString(validated.template, options);
    const preview = content.slice(0, 500) + (content.length > 500 ? '...' : '');

    // Resolve output path for display
    const resolvedPath = path.resolve(baseDir, sanitizedOutputPath);

    return {
      success: true,
      outputPath: resolvedPath,
      format: options.format,
      message: `Template "${validated.template.metadata.name}" v${validated.template.metadata.version} exported successfully to ${resolvedPath}`,
      preview,
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
      return {
        success: false,
        message: `Export failed: ${detail}`,
      };
    }

    const missionError = ErrorHandler.handle(
      error,
      'tools.get_template_export.execute',
      {
        module: 'tools/export-template',
        data: contextData,
      },
      {
        rethrow: false,
      }
    );
    const publicError = ErrorHandler.toPublicError(missionError);
    const baseMessage =
      missionError.category === 'validation'
        ? missionError.message
        : publicError.message || 'Template export failed.';
    const message = publicError.correlationId
      ? `${baseMessage} (correlationId=${publicError.correlationId})`
      : baseMessage;
    return {
      success: false,
      message: `Export failed: ${message}`,
    };
  }
}

/**
 * Validate input parameters
 */
const ExportTemplateParamsSchema = z
  .object({
    template: MissionTemplateSchema,
    outputPath: createFilePathSchema({ allowRelative: true }),
    baseDir: createFilePathSchema({ allowRelative: true }).optional(),
    format: z.enum(['yaml', 'json']).optional(),
    includeComments: z.boolean().optional(),
    pretty: z.boolean().optional(),
  })
  .strict();

type ValidatedExportTemplateParams = z.infer<typeof ExportTemplateParamsSchema>;

async function validateParams(
  params: ExportTemplateParams
): Promise<ValidatedExportTemplateParams> {
  return validateAndSanitize(params, ExportTemplateParamsSchema);
}

/**
 * Helper function to create a template from mission data
 * Useful for converting existing mission files to templates
 */
export function createTemplateFromMission(
  missionData: Record<string, unknown>,
  metadata: {
    name: string;
    version: string;
    author: string;
    signature: {
      keyId: string;
      algorithm: string;
      value: string;
    };
  }
): MissionTemplate {
  return {
    apiVersion: 'mission-template.v1',
    kind: 'MissionTemplate',
    metadata,
    spec: missionData,
    dependencies: [],
  };
}

/**
 * MCP Tool Registration
 * This would be called by the MCP server to register the tool
 */
export const getTemplateExportToolDefinition = {
  name: 'get_template_export',
  description:
    'Export a mission template to Strict YAML or JSON format. Uses safe serialization with no language-specific tags.',
  inputSchema: {
    type: 'object',
    properties: {
      template: {
        type: 'object',
        description: 'Mission template object conforming to mission-template.v1 schema',
        required: ['apiVersion', 'kind', 'metadata', 'spec'],
        properties: {
          apiVersion: {
            type: 'string',
            const: 'mission-template.v1',
          },
          kind: {
            type: 'string',
            const: 'MissionTemplate',
          },
          metadata: {
            type: 'object',
            description: 'Template metadata including name, version, author, and signature',
          },
          spec: {
            type: 'object',
            description: 'Mission specification (business logic)',
          },
          dependencies: {
            type: 'array',
            description: 'Optional array of template dependencies',
          },
        },
      },
      outputPath: {
        type: 'string',
        description: 'Output file path (relative to baseDir)',
      },
      baseDir: {
        type: 'string',
        description:
          'Base directory for export operations (optional, defaults to current directory)',
      },
      format: {
        type: 'string',
        enum: ['yaml', 'json'],
        description: 'Export format: yaml (default) or json',
      },
      includeComments: {
        type: 'boolean',
        description: 'Include header comments in YAML output (default: true)',
      },
      pretty: {
        type: 'boolean',
        description: 'Pretty print output (default: true)',
      },
    },
    required: ['template', 'outputPath'],
  },
} as const;

export const exportTemplateToolDefinitionDeprecated = {
  ...getTemplateExportToolDefinition,
  name: 'export_template',
  description:
    '[DEPRECATED] Use get_template_export instead. Provides the same strict serialization workflow.',
} as const;
