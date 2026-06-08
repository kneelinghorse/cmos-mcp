# Phase 3 API Documentation

Complete API reference for all Mission Protocol v2 Extension System (Phase 3) MCP tools and TypeScript interfaces.

## Table of Contents

1. [MCP Tools](#mcp-tools)
2. [Template Extraction API](#template-extraction-api)
3. [Import/Export API](#importexport-api)
4. [Pack Combination API](#pack-combination-api)
5. [Versioning API](#versioning-api)
6. [Type Definitions](#type-definitions)

---

## MCP Tools

All Phase 3 features are exposed as Model Context Protocol (MCP) tools for use in Claude Desktop and compatible environments.

### get_template_extraction (alias: extract_template)

Extract a reusable template from an existing mission directory.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "sourceMissionPath": {
      "type": "string",
      "description": "Absolute path to the mission directory to extract from"
    },
    "templateName": {
      "type": "string",
      "description": "Human-readable name for the template (optional)"
    },
    "author": {
      "type": "string",
      "description": "Email or identifier of the template author"
    },
    "description": {
      "type": "string",
      "description": "Brief description of the template (optional)"
    },
    "confidenceThreshold": {
      "type": "number",
      "description": "Minimum confidence score for parameter extraction (0.0-1.0, default: 0.6)"
    }
  },
  "required": ["sourceMissionPath", "author"]
}
```

**Response:**

```typescript
{
  success: boolean;
  template?: MissionTemplate;
  stage1?: {
    filesAnalyzed: number;
    candidates: Record<string, Candidate[]>;
    executionTime: number;
  };
  stage2?: {
    parametersGenerated: number;
    filesTemplated: number;
    executionTime: number;
  };
  totalTime: number;
  errors?: string[];
}
```

---

### create_template_import (alias: import_template)

Import and validate a template file with full 6-layer security validation.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "templatePath": {
      "type": "string",
      "description": "Path to the template file (YAML or JSON)"
    },
    "baseDir": {
      "type": "string",
      "description": "Base directory for path resolution"
    },
    "skipSignatureVerification": {
      "type": "boolean",
      "description": "Skip signature verification (not recommended, default: false)"
    },
    "allowUntrusted": {
      "type": "boolean",
      "description": "Allow templates from untrusted sources (default: false)"
    }
  },
  "required": ["templatePath", "baseDir"]
}
```

**Response:**

```typescript
{
  success: boolean;
  template: MissionTemplate;
  validationReport: {
    valid: boolean;
    layers: Array<{
      layer: number;
      name: string;
      passed: boolean;
      details?: string;
    }>;
    errors: string[];
    warnings: string[];
    performanceMs: number;
  };
  message: string;
}
```

---

### get_template_export (alias: export_template)

Export a template with optional cryptographic signature.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "template": {
      "type": "object",
      "description": "The template object to export"
    },
    "outputPath": {
      "type": "string",
      "description": "Directory to write the exported file"
    },
    "format": {
      "type": "string",
      "enum": ["yaml", "json"],
      "description": "Export format (default: yaml)"
    },
    "includeSignature": {
      "type": "boolean",
      "description": "Include cryptographic signature (default: false)"
    },
    "keyId": {
      "type": "string",
      "description": "Signing key identifier (required if includeSignature is true)"
    },
    "algorithm": {
      "type": "string",
      "enum": ["RS256", "ES256"],
      "description": "Signature algorithm (default: RS256)"
    }
  },
  "required": ["template", "outputPath"]
}
```

**Response:**

```typescript
{
  success: boolean;
  exportPath?: string;
  format: 'yaml' | 'json';
  signed: boolean;
  message: string;
}
```

---

### create_combined_pack (alias: combine_packs)

Combine multiple domain packs with dependency resolution.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "packNames": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Names of packs to combine"
    },
    "registryPath": {
      "type": "string",
      "description": "Path to registry.yaml file"
    },
    "strategy": {
      "type": "string",
      "enum": ["deep-merge", "override", "selective"],
      "description": "Merge strategy (default: deep-merge)"
    },
    "resolveDependencies": {
      "type": "boolean",
      "description": "Auto-resolve and include dependencies (default: true)"
    },
    "mergePaths": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Paths to merge (for selective strategy)"
    },
    "overridePaths": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Paths to override (for selective strategy)"
    }
  },
  "required": ["packNames", "registryPath"]
}
```

**Response:**

```typescript
{
  success: boolean;
  combinedPack?: DomainPack;
  loadOrder?: string[];
  warnings?: string[];
  errors?: string[];
  dependencyResolution?: {
    resolved: boolean;
    loadOrder: string[];
    circularDependencies: string[][];
  };
}
```

---

### get_version_compatibility (alias: check_version_compatibility)

Check if two template versions are compatible.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "templateId": {
      "type": "string",
      "description": "Template identifier"
    },
    "version1": {
      "type": "string",
      "description": "First version (SemVer format: X.Y.Z)"
    },
    "version2": {
      "type": "string",
      "description": "Second version (SemVer format: X.Y.Z)"
    }
  },
  "required": ["templateId", "version1", "version2"]
}
```

**Response:**

```typescript
{
  success: boolean;
  compatible: boolean;
  reason?: string;
  suggestedUpgrade?: {
    from: string;
    to: string;
    migrationRequired: boolean;
  };
  message: string;
}
```

---

### get_migration_path (alias: find_migration_path)

Find migration path between two template versions.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "templateId": {
      "type": "string",
      "description": "Template identifier"
    },
    "fromVersion": {
      "type": "string",
      "description": "Source version (SemVer)"
    },
    "toVersion": {
      "type": "string",
      "description": "Target version (SemVer)"
    }
  },
  "required": ["templateId", "fromVersion", "toVersion"]
}
```

