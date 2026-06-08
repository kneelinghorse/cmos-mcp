/**
 * Security Validator Tests
 *
 * Tests all 6 security layers and validates against threat vectors from R3.2:
 * - T-01: Remote Code Execution
 * - T-02: Path Traversal
 * - T-03: Server-Side Request Forgery (SSRF)
 * - T-04: Resource Exhaustion DoS
 * - T-05: Malicious Business Logic
 * - T-06: Data Integrity Failure
 */

import { SecurityValidator } from '../../src/import-export/security-validator';
import { MissionTemplate } from '../../src/import-export/types';
import { assertArray, assertRecord, assertString } from '../utils/type-guards';

describe('SecurityValidator - 6-Layer Defense', () => {
  let validator: SecurityValidator;

  beforeEach(() => {
    // Reset trusted keys before each test
    SecurityValidator.clearTrustedKeys();

    // Create validator with default rules
    validator = new SecurityValidator();
  });

  // Helper to create a valid template
  function createValidTemplate(): MissionTemplate {
    return {
      apiVersion: 'mission-template.v1',
      kind: 'MissionTemplate',
      metadata: {
        name: 'test-template',
        version: '1.0.0',
        author: 'test@example.com',
        signature: {
          keyId: 'test-key-123',
          algorithm: 'RS256',
          value: 'valid-signature-base64',
        },
      },
      spec: {
        description: 'A test template',
        phases: [
          {
            name: 'Phase 1',
            steps: [
              {
                action: 'test-action',
                parameters: {},
              },
            ],
          },
        ],
      },
    };
  }

  type MutablePhaseStep = {
    action: string;
    parameters: Record<string, unknown>;
  };

  type MutablePhase = {
    name: string;
    steps: MutablePhaseStep[];
  };

  function getMutablePhases(template: MissionTemplate): MutablePhase[] {
    const spec = template.spec as Record<string, unknown>;
    const phases = spec['phases'];
    assertArray(phases, 'template.spec.phases');
    phases.forEach((phase, index) => assertMutablePhase(phase, `template.spec.phases[${index}]`));
    return phases as MutablePhase[];
  }

  function getMutablePhaseStep(
    template: MissionTemplate,
    phaseIndex: number,
    stepIndex: number
  ): MutablePhaseStep {
    const phases = getMutablePhases(template);
    const phase = phases[phaseIndex];
    if (!phase) {
      throw new Error(`Expected phase at index ${phaseIndex}`);
    }
    const step = phase.steps[stepIndex];
    if (!step) {
      throw new Error(`Expected step at index ${stepIndex} for phase ${phaseIndex}`);
    }
    return step;
  }

  function assertMutablePhase(value: unknown, context: string): asserts value is MutablePhase {
    assertRecord(value, context);
    assertString(value.name, `${context}.name`);
    const steps = value.steps;
    assertArray(steps, `${context}.steps`);
    steps.forEach((step, index) => assertMutablePhaseStep(step, `${context}.steps[${index}]`));
  }

  function assertMutablePhaseStep(
    value: unknown,
    context: string
  ): asserts value is MutablePhaseStep {
    assertRecord(value, context);
    assertString(value.action, `${context}.action`);
    assertRecord(value.parameters, `${context}.parameters`);
  }

  describe('Layer 4: Signature Verification', () => {
    it('should reject templates with untrusted keys', async () => {
      const template = createValidTemplate();

      const result = await validator.validate(template, false);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Untrusted or unknown key'))).toBe(true);
    });

    it('should accept templates with trusted keys', async () => {
      // Register a trusted key
      SecurityValidator.registerTrustedKey({
        keyId: 'test-key-123',
        algorithm: 'RS256',
        publicKey: 'public-key-data',
        owner: 'Test Team',
        trustLevel: 'verified-internal',
      });

      const template = createValidTemplate();
      const result = await validator.validate(template, false);

      const signatureLayer = result.layers.find((l) => l.layer.includes('Signature'));
      expect(signatureLayer?.passed).toBe(true);
    });

    it('should skip verification when explicitly requested (testing only)', async () => {
      const template = createValidTemplate();

      const result = await validator.validate(template, true);

      const signatureLayer = result.layers.find((l) => l.layer.includes('Signature'));
      expect(signatureLayer?.passed).toBe(true);
      expect(signatureLayer?.message).toContain('Skipped');
    });

    it('T-06: should reject templates with algorithm mismatch', async () => {
      // Register key with RS256
      SecurityValidator.registerTrustedKey({
        keyId: 'test-key-123',
        algorithm: 'RS256',
        publicKey: 'public-key-data',
        owner: 'Test Team',
        trustLevel: 'verified-internal',
      });

      const template = createValidTemplate();
      // Template claims ES256
      template.metadata.signature.algorithm = 'ES256';

      const result = await validator.validate(template, false);

      const signatureLayer = result.layers.find((l) => l.layer.includes('Signature'));
      expect(signatureLayer?.passed).toBe(false);
      expect(signatureLayer?.message).toContain('Algorithm mismatch');
    });
  });

  describe('Layer 5: Semantic Validation', () => {
    beforeEach(() => {
      // Register trusted key for all semantic tests
      SecurityValidator.registerTrustedKey({
        keyId: 'test-key-123',
        algorithm: 'RS256',
        publicKey: 'public-key-data',
        owner: 'Test Team',
        trustLevel: 'verified-internal',
      });
    });

    it('T-01: should reject templates with denied keywords (RCE prevention)', async () => {
      const template = createValidTemplate();
      template.spec.maliciousField = '!!python/object/apply:os.system';

      const result = await validator.validate(template, true);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Denied keyword'))).toBe(true);
    });

    it('T-01: should detect eval and exec keywords', async () => {
      const template = createValidTemplate();
      template.spec.script = 'eval("malicious code")';

      const result = await validator.validate(template, true);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('eval'))).toBe(true);
    });

    it('T-04: should reject excessive memory requests (DoS prevention)', async () => {
      const template = createValidTemplate();
      template.spec.resources = {
        memory: 16384, // 16GB, exceeds default 8GB limit
      };

      const result = await validator.validate(template, true);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Memory request'))).toBe(true);
    });

    it('T-04: should reject excessive CPU requests', async () => {
      const template = createValidTemplate();
      template.spec.resources = {
        cpu: 32, // 32 cores, exceeds default 16 core limit
      };

      const result = await validator.validate(template, true);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('CPU request'))).toBe(true);
    });

    it('T-05: should validate action allowlist when configured', async () => {
      const validatorWithAllowlist = new SecurityValidator({
        allowedActions: ['approved-action', 'another-approved-action'],
      });

      const template = createValidTemplate();
      const step = getMutablePhaseStep(template, 0, 0);
      step.action = 'unapproved-action';

      const result = await validatorWithAllowlist.validate(template, true);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Disallowed action'))).toBe(true);
    });

    it('should enforce cross-field consistency (endDate > startDate)', async () => {
      const template = createValidTemplate();
      template.spec.startDate = '2025-12-31';
      template.spec.endDate = '2025-01-01'; // Invalid: ends before start

      const result = await validator.validate(template, true);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('End date must be after start date'))).toBe(true);
    });

    it('should accept valid resource requests', async () => {
      const template = createValidTemplate();
      template.spec.resources = {
        memory: 4096, // 4GB - within limits
        cpu: 8, // 8 cores - within limits
      };

      const result = await validator.validate(template, true);

      const semanticLayer = result.layers.find((l) => l.layer.includes('Semantic'));
      expect(semanticLayer?.passed).toBe(true);
    });
  });

  describe('Layer 6: Dependency Validation', () => {
    beforeEach(() => {
      SecurityValidator.registerTrustedKey({
        keyId: 'test-key-123',
        algorithm: 'RS256',
        publicKey: 'public-key-data',
        owner: 'Test Team',
        trustLevel: 'verified-internal',
      });
    });

    it('should accept templates with no dependencies', async () => {
      const template = createValidTemplate();
      // No dependencies field

      const result = await validator.validate(template, true);

      const depLayer = result.layers.find((l) => l.layer.includes('Dependency'));
      expect(depLayer?.passed).toBe(true);
      expect(depLayer?.message).toContain('No dependencies');
    });

    it('T-04: should reject too many dependencies (DoS prevention)', async () => {
      const template = createValidTemplate();
      template.dependencies = Array(15)
        .fill(null)
        .map((_, i) => ({
          name: `dep-${i}`,
          sourceUrl: `https://example.com/dep-${i}.yaml`,
          version: '1.0.0',
          checksum: 'sha256:' + '0'.repeat(64),
        }));

      const result = await validator.validate(template, true);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Too many dependencies'))).toBe(true);
    });

    it('T-03: should reject URLs not in allowlist (SSRF prevention)', async () => {
      const validatorWithAllowlist = new SecurityValidator({
        urlAllowlist: ['trusted.example.com'],
      });

      const template = createValidTemplate();
      template.dependencies = [
        {
          name: 'malicious-dep',
          sourceUrl: 'https://evil.com/malware.yaml',
          version: '1.0.0',
          checksum: 'sha256:' + '0'.repeat(64),
        },
      ];

      const result = await validatorWithAllowlist.validate(template, true);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('not in allowlist'))).toBe(true);
    });

    it('T-03: should accept URLs in allowlist', async () => {
      const validatorWithAllowlist = new SecurityValidator({
        urlAllowlist: ['trusted.example.com'],
      });

      const template = createValidTemplate();
      template.dependencies = [
        {
          name: 'safe-dep',
          sourceUrl: 'https://trusted.example.com/dep.yaml',
          version: '1.0.0',
          checksum: 'sha256:' + 'a'.repeat(64),
        },
      ];

      const result = await validatorWithAllowlist.validate(template, true);

      const depLayer = result.layers.find((l) => l.layer.includes('Dependency'));
      expect(depLayer?.passed).toBe(true);
    });

    it('should support wildcard domain matching', async () => {
      const validatorWithWildcard = new SecurityValidator({
        urlAllowlist: ['*.example.com'],
      });

      const template = createValidTemplate();
      template.dependencies = [
        {
          name: 'dep',
          sourceUrl: 'https://subdomain.example.com/dep.yaml',
          version: '1.0.0',
          checksum: 'sha256:' + 'a'.repeat(64),
        },
      ];

      const result = await validatorWithWildcard.validate(template, true);

      const depLayer = result.layers.find((l) => l.layer.includes('Dependency'));
      expect(depLayer?.passed).toBe(true);
    });

    it('should validate checksum format', async () => {
      const template = createValidTemplate();
      template.dependencies = [
        {
          name: 'dep',
          sourceUrl: 'file:///local/dep.yaml',
          version: '1.0.0',
          checksum: 'invalid-checksum-format', // Invalid format
        },
      ];

      const result = await validator.validate(template, true);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Invalid checksum format'))).toBe(true);
    });

    it('should validate version format (semver)', async () => {
      const template = createValidTemplate();
      template.dependencies = [
        {
          name: 'dep',
          sourceUrl: 'file:///local/dep.yaml',
          version: 'not-a-valid-version', // Invalid semver
          checksum: 'sha256:' + 'a'.repeat(64),
        },
      ];

      const result = await validator.validate(template, true);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Invalid version format'))).toBe(true);
    });
  });

  describe('Performance Requirements', () => {
    it('should track validation performance', async () => {
      const template = createValidTemplate();

      const result = await validator.validate(template, true);

      expect(result.performanceMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.performanceMs).toBe('number');
    });

    it('should provide layer-by-layer results', async () => {
      const template = createValidTemplate();

      const result = await validator.validate(template, true);

      expect(result.layers.length).toBeGreaterThan(0);
      expect(result.layers[0]).toHaveProperty('layer');
      expect(result.layers[0]).toHaveProperty('passed');
    });
  });

  describe('Complete Validation Pipeline', () => {
    it('should pass all layers for a valid template', async () => {
      SecurityValidator.registerTrustedKey({
        keyId: 'test-key-123',
        algorithm: 'RS256',
        publicKey: 'public-key-data',
        owner: 'Test Team',
        trustLevel: 'verified-internal',
      });

      // Create validator with URL allowlist for dependencies
      const validatorWithAllowlist = new SecurityValidator({
        urlAllowlist: ['*.local', 'localhost'],
      });

      const template = createValidTemplate();
      template.spec.resources = { memory: 2048, cpu: 4 };
      // No dependencies to avoid allowlist issues

      const result = await validatorWithAllowlist.validate(template, false);

      // All layers should pass
      result.layers.forEach((layer) => {
        expect(layer.passed).toBe(true);
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});
