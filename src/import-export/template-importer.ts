/**
 * TemplateImporter: Secure mission template import with 6-layer validation
 *
 * Implements the complete validation pipeline from R3.2:
 * 1. Path Sanitization (via SecureYAMLLoader)
 * 2. Safe Parsing (via SecureYAMLLoader)
 * 3. Schema Validation (via SecureYAMLLoader)
 * 4. Signature Verification (via SecurityValidator)
 * 5. Semantic Validation (via SecurityValidator)
 * 6. Dependency Resolution (recursive validation)
 *
 * @module import-export/template-importer
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { SecureYAMLLoader } from '../loaders/yaml-loader';
import { SecurityValidator } from './security-validator';
import {
  MissionTemplate,
  ImportOptions,
  SecurityValidationReport,
  TemplateDependency,
  ImportExportError,
  DependencyResolutionError,
} from './types';
import { pathExists, removeFile, writeFileAtomic } from '../utils/fs';
import { loadHybridTemplate, HybridMissionTemplate } from './hybrid-template-parser';

/**
 * Result of a successful import operation
 */
export interface ImportResult {
  template: MissionTemplate;
  validationReport: SecurityValidationReport;
  resolvedDependencies: Map<string, MissionTemplate>;
}

/**
 * TemplateImporter handles secure import of mission templates
 */
export class TemplateImporter {
  private yamlLoader: SecureYAMLLoader;
  private validator: SecurityValidator;
  private baseDir: string;
  private readonly maxFileSize: number;

  /**
   * Create a new TemplateImporter
   *
   * @param baseDir - Base directory for template operations
   * @param options - Import options
   */
  constructor(baseDir: string, options?: ImportOptions) {
    this.baseDir = path.resolve(baseDir);
    this.maxFileSize = 100 * 1024; // 100KB

    // Initialize SecureYAMLLoader (Layers 1-3)
    this.yamlLoader = new SecureYAMLLoader({
      baseDir: this.baseDir,
      followSymlinks: false,
      maxFileSize: this.maxFileSize,
    });

    // Initialize SecurityValidator (Layers 4-6)
    this.validator = new SecurityValidator(options?.semanticRules);
  }

  /**
   * Import a mission template from a file path
   * Executes the complete 6-layer validation pipeline
   *
   * @param templatePath - Path to template file (relative to baseDir)
   * @param options - Import options
   * @returns Import result with validated template and dependencies
   * @throws ImportExportError if validation fails at any layer
   */
  async import(templatePath: string, options?: ImportOptions): Promise<ImportResult> {
    const startTime = Date.now();

    try {
      // Step 1-3: Load with path sanitization, safe parsing, and schema validation
      const parsed = await this.loadAndValidateStructure(templatePath);

      // Step 4-6: Security validation (signature, semantics, dependencies)
      const validationReport = await this.validator.validate(
        parsed,
        options?.skipSignatureVerification || false
      );

      // Check if validation passed
      if (!validationReport.valid) {
        throw new ImportExportError(
          `Template validation failed: ${validationReport.errors.join('; ')}`,
          undefined,
          { report: validationReport }
        );
      }

      const template = validationReport.template!;

      // Step 7: Resolve dependencies (recursive validation)
      const resolvedDependencies = await this.resolveDependencies(
        template.dependencies || [],
        options
      );

      const totalTime = Date.now() - startTime;

      // Check performance target (<1 second for typical templates)
      if (totalTime > 1000) {
        console.warn(
          `Import performance warning: ${totalTime}ms exceeds target of 1000ms for ${templatePath}`
        );
      }

      return {
        template,
        validationReport,
        resolvedDependencies,
      };
    } catch (error) {
      if (error instanceof ImportExportError) {
        throw error;
      }
      throw new ImportExportError(
        `Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        undefined,
        { originalError: error }
      );
    }
  }

  /**
   * Layers 1-3: Load template with secure YAML loader
   * Handles path sanitization, safe parsing, and schema validation
   *
   * @param templatePath - Path to template file
   * @returns Parsed template object
   */
  private async loadAndValidateStructure(templatePath: string): Promise<MissionTemplate> {
    const extension = path.extname(templatePath).toLowerCase();
    if (extension === '.xml') {
      return this.loadHybridStructure(templatePath);
    }
    return this.loadYamlStructure(templatePath);
  }

  private async loadYamlStructure(templatePath: string): Promise<MissionTemplate> {
    try {
      // Load with SecureYAMLLoader (Layers 1-3)
      const schema = SecurityValidator.getSchema();
      const parsed = await this.yamlLoader.load<MissionTemplate>(templatePath, schema);

      return parsed;
    } catch (error) {
      throw new ImportExportError(
        `Failed to load template structure: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'Layers 1-3',
        { originalError: error }
      );
    }
  }

