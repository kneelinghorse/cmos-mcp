import * as path from 'path';
import { promises as fs } from 'fs';
import * as YAML from 'yaml';
import Ajv, { AnySchema, ErrorObject } from 'ajv';

type RegistryEntry = {
  name: string;
  description: string;
  path: string;
  version?: string | number;
  schema_version?: string;
};

type RegistryFile = {
  domains: RegistryEntry[];
};

type WorkflowConfig = {
  name: string;
  packs: readonly string[];
  sampleDir: string;
  sampleFiles: Record<string, string>;
};

type Manifest = {
  name?: string;
  version?: string | number;
  displayName?: string;
  description?: string;
  author?: string;
  schema?: string;
};

type PlaceholderPattern = {
  regex: RegExp;
  description: string;
};

const PLACEHOLDER_PATTERNS: PlaceholderPattern[] = [
  { regex: /\bplaceholder\b/i, description: 'should not include the word "placeholder"' },
  {
    regex: /\bLink\s+(to|or)\b/i,
    description: 'should not include instructions like "Link to ..."',
  },
  {
    regex: /\bConcise summary\b/i,
    description: 'should not include descriptive hints like "Concise summary"',
  },
  { regex: /\bAs a\s+\[/i, description: 'should not include format hints like "As a [user]"' },
  { regex: /\bBUG-[A-Z0-9-]+\b/, description: 'should not include sample bug IDs like "BUG-1234"' },
  {
    regex: /\bPRD-[A-Z0-9-]+\b/,
    description: 'should not include sample PRD IDs like "PRD-2024-001"',
  },
];

const MANIFEST_FIELDS = [
  'name',
  'version',
  'displayName',
  'description',
  'author',
  'schema',
] as const;
const MANIFEST_DESCRIPTION_MAX = 200;
const MANIFEST_NAME_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;

const WORKFLOWS: WorkflowConfig[] = [
  {
    name: 'discovery',
    packs: [
      'discovery.opportunity-scan',
      'discovery.problem-definition',
      'discovery.research-orchestrator',
      'discovery.go-no-go-synthesis',
    ],
    sampleDir: path.join('examples', 'discovery-workflow'),
    sampleFiles: {
      'discovery.opportunity-scan': '01_opportunity-scan.sample.yaml',
      'discovery.problem-definition': '02_problem-definition.sample.yaml',
      'discovery.research-orchestrator': '03_research-orchestrator.sample.yaml',
      'discovery.go-no-go-synthesis': '04_go-no-go-synthesis.sample.yaml',
    },
  },
  {
    name: 'engineering',
    packs: [
      'engineering.tdd',
      'engineering.adr',
      'process.design-review',
      'process.code-review',
      'engineering.bug-fix',
    ],
    sampleDir: path.join('examples', 'engineering-workflow'),
    sampleFiles: {
      'engineering.tdd': '01_technical-design.sample.yaml',
      'engineering.adr': '02_architecture-decision.sample.yaml',
      'process.design-review': '03_design-review.sample.yaml',
      'process.code-review': '04_code-review.sample.yaml',
      'engineering.bug-fix': '05_bug-fix.sample.yaml',
    },
  },
  {
    name: 'product',
    packs: ['product.competitive-analysis', 'product.dashboard-blueprint', 'product.prd'],
    sampleDir: path.join('examples', 'product-workflow'),
    sampleFiles: {
      'product.competitive-analysis': '01_competitive-analysis.sample.yaml',
      'product.dashboard-blueprint': '02_dashboard-blueprint.sample.yaml',
      'product.prd': '03_product-requirements.sample.yaml',
    },
  },
];

async function readYaml<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, 'utf8');
  return YAML.parse(content) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function appendPath(parent: string, key: string): string {
  if (!parent) {
    return key;
  }
  if (key.startsWith('[')) {
    return `${parent}${key}`;
  }
  return `${parent}.${key}`;
}

function collectPlaceholderViolations(value: unknown, pathLabel = ''): string[] {
  const issues: string[] = [];

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return issues;
    }

    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (pattern.regex.test(trimmed)) {
        const sample = trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
        const label = pathLabel || '(root)';
        issues.push(
          `has non-standard placeholder content at "${label}": "${sample}" (${pattern.description}).`
        );
        break;
      }
    }
    return issues;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const childPath = appendPath(pathLabel, `[${index}]`);
      issues.push(...collectPlaceholderViolations(item, childPath));
    });
    return issues;
  }

  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      const childPath = appendPath(pathLabel, key);
      issues.push(...collectPlaceholderViolations(nested, childPath));
    }
  }

  return issues;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return 'unknown validation error';
  }
  return errors
    .map((error) => {
      const location =
        error.instancePath && error.instancePath.length > 0 ? error.instancePath : '/';
      const message = error.message ?? 'validation failed';
      return `${location} ${message}`.trim();
    })
    .join('; ');
}