**Response:**

```typescript
{
  success: boolean;
  pathFound: boolean;
  path?: {
    from: string;
    to: string;
    steps: Array<{
      id: string;
      fromVersion: string;
      toVersion: string;
      description: string;
      estimatedDuration?: number;
      reversible: boolean;
    }>;
    reversible: boolean;
    totalDuration: number;
  };
  message: string;
}
```

---

### create_template_version (alias: register_template_version)

Register a new template version in the registry.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "templateId": {
      "type": "string",
      "description": "Template identifier"
    },
    "version": {
      "type": "string",
      "description": "Version string (SemVer format: X.Y.Z)"
    },
    "changelog": {
      "type": "string",
      "description": "Human-readable changelog (optional)"
    },
    "compatibleWith": {
      "type": "string",
      "description": "Compatible version range (e.g., '^1.0.0', '~1.2.0') (optional)"
    },
    "releaseDate": {
      "type": "string",
      "description": "ISO 8601 release date (optional, defaults to now)"
    }
  },
  "required": ["templateId", "version"]
}
```

**Response:**

```typescript
{
  success: boolean;
  version?: {
    templateId: string;
    version: string;
    releaseDate: string;
  };
  message: string;
}
```

---

### get_latest_version (alias: get_latest_version)

Get the latest version of a template.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "templateId": {
      "type": "string",
      "description": "Template identifier"
    },
    "includePrerelease": {
      "type": "boolean",
      "description": "Include pre-release versions (e.g., 1.0.0-alpha) (default: false)"
    }
  },
  "required": ["templateId"]
}
```

**Response:**

```typescript
{
  success: boolean;
  version?: {
    templateId: string;
    version: string;
    releaseDate: string;
    deprecated?: boolean;
    deprecationMessage?: string;
  };
  message: string;
}
```

---

### get_version_comparison (alias: compare_versions)

Compare two semantic versions.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "version1": {
      "type": "string",
      "description": "First version (SemVer format: X.Y.Z)"
    },
    "version2": {
      "type": "string",
      "description": "Second version (SemVer format: X.Y.Z)"
    }
  },
  "required": ["version1", "version2"]
}
```

**Response:**

```typescript
{
  success: boolean;
  comparison?: 'less_than' | 'equal' | 'greater_than';
  message: string;
}
```

---

## Template Extraction API

### TemplateExtractor Class

```typescript
class TemplateExtractor {
  constructor(config: ExtractionConfig);