  private async loadHybridStructure(templatePath: string): Promise<MissionTemplate> {
    try {
      const sanitizedPath = this.yamlLoader.sanitizePath(templatePath);

      if (!(await pathExists(sanitizedPath))) {
        throw new ImportExportError(`File not found: ${templatePath}`, 'Layers 1-3');
      }

      const stats = await fs.lstat(sanitizedPath);
      if (stats.isSymbolicLink()) {
        throw new ImportExportError(`Symbolic links not allowed: ${templatePath}`, 'Layers 1-3');
      }

      if (stats.size > this.maxFileSize) {
        throw new ImportExportError(
          `File too large: ${stats.size} bytes (max: ${this.maxFileSize})`,
          'Layers 1-3'
        );
      }

      const result = await loadHybridTemplate(sanitizedPath, {
        componentBaseDir: path.dirname(sanitizedPath),
        resolveComponents: true,
      });

      if (!result.valid || !result.template) {
        const details = result.errors.join('; ') || 'Unknown hybrid template error';
        throw new ImportExportError(`Hybrid template validation failed: ${details}`, 'Layers 1-3', {
          errors: result.errors,
        });
      }

      return this.convertHybridToMissionTemplate(result.template, templatePath);
    } catch (error) {
      if (error instanceof ImportExportError) {
        throw error;
      }
      throw new ImportExportError(
        `Failed to load hybrid template: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'Layers 1-3',
        { originalError: error }
      );
    }
  }

  private convertHybridToMissionTemplate(
    template: HybridMissionTemplate,
    templatePath: string
  ): MissionTemplate {
    const metadata = {
      name: template.metadata.name,
      version: template.metadata.version,
      author: template.metadata.author,
      signature: template.metadata.signature,
    } as MissionTemplate['metadata'];

    if (template.metadata.tags && template.metadata.tags.length > 0) {
      metadata.tags = [...template.metadata.tags];
    }

    return {
      apiVersion: template.apiVersion,
      kind: template.kind,
      metadata,
      spec: {
        format: 'hybrid',
        objective: template.objective,
        agentPersona: template.agentPersona,
        instructions: template.instructions,
        context: template.context,
        examples: template.examples,
        outputSchema: template.outputSchema,
        source: {
          path: templatePath,
        },
      },
    };
  }

  /**
   * Layer 6: Resolve and validate dependencies
   * Each dependency is recursively validated through the full pipeline
   *
   * @param dependencies - Array of dependency declarations
   * @param options - Import options
   * @returns Map of dependency name to resolved template
   */
  /* istanbul ignore next */
  private async resolveDependencies(
    dependencies: TemplateDependency[],
    options?: ImportOptions
  ): Promise<Map<string, MissionTemplate>> {
    const resolved = new Map<string, MissionTemplate>();

    if (dependencies.length === 0) {
      return resolved;
    }

    // Process dependencies sequentially (could be parallelized in production)
    for (const dep of dependencies) {
      try {
        // Fetch dependency (simplified - in production would handle URLs)
        const depTemplate = await this.fetchDependency(dep);

        // Verify checksum
        this.verifyDependencyChecksum(depTemplate, dep.checksum);

        // Recursively validate dependency through full pipeline
        const depResult = await this.import(dep.sourceUrl, options);

        resolved.set(dep.name, depResult.template);
      } catch (error) {
        throw new DependencyResolutionError(
          `Failed to resolve dependency ${dep.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          { dependency: dep, originalError: error }
        );
      }
    }

    return resolved;
  }

  /**
   * Fetch a dependency from its source URL
   * In Phase 1, this only supports local file paths
   * Future: Support HTTPS URLs with allowlist enforcement
   *
   * @param dependency - Dependency specification
   * @returns Fetched template
   */
  /* istanbul ignore next */
  private async fetchDependency(dependency: TemplateDependency): Promise<string> {
    try {
      // For now, treat sourceUrl as a local file path
      // In production, this would:
      // 1. Check URL against allowlist
      // 2. Use HTTPS to fetch from approved domains
      // 3. Implement retry logic and timeout
      const url = new URL(dependency.sourceUrl);

      if (url.protocol === 'file:') {
        const filePath = url.pathname;
        const sanitizedPath = this.yamlLoader.sanitizePath(filePath);
        return await fs.readFile(sanitizedPath, 'utf-8');
      }

      throw new DependencyResolutionError(
        `Unsupported protocol: ${url.protocol}. Only file:// is supported in Phase 1.`,
        { dependency }
      );
    } catch (error) {
      throw new DependencyResolutionError(
        `Failed to fetch dependency: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { dependency, originalError: error }
      );
    }
  }

  /**
   * Verify dependency checksum for integrity
   *
   * @param content - Dependency content
   * @param expectedChecksum - Expected SHA-256 checksum (format: "sha256:hash")
   */
  /* istanbul ignore next */
  private verifyDependencyChecksum(content: string, expectedChecksum: string): void {
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const actualChecksum = `sha256:${hash}`;

    if (actualChecksum !== expectedChecksum) {
      throw new DependencyResolutionError(
        `Checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`,
        { expectedChecksum, actualChecksum }
      );
    }
  }

  /**
   * Import from raw YAML string (for testing)
   *
   * @param yamlContent - YAML content string
   * @param options - Import options
   * @returns Import result
   */
  async importFromString(yamlContent: string, options?: ImportOptions): Promise<ImportResult> {
    // Write to temporary file and import
    const tempFile = path.join(this.baseDir, `.temp-${Date.now()}.yaml`);
    try {
      await writeFileAtomic(tempFile, yamlContent, { encoding: 'utf-8' });
      return await this.import(path.basename(tempFile), options);
    } finally {
      // Clean up temp file
      if (await pathExists(tempFile)) {
        await removeFile(tempFile);
      }
    }
  }

  /**
   * Get the base directory
   */
  getBaseDir(): string {
    return this.baseDir;
  }
}
