/**
 * Types for the secure template import/export system
 * Implements the 6-layer security architecture from R3.2
 */

/**
 * Template metadata structure
 */
export interface TemplateMetadata {
  name: string;
  version: string;
  author: string;
  signature: TemplateSignature;
  tags?: string[];
}

/**
 * Digital signature for template verification (Layer 4)
 */
export interface TemplateSignature {
  keyId: string;
  algorithm: string; // e.g., 'PGP-SHA256', 'RS256'
  value: string; // Base64-encoded signature
}

/**
 * Template dependency specification (Layer 6)
 */
export interface TemplateDependency {
  name: string;
  sourceUrl: string;
  version: string;
  checksum: string; // SHA-256 checksum
}

export interface StructuredPromptingBlock {
  enabled: boolean;
  role: string;
  context: string;
  task: string;
  format: string;
  constraints: string;
}

export interface TemplateSpec {
  structured_prompting?: StructuredPromptingBlock;
  [key: string]: unknown;
}

/**
 * Complete mission template structure
 */
export interface MissionTemplate {
  apiVersion: string;
  kind: string;
  metadata: TemplateMetadata;
  spec: TemplateSpec;
  dependencies?: TemplateDependency[];
}

/**
 * Validation result for each security layer
 */
export interface ValidationResult {
  layer: string;
  passed: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Complete validation report
 */
export interface SecurityValidationReport {
  valid: boolean;
  layers: ValidationResult[];
  template?: MissionTemplate;
  errors: string[];
  warnings: string[];
  performanceMs: number;
}

/**
 * Configuration for semantic validation rules (Layer 5)
 */
export interface SemanticValidationRules {
  maxResourceMemory?: number;
  maxResourceCpu?: number;
  allowedActions?: string[];
  deniedKeywords?: string[];
  maxDependencies?: number;
  urlAllowlist?: string[];
}

/**
 * Options for template import
 */
export interface ImportOptions {
  skipSignatureVerification?: boolean; // For testing only
  semanticRules?: SemanticValidationRules;
  trustLevel?: 'verified-internal' | 'signed-known' | 'untrusted';
}

/**
 * Export options
 */
export interface ExportOptions {
  format?: 'yaml' | 'json';
  includeComments?: boolean;
  pretty?: boolean;
}

/**
 * Error types for import/export operations
 */
export class ImportExportError extends Error {
  constructor(
    message: string,
    public layer?: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ImportExportError';
  }
}

export class SignatureVerificationError extends ImportExportError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'Layer 4: Signature Verification', details);
    this.name = 'SignatureVerificationError';
  }
}

export class SemanticValidationError extends ImportExportError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'Layer 5: Semantic Validation', details);
    this.name = 'SemanticValidationError';
  }
}

export class DependencyResolutionError extends ImportExportError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'Layer 6: Dependency Resolution', details);
    this.name = 'DependencyResolutionError';
  }
}