  // Main extraction method
  async extract(): Promise<ExtractionResult>;

  // Stage 1: Identify parameter candidates
  async identifyCandidates(missionPath: string): Promise<Stage1Result>;

  // Stage 2: Generate template from candidates
  async generateTemplate(candidates: Record<string, Candidate[]>): Promise<Stage2Result>;

  // Extract metadata from mission
  extractMetadata(parameters: ParameterMap, missionPath: string): TemplateMetadata;
}
```

### ExtractionConfig

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

### ExtractionResult

```typescript
interface ExtractionResult {
  success: boolean;
  template?: MissionTemplate;
  stage1?: Stage1Result;
  stage2?: Stage2Result;
  totalTime: number;
  errors?: string[];
}

interface Stage1Result {
  filesAnalyzed: number;
  candidates: Record<string, Candidate[]>;
  executionTime: number;
}

interface Stage2Result {
  template: MissionTemplate;
  parametersGenerated: number;
  filesTemplated: number;
  executionTime: number;
}
```

### Candidate

```typescript
interface Candidate {
  value: string | number | boolean;
  type: 'string' | 'number' | 'boolean' | 'path-segment';
  context: string; // Where the value was found
  confidence: number; // 0.0 - 1.0
  frequency: number; // How many times it appears
  locations: string[]; // File paths where found
}
```

---

## Import/Export API

### TemplateImporter Class

```typescript
class TemplateImporter {
  constructor(baseDir: string);

  // Import from file
  async import(filePath: string, options?: ImportOptions): Promise<ImportResult>;

  // Import from string
  async importFromString(yamlContent: string, options?: ImportOptions): Promise<ImportResult>;
}
```

### TemplateExporter Class

```typescript
class TemplateExporter {
  // Export template
  async export(template: MissionTemplate, options: ExportOptions): Promise<ExportResult>;
}
```

### ImportOptions

```typescript
interface ImportOptions {
  skipSignatureVerification?: boolean; // Default: false
  allowUntrusted?: boolean; // Default: false
  maxFileSize?: number; // Max file size in bytes
}
```

### ExportOptions

```typescript
interface ExportOptions {
  outputPath: string; // Output directory
  format?: 'yaml' | 'json'; // Default: 'yaml'
  includeSignature?: boolean; // Default: false
  keyId?: string; // Required if includeSignature
  algorithm?: 'RS256' | 'ES256'; // Default: 'RS256'
}
```

### SecurityValidator

```typescript
class SecurityValidator {
  // Register trusted signing key
  static registerTrustedKey(key: TrustedKey): void;

  // Clear all trusted keys
  static clearTrustedKeys(): void;

  // Validate template
  async validate(template: any, options?: ValidationOptions): Promise<ValidationReport>;
}

interface TrustedKey {
  keyId: string;
  algorithm: string;
  publicKey: string;
  owner: string;
  trustLevel: 'verified-internal' | 'verified-partner' | 'community-trusted' | 'untrusted';
}
```

### ValidationReport

```typescript
interface ValidationReport {
  valid: boolean;
  layers: Array<{
    layer: number;
    name: string;
    passed: boolean;
    details?: string;
  }>;
  errors: string[];
  warnings: string[];
  performanceMs: number;
}
```

---

## Pack Combination API

### PackCombiner Class

```typescript
class PackCombiner {
  // Combine packs
  combine(
    packs: DomainPack[],
    availablePacks: DomainPack[],
    options?: CombinationOptions
  ): CombinationResult;

  // Combine by name
  combineByName(
    packNames: string[],
    availablePacks: DomainPack[],
    options?: CombinationOptions
  ): CombinationResult;

  // Preview combination
  preview(
    packs: DomainPack[],
    availablePacks: DomainPack[],
    options?: CombinationOptions
  ): PreviewResult;
}
```

### DependencyResolver Class

```typescript
class DependencyResolver {
  // Resolve dependencies
  resolve(packs: DomainPack[], availablePacks: DomainPack[]): DependencyResolutionResult;