function collectManifestStyleIssues(
  manifestPath: string,
  rawContent: string,
  manifest: Manifest
): string[] {
  const issues: string[] = [];
  const normalizedContent = rawContent.replace(/\r\n/g, '\n');

  for (const field of MANIFEST_FIELDS) {
    const regex = new RegExp(`^${field}:\\s+"(?:[^"\\\\]|\\\\.)+"\\s*$`, 'm');
    if (!regex.test(normalizedContent)) {
      issues.push(
        `field "${field}" must use double-quoted string syntax (e.g. ${field}: "value") in ${manifestPath}.`
      );
    }

    const value = manifest[field as keyof Manifest];
    if (typeof value !== 'string') {
      issues.push(`field "${field}" must be a string.`);
    } else if (!value.trim()) {
      issues.push(`field "${field}" cannot be empty.`);
    }
  }

  const name = typeof manifest.name === 'string' ? manifest.name.trim() : '';
  if (name && !MANIFEST_NAME_PATTERN.test(name)) {
    issues.push(
      `name "${name}" must use lowercase letters, digits, dots, or hyphens (e.g. discovery.research-orchestrator).`
    );
  }

  const version = manifest.version !== undefined ? String(manifest.version).trim() : '';
  if (version && !SEMVER_PATTERN.test(version)) {
    issues.push(`version "${version}" must follow SemVer (e.g. 1.0.0).`);
  }

  const description = typeof manifest.description === 'string' ? manifest.description.trim() : '';
  if (description.length > MANIFEST_DESCRIPTION_MAX) {
    issues.push(
      `description length (${description.length}) exceeds limit of ${MANIFEST_DESCRIPTION_MAX} characters.`
    );
  }

  return issues;
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const templatesDir = path.join(repoRoot, 'templates');
  const registryPath = path.join(templatesDir, 'registry.yaml');
  const errors: string[] = [];
  const notices: string[] = [];

  try {
    await fs.access(registryPath);
  } catch {
    throw new Error(`Missing registry file at ${registryPath}`);
  }

  const registry = await readYaml<RegistryFile>(registryPath);
  const entriesByName = new Map(registry.domains.map((entry) => [entry.name, entry]));
  const seenNames = new Set<string>();
  const seenPaths = new Set<string>();

  for (const entry of registry.domains) {
    const entryName = entry.name?.trim();
    if (!entryName) {
      errors.push('Registry entry is missing a name.');
      continue;
    }

    if (seenNames.has(entryName)) {
      errors.push(`Registry contains duplicate entry name "${entryName}".`);
      continue;
    }
    seenNames.add(entryName);

    const entryPath = entry.path?.trim();
    if (!entryPath) {
      errors.push(`Registry entry "${entryName}" is missing a path.`);
      continue;
    }

    if (seenPaths.has(entryPath)) {
      errors.push(
        `Registry entries share the same path "${entryPath}" (duplicate detected for "${entryName}").`
      );
    } else {
      seenPaths.add(entryPath);
    }

    const packDir = path.join(templatesDir, entryPath);
    let stats;
    try {
      stats = await fs.stat(packDir);
    } catch {
      errors.push(`Registry entry "${entryName}" references missing directory "${packDir}".`);
      continue;
    }

    if (!stats.isDirectory()) {
      errors.push(`Registry entry "${entryName}" path "${packDir}" is not a directory.`);
      continue;
    }

    const manifestPath = path.join(packDir, 'pack.yaml');
    let manifestRaw: string;
    try {
      manifestRaw = await fs.readFile(manifestPath, 'utf8');
    } catch (error) {
      errors.push(
        `Failed to read manifest for "${entryName}" at ${manifestPath}: ${(error as Error).message}`
      );
      continue;
    }

    let manifest: Manifest;
    try {
      manifest = YAML.parse(manifestRaw) as Manifest;
    } catch (error) {
      errors.push(
        `Failed to parse manifest for "${entryName}" at ${manifestPath}: ${(error as Error).message}`
      );
      continue;
    }

    const manifestStyleIssues = collectManifestStyleIssues(manifestPath, manifestRaw, manifest);
    for (const issue of manifestStyleIssues) {
      errors.push(`Manifest style violation for "${entryName}": ${issue}`);
    }

    const manifestName = manifest.name?.trim();
    if (!manifestName) {
      errors.push(`Manifest at ${manifestPath} is missing a name field.`);
    } else if (manifestName !== entryName) {
      errors.push(
        `Manifest name mismatch for ${entryName}: registry="${entryName}", manifest="${manifestName}".`
      );
    }

    const registryDescription = entry.description?.trim() ?? '';
    const manifestDescription = manifest.description?.trim() ?? '';
    if (registryDescription && manifestDescription && registryDescription !== manifestDescription) {
      errors.push(
        `Description mismatch for ${entryName}: registry="${registryDescription}", manifest="${manifestDescription}".`
      );
    } else if (!registryDescription || !manifestDescription) {
      notices.push(`Consider adding descriptions for ${entryName} in both registry and manifest.`);
    }

    const registryVersion = entry.version ? String(entry.version).trim() : '';
    const registrySchemaVersion = entry.schema_version ? String(entry.schema_version).trim() : '';
    const manifestVersion = manifest.version !== undefined ? String(manifest.version).trim() : '';
    if (registryVersion && manifestVersion && registryVersion !== manifestVersion) {
      errors.push(
        `Version mismatch for ${entryName}: registry.version="${registryVersion}", manifest.version="${manifestVersion}".`
      );
    }
    if (registrySchemaVersion && manifestVersion && registrySchemaVersion !== manifestVersion) {
      errors.push(
        `Version mismatch for ${entryName}: registry.schema_version="${registrySchemaVersion}", manifest.version="${manifestVersion}".`
      );
    }
    if (registryVersion && registrySchemaVersion && registryVersion !== registrySchemaVersion) {
      errors.push(
        `Version mismatch for ${entryName}: registry.version="${registryVersion}" does not match registry.schema_version="${registrySchemaVersion}".`
      );
    }

    const schemaFile = manifest.schema?.trim() || 'schema.json';
    const schemaPath = path.join(packDir, schemaFile);
    let schemaContent: string;
    try {
      schemaContent = await fs.readFile(schemaPath, 'utf8');
    } catch {
      errors.push(`Missing schema for ${entryName} at ${schemaPath}.`);
      continue;
    }

    let schema: AnySchema;
    try {
      schema = JSON.parse(schemaContent) as AnySchema;
    } catch (error) {
      errors.push(
        `Failed to parse schema for ${entryName} at ${schemaPath}: ${(error as Error).message}`
      );
      continue;
    }

    const templatePath = path.join(packDir, 'template.yaml');
    let templateContent: string;
    try {
      templateContent = await fs.readFile(templatePath, 'utf8');
    } catch {
      errors.push(`Missing template for ${entryName} at ${templatePath}.`);
      continue;
    }

    let templateData: unknown;
    try {
      templateData = YAML.parse(templateContent);
    } catch (error) {
      errors.push(
        `Failed to parse template for ${entryName} at ${templatePath}: ${(error as Error).message}`
      );
      continue;
    }

    const placeholderIssues = collectPlaceholderViolations(templateData);
    for (const issue of placeholderIssues) {
      errors.push(`Template for ${entryName} ${issue}`);
    }

    try {
      const validator = new Ajv({ allErrors: true, strict: false });
      const validate = validator.compile(schema);
      if (!validate(templateData)) {
        const details = formatAjvErrors(validate.errors);
        errors.push(`Template for ${entryName} failed schema validation: ${details}.`);
      }
    } catch (error) {
      errors.push(`Failed to validate template for ${entryName}: ${(error as Error).message}`);
    }
  }

  for (const workflow of WORKFLOWS) {
    const samplesDir = path.join(repoRoot, workflow.sampleDir);

    for (const packName of workflow.packs) {
      const entry = entriesByName.get(packName);
      if (!entry) {
        errors.push(`Registry is missing ${workflow.name} pack entry for "${packName}".`);
        continue;
      }

      const sampleFile = workflow.sampleFiles[packName];
      const samplePath = path.join(samplesDir, sampleFile);
      try {
        const sample = await readYaml<{ domain?: string; domainFields?: Record<string, unknown> }>(
          samplePath
        );
        if (sample.domain !== packName) {
          errors.push(
            `Sample "${sampleFile}" domain mismatch: expected "${packName}" but found "${sample.domain}".`
          );
        }
        if (!sample.domainFields || Object.keys(sample.domainFields).length === 0) {
          errors.push(`Sample "${sampleFile}" does not include populated domainFields.`);
        }
      } catch (error) {
        errors.push(`Failed to parse sample "${sampleFile}": ${(error as Error).message}`);
      }
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`ERROR: ${error}`);
    }
    throw new Error('Domain pack validation failed.');
  }

  for (const notice of notices) {
    console.warn(`NOTICE: ${notice}`);
  }

  console.log('All workflow domain pack validations passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
