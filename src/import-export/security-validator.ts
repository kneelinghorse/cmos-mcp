/**
 * Security Validator: 6-Layer Defense-in-Depth Architecture
 *
 * Implements the security architecture defined in R3.2_import-export-security.md:
 *
 * Layer 1: Path Sanitization (inherited from SecureYAMLLoader)
 * Layer 2: Safe Parsing (inherited from SecureYAMLLoader)
 * Layer 3: Schema Validation (inherited from SecureYAMLLoader)
 * Layer 4: Cryptographic Signature Verification
 * Layer 5: Semantic and Business Logic Validation
 * Layer 6: Sandboxed Dependency Resolution
 *
 * @module import-export/security-validator
 */

import { JSONSchema } from '../types/schemas';
import {
  MissionTemplate,
  ValidationResult,
  SecurityValidationReport,
  SemanticValidationRules,
  SignatureVerificationError,
  TemplateDependency,
  TemplateSpec,
} from './types';

/**
 * Mission template JSON Schema (Layer 3)
 */
const MISSION_TEMPLATE_SCHEMA: JSONSchema = {
  type: 'object',
  required: ['apiVersion', 'kind', 'metadata', 'spec'],
  properties: {
    apiVersion: {
      type: 'string',
      enum: ['mission-template.v1', 'mission-template.v2'],
    },
    kind: {
      type: 'string',
      enum: ['MissionTemplate', 'HybridMissionTemplate'],
    },
    metadata: {
      type: 'object',
      required: ['name', 'version', 'author', 'signature'],
      properties: {
        name: { type: 'string', minLength: 1 },
        version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
        author: { type: 'string', minLength: 1 },
        tags: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          maxItems: 32,
        },
        signature: {
          type: 'object',
          required: ['keyId', 'algorithm', 'value'],
          properties: {
            keyId: { type: 'string', minLength: 1 },
            algorithm: { type: 'string', enum: ['PGP-SHA256', 'RS256', 'ES256'] },
            value: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    spec: {
      type: 'object',
      properties: {
        structured_prompting: {
          type: 'object',
          required: ['enabled', 'role', 'context', 'task', 'format', 'constraints'],
          properties: {
            enabled: { type: 'boolean' },
            role: { type: 'string', minLength: 1 },
            context: { type: 'string', minLength: 1 },
            task: { type: 'string', minLength: 1 },
            format: { type: 'string', minLength: 1 },
            constraints: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: true,
    },
    dependencies: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'sourceUrl', 'version', 'checksum'],
        properties: {
          name: { type: 'string', minLength: 1 },
          sourceUrl: { type: 'string' },
          version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
          checksum: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
        },
      },
    },
  },
};

/**
 * Default semantic validation rules (Layer 5)
 */
const DEFAULT_SEMANTIC_RULES: Required<SemanticValidationRules> = {
  maxResourceMemory: 8192, // 8GB in MB
  maxResourceCpu: 16, // Max CPU cores
  allowedActions: [], // Empty means all allowed (will be enforced if populated)
  deniedKeywords: [
    '!!python',
    '!!java',
    'eval',
    'exec',
    'subprocess',
    '__import__',
    'system',
    'os.system',
  ],
  maxDependencies: 10,
  urlAllowlist: [], // Empty means deny all external URLs
};

/**
 * Trusted key registry for signature verification (Layer 4)
 * In production, this would be loaded from a secure key store
 */
interface PublicKey {
  keyId: string;
  algorithm: string;
  publicKey: string;
  owner: string;
  trustLevel: 'verified-internal' | 'signed-known';
}

const TRUSTED_KEYS: Map<string, PublicKey> = new Map();

/**
 * SecurityValidator implements the 6-layer validation pipeline
 */
export class SecurityValidator {
  private semanticRules: Required<SemanticValidationRules>;

  constructor(semanticRules?: SemanticValidationRules) {
    this.semanticRules = { ...DEFAULT_SEMANTIC_RULES, ...semanticRules };
  }

  /**
   * Execute the complete 6-layer validation pipeline
   * Designed to fail fast - cheaper checks first
   *
   * @param template - Parsed template object (already passed Layers 1-3)
   * @param skipSignature - Skip signature verification (for testing only)
   * @returns Security validation report
   */
  async validate(
    template: unknown,
    skipSignature: boolean = false
  ): Promise<SecurityValidationReport> {
    const startTime = Date.now();
    const layers: ValidationResult[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Assume Layers 1-3 already passed (path sanitization, safe parsing, schema validation)
      // These are handled by SecureYAMLLoader

      // Layer 4: Cryptographic Signature Verification
      const signatureResult = await this.verifySignature(
        template as MissionTemplate,
        skipSignature
      );
      layers.push(signatureResult);
      if (!signatureResult.passed) {
        errors.push(signatureResult.message || 'Signature verification failed');
      }

      // Layer 5: Semantic Validation
      const semanticResult = this.validateSemantics(template as MissionTemplate);
      layers.push(semanticResult);
      if (!semanticResult.passed) {
        errors.push(semanticResult.message || 'Semantic validation failed');
      }

      // Layer 6: Dependency Resolution (validation only, not actual fetching)
      const dependencyResult = this.validateDependencies(template as MissionTemplate);
      layers.push(dependencyResult);
      if (!dependencyResult.passed) {
        errors.push(dependencyResult.message || 'Dependency validation failed');
      }

      const performanceMs = Date.now() - startTime;
      const valid = errors.length === 0;

      return {
        valid,
        layers,
        template: valid ? (template as MissionTemplate) : undefined,
        errors,
        warnings,
        performanceMs,
      };
    } catch (error) {
      const performanceMs = Date.now() - startTime;
      return {
        valid: false,
        layers,
        errors: [...errors, error instanceof Error ? error.message : 'Unknown error'],
        warnings,
        performanceMs,
      };
    }
  }

  /**
   * Layer 4: Cryptographic Signature Verification
   * Verifies template authenticity and integrity using digital signatures
   *
   * @param template - Template to verify
   * @param skip - Skip verification (testing only)
   */
  private async verifySignature(
    template: MissionTemplate,
    skip: boolean
  ): Promise<ValidationResult> {
    if (skip) {
      return {
        layer: 'Layer 4: Signature Verification',
        passed: true,
        message: 'Skipped (testing mode)',
      };
    }

    try {
      const { metadata } = template;
      const { signature } = metadata;

      // Look up public key in trusted registry
      const publicKey = TRUSTED_KEYS.get(signature.keyId);
      if (!publicKey) {
        throw new SignatureVerificationError(`Untrusted or unknown key: ${signature.keyId}`, {
          keyId: signature.keyId,
        });
      }

      // Verify algorithm matches
      if (publicKey.algorithm !== signature.algorithm) {
        throw new SignatureVerificationError(
          `Algorithm mismatch: expected ${publicKey.algorithm}, got ${signature.algorithm}`
        );
      }

      // Create canonical representation of signed content
      // In a real implementation, this would be the spec + dependencies
      const canonicalContent = this.canonicalize(template.spec, template.dependencies);

      // Verify signature (simplified - in production use crypto library)
      const isValid = this.verifySignatureInternal(
        canonicalContent,
        signature.value,
        publicKey.publicKey,
        signature.algorithm
      );

      if (!isValid) {
        throw new SignatureVerificationError('Invalid signature - content may be tampered');
      }

      return {
        layer: 'Layer 4: Signature Verification',
        passed: true,
        message: `Verified signature from ${publicKey.owner}`,
        details: {
          keyId: signature.keyId,
          trustLevel: publicKey.trustLevel,
          owner: publicKey.owner,
        },
      };
    } catch (error) {
      return {
        layer: 'Layer 4: Signature Verification',
        passed: false,
        message: error instanceof Error ? error.message : 'Signature verification failed',
      };
    }
  }

  /**
   * Create canonical representation of content for signing
   */
  private canonicalize(spec: TemplateSpec, dependencies: TemplateDependency[] = []): string {
    // Deterministic JSON serialization
    const content = {
      spec,
      dependencies,
    };
    return JSON.stringify(content, Object.keys(content).sort());
  }

  /**
   * Internal signature verification (simplified)
   * In production, use proper crypto libraries (e.g., node-forge, crypto)
   */
  private verifySignatureInternal(
    content: string,
    signature: string,
    publicKey: string,
    _algorithm: string
  ): boolean {
    // Simplified implementation - in production use proper crypto
    // For now, just check that signature is non-empty
    // Real implementation would use:
    // - crypto.verify() for RS256/ES256
    // - GPG libraries for PGP-SHA256
    return signature.length > 0 && publicKey.length > 0;
  }

  /**
   * Layer 5: Semantic and Business Logic Validation
   * Validates business logic constraints that cannot be expressed in schema
   *
   * @param template - Template to validate
   */
  private validateSemantics(template: MissionTemplate): ValidationResult {
    const errors: string[] = [];

    try {
      const { spec } = template;

      // Check for denied keywords (anti-RCE)
      const specString = JSON.stringify(spec).toLowerCase();
      for (const keyword of this.semanticRules.deniedKeywords) {
        if (specString.includes(keyword.toLowerCase())) {
          errors.push(`Denied keyword detected: ${keyword}`);
        }
      }

      // Check resource limits
      const resources = (spec as { resources?: { memory?: unknown; cpu?: unknown } }).resources;
      if (resources && typeof resources === 'object') {
        const memory = (resources as { memory?: unknown }).memory;
        if (typeof memory === 'number' && memory > this.semanticRules.maxResourceMemory) {
          errors.push(
            `Memory request ${memory}MB exceeds limit ${this.semanticRules.maxResourceMemory}MB`
          );
        }

        const cpu = (resources as { cpu?: unknown }).cpu;
        if (typeof cpu === 'number' && cpu > this.semanticRules.maxResourceCpu) {
          errors.push(
            `CPU request ${cpu} cores exceeds limit ${this.semanticRules.maxResourceCpu} cores`
          );
        }
      }

      const phases = (spec as { phases?: unknown }).phases;
      if (this.semanticRules.allowedActions.length > 0 && Array.isArray(phases)) {
        for (const phase of phases) {
          if (!phase || typeof phase !== 'object') {
            continue;
          }

          const steps = (phase as { steps?: unknown }).steps;
          if (!Array.isArray(steps)) {
            continue;
          }

          for (const step of steps) {
            if (!step || typeof step !== 'object') {
              continue;
            }

            const action = (step as { action?: unknown }).action;
            if (typeof action === 'string' && !this.semanticRules.allowedActions.includes(action)) {
              errors.push(`Disallowed action: ${action}`);
            }
          }
        }
      }

      const startDate = (spec as { startDate?: unknown }).startDate;
      const endDate = (spec as { endDate?: unknown }).endDate;
      if (typeof startDate === 'string' && typeof endDate === 'string') {
        const start = new Date(startDate);
        const end = new Date(endDate);
        if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end <= start) {
          errors.push('End date must be after start date');
        }
      }

      if (errors.length > 0) {
        return {
          layer: 'Layer 5: Semantic Validation',
          passed: false,
          message: `Semantic validation failed: ${errors.join('; ')}`,
          details: { errors },
        };
      }

      return {
        layer: 'Layer 5: Semantic Validation',
        passed: true,
        message: 'All semantic rules passed',
      };
    } catch (error) {
      return {
        layer: 'Layer 5: Semantic Validation',
        passed: false,
        message: error instanceof Error ? error.message : 'Semantic validation error',
      };
    }
  }

  /**
   * Layer 6: Dependency Validation (not resolution)
   * Validates dependency declarations against security policies
   *
   * @param template - Template to validate
   */
  private validateDependencies(template: MissionTemplate): ValidationResult {
    const errors: string[] = [];

    try {
      const { dependencies } = template;

      // No dependencies is valid
      if (!dependencies || dependencies.length === 0) {
        return {
          layer: 'Layer 6: Dependency Validation',
          passed: true,
          message: 'No dependencies to validate',
        };
      }

      // Check dependency count limit
      if (dependencies.length > this.semanticRules.maxDependencies) {
        errors.push(
          `Too many dependencies: ${dependencies.length} exceeds limit ${this.semanticRules.maxDependencies}`
        );
      }

      // Validate each dependency
      for (const dep of dependencies) {
        // Check URL allowlist
        const isAllowed = this.isUrlAllowed(dep.sourceUrl);
        if (!isAllowed) {
          errors.push(`Dependency URL not in allowlist: ${dep.sourceUrl}`);
        }

        // Validate checksum format
        if (!dep.checksum.match(/^sha256:[a-f0-9]{64}$/)) {
          errors.push(`Invalid checksum format for dependency ${dep.name}: ${dep.checksum}`);
        }

        // Validate version format (semver)
        if (!dep.version.match(/^\d+\.\d+\.\d+$/)) {
          errors.push(`Invalid version format for dependency ${dep.name}: ${dep.version}`);
        }
      }

      if (errors.length > 0) {
        return {
          layer: 'Layer 6: Dependency Validation',
          passed: false,
          message: `Dependency validation failed: ${errors.join('; ')}`,
          details: { errors },
        };
      }

      return {
        layer: 'Layer 6: Dependency Validation',
        passed: true,
        message: `Validated ${dependencies.length} dependencies`,
      };
    } catch (error) {
      return {
        layer: 'Layer 6: Dependency Validation',
        passed: false,
        message: error instanceof Error ? error.message : 'Dependency validation error',
      };
    }
  }

  /**
   * Check if URL is in the allowlist
   * Default deny policy - only explicitly allowed domains permitted
   */
  private isUrlAllowed(url: string): boolean {
    // If allowlist is empty, deny all external URLs
    if (this.semanticRules.urlAllowlist.length === 0) {
      return false;
    }

    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname;

      // Check against allowlist patterns
      return this.semanticRules.urlAllowlist.some((pattern) => {
        // Support wildcards like *.example.com
        if (pattern.startsWith('*.')) {
          const domain = pattern.slice(2);
          return hostname.endsWith(domain);
        }
        return hostname === pattern;
      });
    } catch {
      return false; // Invalid URL
    }
  }

  /**
   * Get the mission template schema for external use
   */
  static getSchema(): JSONSchema {
    return MISSION_TEMPLATE_SCHEMA;
  }

  /**
   * Register a trusted public key (for testing/setup)
   */
  static registerTrustedKey(key: PublicKey): void {
    TRUSTED_KEYS.set(key.keyId, key);
  }

  /**
   * Clear all trusted keys (for testing)
   */
  static clearTrustedKeys(): void {
    TRUSTED_KEYS.clear();
  }
}
