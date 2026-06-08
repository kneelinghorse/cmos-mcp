/**
 * TemplateExporter: Export mission templates in Strict YAML format
 *
 * Exports templates using safe YAML serialization that produces
 * data-only output compatible with safe parsers.
 *
 * Features:
 * - Strict YAML output (no language-specific tags)
 * - Optional JSON export for machine-to-machine communication
 * - Metadata preservation
 * - Comment support for documentation
 *
 * @module import-export/template-exporter
 */

import * as path from 'path';
import * as YAML from 'yaml';
import { MissionTemplate, ExportOptions, ImportExportError } from './types';
import { ensureDir, runWithConcurrency, writeFileAtomic } from '../utils/fs';

/**
 * TemplateExporter handles secure export of mission templates
 */
export class TemplateExporter {
  private baseDir: string;

  /**
   * Create a new TemplateExporter
   *
   * @param baseDir - Base directory for export operations
   */
  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
  }

  /**
   * Export a mission template to a file
   *
   * @param template - Mission template to export
   * @param outputPath - Output file path (relative to baseDir)
   * @param options - Export options
   * @returns true if export succeeded
   * @throws ImportExportError if export fails
   */
  async export(
    template: MissionTemplate,
    outputPath: string,
    options?: ExportOptions
  ): Promise<boolean> {
    try {
      // Validate template structure
      this.validateTemplateForExport(template);

      // Determine format
      const format = options?.format || 'yaml';

      // Serialize template
      const content = this.serialize(template, format, options);

      // Resolve output path (ensure within baseDir)
      const resolvedPath = this.resolveOutputPath(outputPath);

      // Ensure output directory exists
      const outputDir = path.dirname(resolvedPath);
      await ensureDir(outputDir);

      // Write file atomically
      await writeFileAtomic(resolvedPath, content, { encoding: 'utf-8' });

      return true;
    } catch (error) {
      throw new ImportExportError(
        `Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'Export',
        { originalError: error }
      );
    }
  }

  /**
   * Export template to string (no file I/O)
   *
   * @param template - Mission template to export
   * @param options - Export options
   * @returns Serialized template string
   */
  exportToString(template: MissionTemplate, options?: ExportOptions): string {
    this.validateTemplateForExport(template);
    const format = options?.format || 'yaml';
    return this.serialize(template, format, options);
  }

  /**
   * Validate template has required fields for export
   *
   * @param template - Template to validate
   */
  private validateTemplateForExport(template: MissionTemplate): void {
    if (!template.apiVersion || template.apiVersion !== 'mission-template.v1') {
      throw new ImportExportError(
        'Invalid apiVersion: must be "mission-template.v1"',
        'Export Validation'
      );
    }

    if (!template.kind || template.kind !== 'MissionTemplate') {
      throw new ImportExportError('Invalid kind: must be "MissionTemplate"', 'Export Validation');
    }

    if (!template.metadata) {
      throw new ImportExportError('Missing required metadata', 'Export Validation');
    }

    if (!template.spec) {
      throw new ImportExportError('Missing required spec', 'Export Validation');
    }
  }

  /**
   * Serialize template to YAML or JSON
   *
   * @param template - Template to serialize
   * @param format - Output format
   * @param options - Export options
   * @returns Serialized string
   */
  private serialize(
    template: MissionTemplate,
    format: 'yaml' | 'json',
    options?: ExportOptions
  ): string {
    if (format === 'json') {
      return this.serializeToJSON(template, options);
    }
    return this.serializeToYAML(template, options);
  }

  /**
   * Serialize to Strict YAML format
   * Uses safe serialization - no language-specific tags
   *
   * @param template - Template to serialize
   * @param options - Export options
   * @returns YAML string
   */
  private serializeToYAML(template: MissionTemplate, options?: ExportOptions): string {
    const includeComments = options?.includeComments !== false; // Default to include comments

    // Use YAML.stringify for safe, strict serialization
    let yamlContent = YAML.stringify(template, {
      lineWidth: 120,
    });

    // Add header comment if enabled
    if (includeComments) {
      const header = this.generateHeaderComment(template);
      yamlContent = header + '\n' + yamlContent;
    }

    return yamlContent;
  }

  /**
   * Serialize to JSON format
   * Used for machine-to-machine communication
   *
   * @param template - Template to serialize
   * @param options - Export options
   * @returns JSON string
   */
  private serializeToJSON(template: MissionTemplate, options?: ExportOptions): string {
    const pretty = options?.pretty !== false; // Default to pretty

    if (pretty) {
      return JSON.stringify(template, null, 2);
    }
    return JSON.stringify(template);
  }

  /**
   * Generate header comment for YAML export
   *
   * @param template - Template to document
   * @returns Comment string
   */
  private generateHeaderComment(template: MissionTemplate): string {
    const { metadata } = template;
    const lines = [
      '# Mission Template',
      `# Name: ${metadata.name}`,
      `# Version: ${metadata.version}`,
      `# Author: ${metadata.author}`,
      '#',
      '# This template uses Strict YAML format - safe for import.',
      '# Signature verification required for import.',
    ];
    return lines.join('\n');
  }

  /**
   * Resolve output path and ensure it's within baseDir
   *
   * @param outputPath - Relative or absolute output path
   * @returns Resolved absolute path
   */
  private resolveOutputPath(outputPath: string): string {
    const resolved = path.resolve(this.baseDir, outputPath);

    // Security check: ensure resolved path is within baseDir
    const relativePath = path.relative(this.baseDir, resolved);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new ImportExportError(
        `Output path escapes base directory: ${outputPath}`,
        'Path Validation'
      );
    }

    return resolved;
  }

  /**
   * Export multiple templates
   *
   * @param templates - Templates to export
   * @param outputDir - Output directory
   * @param options - Export options
   * @returns Number of successfully exported templates
   */
  async exportMultiple(
    templates: MissionTemplate[],
    outputDir: string,
    options?: ExportOptions
  ): Promise<number> {
    const tasks = templates.map((template) => async () => {
      try {
        const filename = `${template.metadata.name}-${template.metadata.version}.${options?.format || 'yaml'}`;
        const outputPath = path.join(outputDir, filename);
        await this.export(template, outputPath, options);
        return 1;
      } catch (error) {
        console.error(
          `Failed to export ${template.metadata.name}: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
        return 0;
      }
    });

    if (tasks.length === 0) {
      return 0;
    }

    const results = await runWithConcurrency(tasks, Math.min(4, tasks.length));
    return results.reduce<number>((total, value) => total + value, 0);
  }

  /**
   * Get the base directory
   */
  getBaseDir(): string {
    return this.baseDir;
  }
}