  // Build dependency graph
  buildGraph(packs: DomainPack[]): DependencyGraph;

  // Topological sort
  topologicalSort(graph: DependencyGraph): string[];

  // Detect cycles
  detectCircularDependencies(graph: DependencyGraph): string[][];
}
```

### CombinationOptions

```typescript
interface CombinationOptions {
  strategy?: CombinationStrategy; // Default: 'deep-merge'
  resolveDependencies?: boolean; // Default: true
  validate?: boolean; // Default: true
  mergePaths?: string[]; // For selective strategy
  overridePaths?: string[]; // For selective strategy
}

type CombinationStrategy = 'deep-merge' | 'override' | 'selective';
```

### CombinationResult

```typescript
interface CombinationResult {
  success: boolean;
  combinedPack?: DomainPack;
  warnings?: string[];
  errors: string[];
  dependencyResolution?: DependencyResolutionResult;
}

interface DependencyResolutionResult {
  resolved: boolean;
  loadOrder: string[];
  circularDependencies: string[][];
  missingDependencies: string[];
}
```

---

## Versioning API

### VersionManager Class

```typescript
class VersionManager {
  constructor(options?: VersionManagerOptions);

  // Version parsing and formatting
  parseVersion(versionString: string): SemanticVersion;
  versionToString(version: SemanticVersion): string;

  // Version comparison
  compareVersions(v1: SemanticVersion, v2: SemanticVersion): VersionComparison;
  satisfiesRange(version: SemanticVersion, range: VersionRange): boolean;

  // Registry management
  registerVersion(templateVersion: TemplateVersion): void;
  getVersion(templateId: string, version: string): TemplateVersion | undefined;
  getLatestVersion(templateId: string, includePrerelease?: boolean): TemplateVersion | undefined;

  // Compatibility checking
  checkCompatibility(v1: TemplateVersion, v2: TemplateVersion): CompatibilityResult;

  // Version resolution
  resolveVersions(requirements: Map<string, VersionRange[]>): VersionResolutionResult;

  // Validation
  validateVersion(templateVersion: TemplateVersion): VersionValidation;
}
```

### MigrationEngine Class

```typescript
class MigrationEngine {
  constructor(versionManager: VersionManager, options?: MigrationOptions);

  // Register migration
  registerMigration(migration: Migration): void;

  // Find migration path
  findMigrationPath(
    templateId: string,
    from: SemanticVersion,
    to: SemanticVersion
  ): MigrationPath | null;

  // Execute migration
  async migrate(
    templateId: string,
    data: any,
    from: SemanticVersion,
    to: SemanticVersion
  ): Promise<MigrationResult>;

  // Validate migration
  validateMigration(migration: Migration): MigrationValidation;
}
```

### SemanticVersion

```typescript
interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
  buildMetadata?: string;
}

enum VersionComparison {
  LESS_THAN = -1,
  EQUAL = 0,
  GREATER_THAN = 1,
}
```

### VersionRange

```typescript
type VersionRange =
  | { expression: string } // '^1.0.0', '~1.2.0', '>=1.5.0'
  | { min: SemanticVersion; max?: SemanticVersion };
```

### Migration

```typescript
interface Migration {
  id: string;
  templateId: string;
  fromVersion: SemanticVersion;
  toVersion: SemanticVersion;
  description: string;
  transform: (data: any) => any | Promise<any>;
  reversible: boolean;
  estimatedDuration?: number; // In seconds
  validate?: (data: any) => boolean;
}

interface MigrationPath {
  from: SemanticVersion;
  to: SemanticVersion;
  steps: Migration[];
  reversible: boolean;
  totalDuration: number;
}

interface MigrationResult {
  success: boolean;
  data?: any;
  error?: string;
  executionTime: number;
}
```

---

## Type Definitions

### MissionTemplate

```typescript
interface MissionTemplate {
  metadata: TemplateMetadata;
  fileStructure: TemplateFile[];
  dependencies?: TemplateDependency[];
}

