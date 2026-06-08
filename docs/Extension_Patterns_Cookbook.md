# Extension Patterns Cookbook

Practical recipes and patterns for common Extension System tasks.

## Table of Contents

1. [Template Extraction Patterns](#template-extraction-patterns)
2. [Secure Sharing Patterns](#secure-sharing-patterns)
3. [Pack Composition Patterns](#pack-composition-patterns)
4. [Versioning Patterns](#versioning-patterns)
5. [Migration Patterns](#migration-patterns)
6. [Error Handling Patterns](#error-handling-patterns)

---

## Template Extraction Patterns

### Pattern 1: Extract Multi-Language Project Template

**Scenario**: Extract a template from a full-stack project with frontend and backend.

```typescript
import { extractTemplate } from './tools/extract-template';
import * as fs from 'fs';
import * as path from 'path';

import { promises as fs } from 'fs';

async function extractFullStackTemplate(projectPath: string) {
  // Step 1: Extract with higher confidence threshold for cleaner params
  const result = await extractTemplate({
    sourceMissionPath: projectPath,
    templateName: 'Full-Stack Web App',
    author: 'platform-team@company.com',
    description: 'React frontend + Node.js backend + PostgreSQL',
    confidenceThreshold: 0.75, // Higher threshold for multi-lang projects
  });

  if (!result.success) {
    throw new Error(`Extraction failed: ${result.errors?.join(', ')}`);
  }

  // Step 2: Review and categorize parameters
  const params = result.template!.metadata.parameters;
  const categorized = {
    frontend: {} as Record<string, any>,
    backend: {} as Record<string, any>,
    database: {} as Record<string, any>,
    general: {} as Record<string, any>,
  };

  Object.entries(params).forEach(([name, param]) => {
    if (name.includes('react') || name.includes('frontend')) {
      categorized.frontend[name] = param;
    } else if (name.includes('api') || name.includes('server')) {
      categorized.backend[name] = param;
    } else if (name.includes('db') || name.includes('database')) {
      categorized.database[name] = param;
    } else {
      categorized.general[name] = param;
    }
  });

  // Step 3: Add category metadata
  result.template!.metadata.parameterCategories = categorized;

  // Step 4: Save with enhanced metadata
  const outputPath = path.join('./templates', 'fullstack-template.json');
  await fs.writeFile(outputPath, JSON.stringify(result.template, null, 2));

  console.log('✓ Full-stack template extracted');
  console.log('  Frontend params:', Object.keys(categorized.frontend).length);
  console.log('  Backend params:', Object.keys(categorized.backend).length);
  console.log('  Database params:', Object.keys(categorized.database).length);

  return result.template;
}
```

**When to use**: Extracting complex, multi-component projects where parameter organization matters.

---

### Pattern 2: Extract with Manual Parameter Review

**Scenario**: Extract a template but review and refine parameters before finalizing.

```typescript
async function extractWithReview(missionPath: string) {
  // Step 1: Extract with low threshold to see all candidates
  const extractor = new TemplateExtractor({
    sourceMissionPath: missionPath,
    author: 'dev@company.com',
    confidenceThreshold: 0.4, // Low threshold initially
  });

  const stage1 = await extractor.identifyCandidates(missionPath);

  // Step 2: Review candidates and select manually
  const selectedCandidates: Record<string, Candidate[]> = {};

  Object.entries(stage1.candidates).forEach(([key, candidates]) => {
    // Filter: only keep candidates with frequency > 2 or confidence > 0.6
    const filtered = candidates.filter((c) => c.frequency > 2 || c.confidence > 0.6);

    if (filtered.length > 0) {
      selectedCandidates[key] = filtered;
    }
  });

  console.log(
    `Reviewed: ${Object.keys(stage1.candidates).length} → ${Object.keys(selectedCandidates).length} parameters`
  );

  // Step 3: Generate template from selected candidates
  const stage2 = await extractor.generateTemplate(selectedCandidates);

  return {
    template: stage2.template,
    stats: {
      totalCandidates: Object.keys(stage1.candidates).length,
      selectedParameters: Object.keys(selectedCandidates).length,
      filesTemplated: stage2.filesTemplated,
    },
  };
}
```

**When to use**: When automatic extraction produces too many or too few parameters.

---

### Pattern 3: Extract and Version Immediately

**Scenario**: Extract a template and register it with versioning in one workflow.

```typescript
async function extractAndVersion(missionPath: string, version: string) {
  // Extract
  const extractResult = await extractTemplate({
    sourceMissionPath: missionPath,
    templateName: 'API Service Template',
    author: 'team@company.com',
  });

  if (!extractResult.success) {
    throw new Error('Extraction failed');
  }

  // Register version
  const versionManager = new VersionManager();
  const templateId = extractResult.template!.metadata.templateId;

  versionManager.registerVersion({
    templateId,
    version: versionManager.parseVersion(version),
    releaseDate: new Date().toISOString(),
    changelog: `Initial extraction from ${path.basename(missionPath)}`,
  });

  console.log(`✓ Template ${templateId}@${version} extracted and versioned`);

  return {
    templateId,
    version,
    template: extractResult.template,
  };
}

// Usage
await extractAndVersion('./missions/order-service', '1.0.0');
```

**When to use**: Starting a new template lineage from a reference implementation.

---

## Secure Sharing Patterns

### Pattern 4: Team-to-Team Template Sharing

**Scenario**: Share templates securely between internal teams.

```typescript
// Team A: Generate and sign template
async function shareTemplate(template: MissionTemplate) {
  const keyPair = await generateKeyPair(); // Your key generation method

  // Export with signature
  const exportResult = await exportTemplate({
    template,
    outputPath: './shared-templates',
    format: 'yaml',
    includeSignature: true,
    keyId: 'team-a-signing-key-001',
    algorithm: 'RS256',
  });

  // Share public key separately (secure channel)
  const publicKeyInfo = {
    keyId: 'team-a-signing-key-001',
    publicKey: keyPair.publicKey,
    owner: 'Team A',
    trustLevel: 'verified-internal' as const,
  };

  return {
    templatePath: exportResult.exportPath,
    publicKeyInfo,
  };
}

// Team B: Import with verification
async function receiveTemplate(templatePath: string, publicKeyInfo: any) {
  // Register trusted key
  SecurityValidator.registerTrustedKey({
    keyId: publicKeyInfo.keyId,
    algorithm: 'RS256',
    publicKey: publicKeyInfo.publicKey,
    owner: publicKeyInfo.owner,
    trustLevel: publicKeyInfo.trustLevel,
  });

  // Import with full validation
  const importer = new TemplateImporter('./shared-templates');
  const importResult = await importer.import(path.basename(templatePath), {
    skipSignatureVerification: false, // Enforce signature check
    allowUntrusted: false,
  });

  if (!importResult.validationReport.valid) {
    throw new Error(`Validation failed: ${importResult.validationReport.errors.join(', ')}`);
  }

  console.log('✓ Template imported securely');
  console.log('  Layers passed:', importResult.validationReport.layers.length);

  return importResult.template;
}
```

**When to use**: Sharing templates across teams with security requirements.

---

### Pattern 5: Multi-Format Distribution

**Scenario**: Export template in both YAML and JSON for different use cases.

```typescript
async function distributeTemplate(template: MissionTemplate) {
  const exports = [];

  // YAML for human readability
  const yamlResult = await exportTemplate({
    template,
    outputPath: './dist',
    format: 'yaml',
    includeSignature: true,
    keyId: 'release-key',
    algorithm: 'RS256',
  });
  exports.push({ format: 'yaml', path: yamlResult.exportPath });

  // JSON for programmatic use
  const jsonResult = await exportTemplate({
    template,
    outputPath: './dist',
    format: 'json',
    includeSignature: true,
    keyId: 'release-key',
    algorithm: 'RS256',
  });
  exports.push({ format: 'json', path: jsonResult.exportPath });

  // Generate README
  const readme = `
# Template Distribution

## Files
- YAML: ${path.basename(yamlResult.exportPath!)}
- JSON: ${path.basename(jsonResult.exportPath!)}

## Verification
Both files are signed with keyId: release-key
Import with signature verification enabled.
  `.trim();

  await fs.writeFile('./dist/README.md', readme);

  return exports;
}
```

**When to use**: Publishing templates for diverse consumption methods.

---

## Pack Composition Patterns

### Pattern 6: Layer Architecture with Base Pack

**Scenario**: Build layered applications with base + feature packs.

```typescript
async function buildLayeredApp(features: string[]) {
  // Always include base layer
  const basePacks = ['base-web-server', 'base-logging'];

  // Combine base + selected features
  const allPacks = [...basePacks, ...features];

  const result = await combinePacks({
    packNames: allPacks,
    registryPath: './registry.yaml',
    strategy: 'deep-merge',
    resolveDependencies: true,
  });

  if (!result.success) {
    throw new Error(`Combination failed: ${result.errors?.join(', ')}`);
  }

  // Verify base components are present
  const template = result.combinedPack!.template;
  if (!template.server || !template.logging) {
    throw new Error('Base components missing from combined pack');
  }

  console.log('✓ Layered application built');
  console.log('  Base packs:', basePacks.join(', '));
  console.log('  Feature packs:', features.join(', '));
  console.log('  Load order:', result.loadOrder?.join(' → '));

  return result.combinedPack;
}

// Usage
const app = await buildLayeredApp(['auth-jwt', 'database-postgres', 'api-rest']);
```

**When to use**: Building applications with mandatory base layers and optional features.

---

### Pattern 7: Conflict Resolution with Selective Merge

**Scenario**: Combine packs with known conflicts, using selective strategy.

```typescript
async function combineWithConflictResolution() {
  // These packs have conflicting 'config.port' values
  const result = await combinePacks({
    packNames: ['service-a', 'service-b'],
    registryPath: './registry.yaml',
    strategy: 'selective',
    mergePaths: ['middleware', 'routes', 'database'], // Merge these
    overridePaths: ['config.port'], // Last pack wins for port
    resolveDependencies: true,
  });

  // Log the conflict resolution
  if (result.warnings) {
    result.warnings.forEach((w) => console.warn('⚠', w));
  }

  console.log('✓ Packs combined with selective merge');
  console.log('  Merged paths: middleware, routes, database');
  console.log('  Override paths: config.port');

  return result.combinedPack;
}
```

**When to use**: Known conflicts between packs that need explicit resolution.

---

### Pattern 8: Dynamic Pack Selection

**Scenario**: Select packs based on user input or environment.

```typescript
async function buildCustomApp(requirements: {
  auth?: 'jwt' | 'oauth' | 'none';
  database?: 'postgres' | 'mysql' | 'mongodb';
  cache?: boolean;
  monitoring?: boolean;
}) {
  const packs = ['base-api']; // Always include base

  // Add auth pack
  if (requirements.auth && requirements.auth !== 'none') {
    packs.push(`auth-${requirements.auth}`);
  }

  // Add database pack
  if (requirements.database) {
    packs.push(`database-${requirements.database}`);
  }

  // Add optional features
  if (requirements.cache) {
    packs.push('cache-redis');
  }

  if (requirements.monitoring) {
    packs.push('monitoring-prometheus');
  }

  console.log('Building app with packs:', packs.join(', '));

  const result = await combinePacks({
    packNames: packs,
    registryPath: './registry.yaml',
    strategy: 'deep-merge',
    resolveDependencies: true,
  });

  return result.combinedPack;
}

// Usage
const app = await buildCustomApp({
  auth: 'jwt',
  database: 'postgres',
  cache: true,
  monitoring: true,
});
```

**When to use**: Building configurable applications based on requirements.

---

## Versioning Patterns

### Pattern 9: Safe Version Upgrade Check

**Scenario**: Check if upgrade is safe before applying.

```typescript
async function safeUpgrade(templateId: string, currentVersion: string) {
  // Get latest version
  const latest = await getLatestVersion({
    templateId,
    includePrerelease: false,
  });

  if (!latest.version) {
    console.log('Already on latest version');
    return null;
  }

  // Check compatibility
  const compat = await checkVersionCompatibility({
    templateId,
    version1: latest.version.version,
    version2: currentVersion,
  });

  if (compat.compatible) {
    console.log(`✓ Safe to upgrade: ${currentVersion} → ${latest.version.version}`);
    console.log('  No breaking changes');
    return { safe: true, to: latest.version.version };
  }

  // Find migration path
  const migrationPath = await findMigrationPath({
    templateId,
    fromVersion: currentVersion,
    toVersion: latest.version.version,
  });

  if (!migrationPath.pathFound) {
    console.error('✗ No migration path available');
    return { safe: false, reason: 'No migration path' };
  }

  console.log(`⚠ Upgrade requires migration (${migrationPath.path!.steps.length} steps)`);
  console.log('  Reversible:', migrationPath.path!.reversible);
  console.log('  Estimated duration:', migrationPath.path!.totalDuration, 's');

  return {
    safe: false,
    requiresMigration: true,
    path: migrationPath.path,
  };
}

// Usage
const upgrade = await safeUpgrade('api-template', '1.5.0');
if (upgrade?.safe) {
  // Proceed with upgrade
} else if (upgrade?.requiresMigration) {
  // Review migration path, then execute
}
```

**When to use**: Before upgrading templates in production environments.

---

### Pattern 10: Deprecation Workflow

**Scenario**: Mark old versions as deprecated and guide users to new versions.

```typescript
async function deprecateVersion(
  templateId: string,
  deprecatedVersion: string,
  replacedBy: string,
  message: string
) {
  const versionManager = new VersionManager();

  // Get the version to deprecate
  const version = versionManager.getVersion(templateId, deprecatedVersion);
  if (!version) {
    throw new Error(`Version ${deprecatedVersion} not found`);
  }

  // Update with deprecation info
  version.deprecated = {
    message,
    replacedBy,
    date: new Date().toISOString(),
  };

  // Re-register with deprecation
  versionManager.registerVersion(version);

  console.log(`✓ Version ${deprecatedVersion} marked as deprecated`);
  console.log(`  Replaced by: ${replacedBy}`);
  console.log(`  Message: ${message}`);

  // Create migration from deprecated to replacement
  const migrationEngine = new MigrationEngine(versionManager);
  migrationEngine.registerMigration({
    id: `deprecation-${deprecatedVersion}-to-${replacedBy}`,
    templateId,
    fromVersion: versionManager.parseVersion(deprecatedVersion),
    toVersion: versionManager.parseVersion(replacedBy),
    description: `Migrate from deprecated ${deprecatedVersion} to ${replacedBy}`,
    transform: (data) => {
      // Add transformation logic
      return {
        ...data,
        _migrated: true,
        _migratedFrom: deprecatedVersion,
        _migratedAt: new Date().toISOString(),
      };
    },
    reversible: false,
  });

  return { deprecated: true, replacedBy };
}

// Usage
await deprecateVersion(
  'api-template',
  '1.0.0',
  '2.0.0',
  'Version 1.0.0 has security vulnerabilities. Please upgrade to 2.0.0'
);
```

**When to use**: Managing template lifecycle and guiding users away from old versions.

---

## Migration Patterns

### Pattern 11: Multi-Step Migration with Validation

**Scenario**: Migrate template data through multiple versions with validation at each step.

```typescript
async function migrateWithValidation(
  templateId: string,
  data: any,
  fromVersion: string,
  toVersion: string
) {
  const versionManager = new VersionManager();
  const migrationEngine = new MigrationEngine(versionManager);

  const from = versionManager.parseVersion(fromVersion);
  const to = versionManager.parseVersion(toVersion);

  // Find path
  const path = migrationEngine.findMigrationPath(templateId, from, to);
  if (!path) {
    throw new Error('No migration path found');
  }

  console.log(`Starting migration: ${fromVersion} → ${toVersion}`);
  console.log(`Steps: ${path.steps.length}`);

  let currentData = data;
  const validationResults = [];

  // Execute each step with validation
  for (const [index, step] of path.steps.entries()) {
    console.log(`\nStep ${index + 1}/${path.steps.length}: ${step.description}`);

    // Pre-migration validation
    if (step.validate) {
      const valid = step.validate(currentData);
      if (!valid) {
        throw new Error(`Pre-migration validation failed at step ${index + 1}`);
      }
    }

    // Execute migration
    const stepResult = await step.transform(currentData);
    currentData = stepResult;

    // Post-migration validation
    validationResults.push({
      step: index + 1,
      fromVersion: versionManager.versionToString(step.fromVersion),
      toVersion: versionManager.versionToString(step.toVersion),
      validated: true,
    });

    console.log(`  ✓ Completed`);
  }

  console.log(`\n✓ Migration complete: ${fromVersion} → ${toVersion}`);
  console.log(`  Steps validated: ${validationResults.length}`);

  return {
    success: true,
    data: currentData,
    validationResults,
  };
}
```

**When to use**: Critical migrations where data integrity must be verified at each step.

---

### Pattern 12: Reversible Migration with Rollback

**Scenario**: Perform migration with ability to rollback if issues occur.

```typescript
async function migrateWithRollback(
  templateId: string,
  data: any,
  fromVersion: string,
  toVersion: string
) {
  const versionManager = new VersionManager();
  const migrationEngine = new MigrationEngine(versionManager);

  const from = versionManager.parseVersion(fromVersion);
  const to = versionManager.parseVersion(toVersion);

  // Find and verify path is reversible
  const path = migrationEngine.findMigrationPath(templateId, from, to);
  if (!path || !path.reversible) {
    throw new Error('Migration path is not reversible');
  }

  // Backup original data
  const backup = JSON.parse(JSON.stringify(data));

  try {
    // Attempt migration
    const result = await migrationEngine.migrate(templateId, data, from, to);

    if (!result.success) {
      throw new Error(result.error || 'Migration failed');
    }

    // Validate migrated data
    const valid = await validateMigratedData(result.data);
    if (!valid) {
      throw new Error('Migrated data validation failed');
    }

    console.log('✓ Migration successful and validated');
    return { success: true, data: result.data };
  } catch (error) {
    console.error('✗ Migration failed, rolling back...');

    // Rollback: migrate back to original version
    const rollbackResult = await migrationEngine.migrate(
      templateId,
      backup, // Use backup data
      to, // From target version
      from // Back to source version
    );

    if (rollbackResult.success) {
      console.log('✓ Rollback successful');
      return { success: false, rolledBack: true, data: backup };
    } else {
      console.error('✗ Rollback failed!');
      throw new Error('Migration and rollback both failed');
    }
  }
}

async function validateMigratedData(data: any): Promise<boolean> {
  // Custom validation logic
  return data && typeof data === 'object';
}
```

**When to use**: High-risk migrations where rollback capability is essential.

---

## Error Handling Patterns

### Pattern 13: Graceful Degradation

**Scenario**: Handle errors gracefully and provide fallback options.

```typescript
async function robustExtraction(missionPath: string) {
  try {
    // Attempt full extraction
    const result = await extractTemplate({
      sourceMissionPath: missionPath,
      author: 'team@company.com',
      confidenceThreshold: 0.7,
    });

    if (result.success) {
      return { status: 'success', template: result.template };
    }

    // Partial failure - try with lower threshold
    console.warn('Full extraction failed, trying with lower threshold...');

    const fallbackResult = await extractTemplate({
      sourceMissionPath: missionPath,
      author: 'team@company.com',
      confidenceThreshold: 0.4,
    });

    if (fallbackResult.success) {
      return {
        status: 'partial',
        template: fallbackResult.template,
        warning: 'Extracted with lower confidence threshold',
      };
    }

    // Total failure - return minimal template
    return {
      status: 'failed',
      template: createMinimalTemplate(missionPath),
      error: fallbackResult.errors?.join(', '),
    };
  } catch (error) {
    console.error('Extraction error:', error);
    return {
      status: 'error',
      template: createMinimalTemplate(missionPath),
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

function createMinimalTemplate(missionPath: string) {
  return {
    metadata: {
      templateId: `fallback-${Date.now()}`,
      name: path.basename(missionPath),
      author: 'auto-generated',
      templateVersion: '0.1.0',
      creationDate: new Date().toISOString(),
      tags: ['fallback'],
      parameters: {},
      usageCount: 0,
      generatedSuccessRate: 0,
    },
    fileStructure: [],
    dependencies: [],
  };
}
```

**When to use**: Production environments where extraction must succeed even with degraded quality.

---

### Pattern 14: Validation Error Recovery

**Scenario**: Handle import validation errors with detailed reporting.

```typescript
async function importWithErrorRecovery(templatePath: string, baseDir: string) {
  const importer = new TemplateImporter(baseDir);

  try {
    const result = await importer.import(path.basename(templatePath), {
      skipSignatureVerification: false,
    });

    if (result.validationReport.valid) {
      console.log('✓ Import successful');
      return { success: true, template: result.template };
    }

    // Validation failed - analyze errors
    console.error('✗ Import validation failed');

    const failedLayers = result.validationReport.layers
      .filter((l) => !l.passed)
      .map((l) => ({ layer: l.layer, name: l.name, details: l.details }));

    console.error('Failed layers:', failedLayers);

    // Check if we can skip signature for internal use
    if (failedLayers.some((l) => l.name.includes('Signature'))) {
      console.warn('⚠ Signature verification failed, retrying without verification...');

      const retryResult = await importer.import(path.basename(templatePath), {
        skipSignatureVerification: true,
      });

      if (retryResult.validationReport.valid) {
        return {
          success: true,
          template: retryResult.template,
          warning: 'Imported without signature verification',
        };
      }
    }

    return {
      success: false,
      errors: result.validationReport.errors,
      failedLayers,
    };
  } catch (error) {
    console.error('Import error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
```

**When to use**: Importing templates from various sources with varying trust levels.

---

## Advanced Patterns

### Pattern 15: Template Pipeline Automation

**Scenario**: Automate the complete lifecycle: extract → version → test → publish.

```typescript
async function automatedTemplatePipeline(missionPath: string, version: string) {
  console.log('Starting template pipeline...\n');

  // 1. Extract
  console.log('Step 1: Extracting template...');
  const extractResult = await extractTemplate({
    sourceMissionPath: missionPath,
    templateName: `Auto-generated from ${path.basename(missionPath)}`,
    author: 'automation@company.com',
  });

  if (!extractResult.success) {
    throw new Error('Extraction failed');
  }
  console.log('✓ Extracted\n');

  // 2. Version
  console.log('Step 2: Registering version...');
  const versionManager = new VersionManager();
  const templateId = extractResult.template!.metadata.templateId;

  versionManager.registerVersion({
    templateId,
    version: versionManager.parseVersion(version),
    releaseDate: new Date().toISOString(),
    changelog: `Automated release from ${missionPath}`,
  });
  console.log(`✓ Registered ${templateId}@${version}\n`);

  // 3. Test (validate template structure)
  console.log('Step 3: Testing template...');
  const testResult = await testTemplate(extractResult.template!);
  if (!testResult.passed) {
    throw new Error(`Tests failed: ${testResult.errors.join(', ')}`);
  }
  console.log('✓ Tests passed\n');

  // 4. Publish (export with signature)
  console.log('Step 4: Publishing template...');
  const exportResult = await exportTemplate({
    template: extractResult.template!,
    outputPath: './published-templates',
    format: 'yaml',
    includeSignature: true,
    keyId: 'automation-key',
    algorithm: 'RS256',
  });
  console.log(`✓ Published to ${exportResult.exportPath}\n`);

  console.log('Pipeline complete!');
  return {
    templateId,
    version,
    publishPath: exportResult.exportPath,
  };
}

async function testTemplate(template: MissionTemplate) {
  const errors = [];

  // Test 1: Has parameters
  if (Object.keys(template.metadata.parameters).length === 0) {
    errors.push('No parameters defined');
  }

  // Test 2: Has files
  if (template.fileStructure.length === 0) {
    errors.push('No files in template');
  }

  // Test 3: Parameters are used in files
  const params = Object.keys(template.metadata.parameters);
  const filesUsingParams = template.fileStructure.filter((f) =>
    params.some((p) => f.content.includes(`{{${p}}}`))
  );

  if (filesUsingParams.length === 0) {
    errors.push('Parameters not used in any files');
  }

  return {
    passed: errors.length === 0,
    errors,
  };
}
```

**When to use**: CI/CD pipelines for automated template generation and publishing.

---

## Summary

These patterns cover common scenarios in the Extension System. Mix and match them to build robust template workflows. Key principles:

- **Always validate**: Use full validation for imports from external sources
- **Version everything**: Track template evolution from the start
- **Handle errors gracefully**: Provide fallbacks and detailed error reporting
- **Test before publishing**: Validate templates before distribution
- **Document assumptions**: Make dependencies and requirements explicit

For more details, see:

- [Extension System Guide](./Extension_System_Guide.md)
- [API Documentation](./API_Documentation.md)
