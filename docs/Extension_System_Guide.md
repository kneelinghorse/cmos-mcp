# Extension System User Guide

## Overview

The Mission Protocol v2 Extension System (Phase 3) enables you to extract, share, version, and combine mission templates across projects. This guide covers all Phase 3 capabilities with practical examples.

## Table of Contents

1. [Template Extraction](#template-extraction)
2. [Import & Export](#import--export)
3. [Pack Combination](#pack-combination)
4. [Template Versioning](#template-versioning)
5. [Complete Workflows](#complete-workflows)

---

## Template Extraction

### What is Template Extraction?

Template extraction analyzes a completed mission and automatically generates a reusable template by identifying parameters, file structures, and configuration patterns.

### Basic Usage

```typescript
import { extractTemplate } from './tools/extract-template';

const result = await extractTemplate({
  sourceMissionPath: './missions/customer-api',
  templateName: 'REST API Template',
  author: 'team@example.com',
  description: 'Template for building REST APIs',
});

if (result.success) {
  console.log(`Template extracted: ${result.template.metadata.templateId}`);
  console.log(`Parameters generated: ${result.stage2?.parametersGenerated}`);
}
```

### How It Works

The extraction process has two stages:

**Stage 1: Candidate Identification**

- Analyzes all files in the mission directory
- Identifies literal values that appear multiple times
- Calculates confidence scores based on frequency
- Detects path segments that may be parameterized

**Stage 2: Template Generation**

- Converts high-confidence candidates to parameters
- Replaces literals with Jinja2 placeholders: `{{ parameter_name }}`
- Generates metadata (name, version, tags, usage stats)
- Creates file structure with templated content

### Configuration Options

```typescript
interface ExtractionConfig {
  sourceMissionPath: string; // Path to mission directory
  author: string; // Template author
  templateName?: string; // Optional custom name
  description?: string; // Template description
  confidenceThreshold?: number; // Min confidence (0.0-1.0, default: 0.6)
  excludePatterns?: string[]; // Additional exclude patterns
}
```

### Example: Extract an API Template

```typescript
// 1. Prepare mission directory
const missionPath = './missions/user-service';

// 2. Extract template
const result = await extractTemplate({
  sourceMissionPath: missionPath,
  templateName: 'Microservice API',
  author: 'devops@company.com',
  description: 'Node.js microservice with Express',
  confidenceThreshold: 0.7,
});

// 3. Review results
console.log(`Files analyzed: ${result.stage1?.filesAnalyzed}`);
console.log(`Parameters found: ${result.stage2?.parametersGenerated}`);

// 4. Inspect parameters
result.template?.metadata.parameters.forEach((param, name) => {
  console.log(`${name}: ${param.type} (default: ${param.default})`);
});
```

### Best Practices

✅ **Do:**

- Use descriptive mission directories for better parameter names
- Review generated parameters before sharing
- Set appropriate confidence thresholds (0.6-0.8 recommended)
- Clean up temporary files before extraction

❌ **Don't:**

- Extract from directories with secrets or credentials
- Use extremely low confidence thresholds (<0.3)
- Extract from missions with node_modules or build artifacts

---

## Import & Export

### Security-First Design

The import/export system implements **6 layers of security validation**:

1. **Path Traversal Protection** - Prevents malicious file paths
2. **Safe YAML Parsing** - Blocks code execution via YAML
3. **Schema Validation** - Ensures structural correctness
4. **Signature Verification** - Cryptographic trust validation
5. **Semantic Analysis** - Detects malicious content patterns
6. **Dependency Validation** - Verifies external dependencies

### Exporting Templates

```typescript
import { exportTemplate } from './tools/export-template';

// Export with security signature
const result = await exportTemplate({
  template: myTemplate,
  outputPath: './exports',
  format: 'yaml', // 'yaml' or 'json'
  includeSignature: true,
  keyId: 'company-signing-key-001',
  algorithm: 'RS256',
});

console.log(`Template exported to: ${result.exportPath}`);
```

### Importing Templates

```typescript
import { importTemplate } from './tools/import-template';
import { SecurityValidator } from './import-export/security-validator';

// 1. Register trusted key (one-time setup)
SecurityValidator.registerTrustedKey({
  keyId: 'company-signing-key-001',
  algorithm: 'RS256',
  publicKey: '-----BEGIN PUBLIC KEY-----...',
  owner: 'Company DevOps Team',
  trustLevel: 'verified-internal',
});

// 2. Import template
const result = await importTemplate({
  templatePath: './exports/api-template.yaml',
  baseDir: './exports',
  skipSignatureVerification: false, // Enforce signature check
});

if (result.success) {
  console.log('Import successful');
  console.log('Validation layers passed:', result.validationReport.layers.length);
} else {
  console.error('Import failed:', result.message);
}
```

### Trust Levels

| Trust Level         | Use Case                     | Verification Required |
| ------------------- | ---------------------------- | --------------------- |
| `verified-internal` | Internal team templates      | Yes - Company key     |
| `verified-partner`  | Trusted partner templates    | Yes - Partner key     |
| `community-trusted` | Vetted community templates   | Yes - Community key   |
| `untrusted`         | External, unverified sources | Extra validation      |

### Performance Targets

- **Export**: < 500ms for typical templates
- **Import**: < 1s including full 6-layer validation
- **Large templates**: < 2s for templates with 100+ files

---

## Pack Combination

### What are Domain Packs?

Domain packs are reusable configuration bundles that can be combined to create complex mission templates. They support:

- Dependency resolution
- Conflict handling via merge strategies
- Validation and preview modes

### Basic Combination

```typescript
import { combineP acks } from './tools/combine-packs';

const result = await combinePacks({
  packNames: ['base-api', 'auth-middleware', 'logging'],
  registryPath: './registry.yaml',
  strategy: 'deep-merge',
  resolveDependencies: true
});

if (result.success) {
  console.log('Combined pack created');
  console.log('Load order:', result.loadOrder);
}
```

### Merge Strategies

#### 1. Deep Merge (Default)

Recursively merges objects and concatenates arrays.

```yaml
# Pack A
server:
  port: 3000

# Pack B
server:
  host: "0.0.0.0"

# Result
server:
  port: 3000
  host: "0.0.0.0"
```

#### 2. Override

Last pack wins for conflicting keys.

```yaml
# Pack A
config:
  mode: "dev"

# Pack B
config:
  mode: "prod"

# Result (Pack B overrides)
config:
  mode: "prod"
```

#### 3. Selective

Specify paths to merge vs. override.

```typescript
{
  strategy: 'selective',
  mergePaths: ['middleware', 'plugins'],
  overridePaths: ['config']
}
```

### Dependency Resolution

Packs declare dependencies in their manifest:

```yaml
# auth-middleware/manifest.yaml
name: 'auth-middleware'
version: '1.0.0'
dependencies:
  - name: 'base-api'
    version: '^1.0.0'
```

The resolver:

1. Builds dependency graph
2. Detects circular dependencies
3. Determines load order
4. Validates version compatibility

```typescript
const result = await combinePacks({
  packNames: ['auth-middleware'], // Only specify top-level
  registryPath: './registry.yaml',
  resolveDependencies: true, // Auto-includes base-api
});

console.log(result.loadOrder); // ['base-api', 'auth-middleware']
```

### Preview Mode

Preview combination results without executing:

```typescript
import { PackCombiner } from './combination/pack-combiner';

const combiner = new PackCombiner();
const preview = combiner.preview(packs, availablePacks, {
  resolveDependencies: true,
});

console.log('Load order:', preview.loadOrder);
console.log('Warnings:', preview.warnings);
// Warnings might include:
// - Version mismatches
// - Circular dependencies
// - Missing dependencies
```

---

## Template Versioning

### SemVer Support

All templates use Semantic Versioning (X.Y.Z format):

- **Major (X)**: Breaking changes
- **Minor (Y)**: New features, backwards compatible
- **Patch (Z)**: Bug fixes

### Registering Versions

```typescript
import { registerTemplateVersion } from './tools/version-template';

await registerTemplateVersion({
  templateId: 'api-template',
  version: '2.0.0',
  changelog: 'Breaking: New configuration format',
  compatibleWith: '^2.0.0',
  releaseDate: '2025-01-15T10:00:00Z',
});
```

### Version Compatibility

Check if two versions can work together:

```typescript
import { checkVersionCompatibility } from './tools/version-template';

const result = await checkVersionCompatibility({
  templateId: 'api-template',
  version1: '2.1.0',
  version2: '2.0.0',
});

if (result.compatible) {
  console.log('Versions are compatible');
} else {
  console.log('Incompatible:', result.reason);
  if (result.suggestedUpgrade) {
    console.log(`Upgrade ${result.suggestedUpgrade.from} to ${result.suggestedUpgrade.to}`);
  }
}
```

### Migrations

Define migration paths between versions:

```typescript
import { MigrationEngine, createMigration } from './versioning/migration-engine';

// Define migration
const migration = createMigration({
  id: 'api-v1-to-v2',
  fromVersion: '1.0.0',
  toVersion: '2.0.0',
  description: 'Migrate config format',
  transform: (data) => {
    // Transform v1 config to v2 format
    return {
      ...data,
      config: {
        server: data.serverConfig, // Rename field
        version: 2,
      },
    };
  },
  reversible: false,
});

// Register migration
migrationEngine.registerMigration(migration);

// Find migration path
const path = await findMigrationPath({
  templateId: 'api-template',
  fromVersion: '1.0.0',
  toVersion: '2.0.0',
});

console.log(`Migration requires ${path.steps.length} steps`);
console.log(`Estimated duration: ${path.totalDuration}s`);
console.log(`Reversible: ${path.reversible}`);
```

### Auto-Migration

Execute migrations automatically:

```typescript
const result = await migrationEngine.migrate(
  'api-template',
  oldVersionData,
  parseVersion('1.0.0'),
  parseVersion('2.0.0')
);

if (result.success) {
  console.log('Migration complete');
  console.log('New data:', result.data);
} else {
  console.error('Migration failed:', result.error);
}
```

---

## Complete Workflows

### Workflow 1: Share Template Between Teams

```typescript
// Team A: Extract and export
const extractResult = await extractTemplate({
  sourceMissionPath: './missions/payment-service',
  templateName: 'Payment Service Template',
  author: 'team-a@company.com',
});

const exportResult = await exportTemplate({
  template: extractResult.template,
  outputPath: './shared-templates',
  format: 'yaml',
  includeSignature: true,
  keyId: 'team-a-key',
});

// Share file: ./shared-templates/payment-service-template.yaml

// Team B: Import and use
SecurityValidator.registerTrustedKey({
  keyId: 'team-a-key',
  algorithm: 'RS256',
  publicKey: teamAPublicKey,
  owner: 'Team A',
  trustLevel: 'verified-internal',
});

const importResult = await importTemplate({
  templatePath: './shared-templates/payment-service-template.yaml',
  baseDir: './shared-templates',
});

// Use imported template to create new mission
// ... instantiation logic ...
```

### Workflow 2: Build Composite Template

```typescript
// 1. Combine multiple packs
const combineResult = await combinePacks({
  packNames: ['base-web', 'auth', 'database', 'monitoring'],
  registryPath: './registry.yaml',
  strategy: 'deep-merge',
  resolveDependencies: true,
});

// 2. Version the combined template
await registerTemplateVersion({
  templateId: combineResult.combinedPack.manifest.name,
  version: '1.0.0',
  changelog: 'Initial composite template',
});

// 3. Export for distribution
await exportTemplate({
  template: combineResult.combinedPack,
  outputPath: './dist',
  format: 'yaml',
  includeSignature: true,
  keyId: 'release-key',
});
```

### Workflow 3: Version Upgrade Pipeline

```typescript
// 1. Check current version
const currentVersion = '1.5.0';
const latest = await getLatestVersion({
  templateId: 'api-template',
  includePrerelease: false,
});

console.log(`Current: ${currentVersion}, Latest: ${latest.version}`);

// 2. Check compatibility
const compat = await checkVersionCompatibility({
  templateId: 'api-template',
  version1: latest.version,
  version2: currentVersion,
});

if (!compat.compatible) {
  // 3. Find migration path
  const path = await findMigrationPath({
    templateId: 'api-template',
    fromVersion: currentVersion,
    toVersion: latest.version,
  });

  console.log(`Migration path found with ${path.steps.length} steps`);

  // 4. Execute migration
  const migrateResult = await migrationEngine.migrate(
    'api-template',
    currentData,
    parseVersion(currentVersion),
    parseVersion(latest.version)
  );

  if (migrateResult.success) {
    console.log('Successfully upgraded to', latest.version);
  }
}
```

---

## MCP Tools Reference

All Phase 3 features are available as MCP tools in Claude Desktop:

### Template Tools

- `get_template_extraction` (alias `extract_template`) - Extract template from mission
- `create_template_import` (alias `import_template`) - Import template with validation
- `get_template_export` (alias `export_template`) - Export template with signature

### Combination Tools

- `create_combined_pack` (alias `combine_packs`) - Combine multiple domain packs

### Versioning Tools

- `check_version_compatibility` - Check version compatibility
- `find_migration_path` - Find migration between versions
- `register_template_version` - Register new version
- `get_latest_version` - Get latest template version
- `compare_versions` - Compare two SemVer versions

---

## Troubleshooting

### Import Fails with "Untrusted Signature"

**Cause**: Signing key not registered in trusted keys.

**Solution**:

```typescript
SecurityValidator.registerTrustedKey({
  keyId: 'the-key-id-from-error',
  // ... other fields
});
```

### Circular Dependency Detected

**Cause**: Packs have circular references in dependencies.

**Solution**:

1. Use preview mode to identify the cycle
2. Remove one dependency edge
3. Restructure packs to avoid cycles

### Migration Path Not Found

**Cause**: No registered migrations between versions.

**Solution**:

1. Register missing migrations
2. Consider intermediate versions as stepping stones
3. Check if direct migration is possible

### Template Extraction Generates Too Few Parameters

**Cause**: Confidence threshold too high, or values don't repeat enough.

**Solution**:

```typescript
{
  confidenceThreshold: 0.5; // Lower threshold
}
```

---

## Next Steps

- Review the [API Documentation](./API_Documentation.md) for detailed interfaces
- Explore [Extension Patterns Cookbook](./Extension_Patterns_Cookbook.md) for recipes
- Check [Phase 3 Architecture](./Phase_3_Session_Execution.md) for system design

## Support

For issues or questions:

- File an issue in the project repository
- Contact the Mission Protocol team
- Refer to the API documentation for technical details