interface TemplateMetadata {
  templateId: string;
  name: string;
  description?: string;
  author: string;
  templateVersion: string;
  creationDate: string;
  tags: string[];
  parameters: ParameterMap;
  usageCount: number;
  generatedSuccessRate: number;
  signature?: {
    keyId: string;
    algorithm: string;
    value: string;
  };
}

interface TemplateFile {
  path: string;
  content: string;
  encoding?: string;
}

interface TemplateDependency {
  name: string;
  version: string;
  sourceUrl?: string;
  checksum?: string;
}
```

### ParameterMap

```typescript
type ParameterMap = Record<string, Parameter>;

interface Parameter {
  type: 'string' | 'number' | 'boolean';
  description: string;
  default: string | number | boolean;
  required: boolean;
  validation?: {
    pattern?: string;
    min?: number;
    max?: number;
    enum?: (string | number)[];
  };
}
```

### DomainPack

```typescript
interface DomainPack {
  manifest: PackManifest;
  schema: any;
  template: Record<string, any>;
  dependencies?: PackDependency[];
}

interface PackManifest {
  name: string;
  version: string;
  displayName: string;
  description: string;
  author: string;
  schema: string;
  dependencies?: PackDependency[];
  combinedFrom?: string[];
}

interface PackDependency {
  name: string;
  version: string;
}
```

---

## Error Handling

All APIs follow consistent error handling patterns:

### Error Types

```typescript
class ExtractionError extends Error {
  constructor(
    message: string,
    public stage?: 1 | 2
  ) {
    super(message);
  }
}

class ValidationError extends Error {
  constructor(
    message: string,
    public layer?: number,
    public details?: string
  ) {
    super(message);
  }
}

class CombinationError extends Error {
  constructor(
    message: string,
    public conflicts?: string[]
  ) {
    super(message);
  }
}

class InvalidVersionError extends Error {
  constructor(message: string) {
    super(message);
  }
}
```

### Error Response Pattern

```typescript
interface ErrorResponse {
  success: false;
  message: string;
  errorCode?: string;
  details?: any;
}
```

---

## Performance Benchmarks

| Operation                            | Target  | Actual (Typical) |
| ------------------------------------ | ------- | ---------------- |
| Template Extraction (50 files)       | < 15s   | ~8s              |
| Template Export                      | < 500ms | ~200ms           |
| Template Import (6-layer validation) | < 1s    | ~600ms           |
| Pack Combination (3 packs)           | < 500ms | ~250ms           |
| Version Comparison                   | < 10ms  | ~2ms             |
| Migration Path Search                | < 100ms | ~40ms            |
| Migration Execution                  | < 2s    | ~1s              |

---

## Security Considerations

### 6-Layer Validation

All imported templates pass through:

1. **Path Traversal Protection**: Sanitize file paths
2. **Safe YAML Parsing**: Prevent code execution
3. **Schema Validation**: Enforce structure
4. **Signature Verification**: Cryptographic trust
5. **Semantic Analysis**: Detect malicious patterns
6. **Dependency Validation**: Verify external dependencies

### Best Practices

✅ **Always:**

- Verify signatures for external templates
- Use trusted keys only
- Validate version compatibility before migrations
- Review dependency graphs for circularity
- Set appropriate resource limits

❌ **Never:**

- Skip signature verification in production
- Register untrusted keys
- Execute migrations without validation
- Import templates from unknown sources without review

---

## Usage Examples

See the [Extension System Guide](./Extension_System_Guide.md) for comprehensive usage examples and workflows.

## Changelog

### Phase 3 (v2.0.0)

- ✅ Template Extraction (B3.1)
- ✅ Import/Export System with 6-layer security (B3.2)
- ✅ Pack Combination with dependency resolution (B3.3)
- ✅ Template Versioning with SemVer and migrations (B3.4)
- ✅ Integration tests and documentation (B3.5)

---

## Support

For API-related questions:

- Review this documentation
- Check the [User Guide](./Extension_System_Guide.md)
- Refer to the [Cookbook](./Extension_Patterns_Cookbook.md)
- File issues in the project repository
