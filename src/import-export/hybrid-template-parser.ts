import { promises as fs } from 'fs';
import path from 'path';
import Ajv from 'ajv';
import { XMLParser } from 'fast-xml-parser';

export interface HybridTemplateSignature {
  keyId: string;
  algorithm: string;
  value: string;
}

export interface HybridTemplateMetadata {
  name: string;
  version: string;
  author: string;
  signature: HybridTemplateSignature;
  tags: string[];
}

export interface HybridTemplateComponentRef {
  src?: string;
  content?: string;
}

export interface HybridTemplateExample {
  name: string;
  input: string;
  output: string;
}

export interface HybridMissionTemplate {
  apiVersion: string;
  kind: string;
  metadata: HybridTemplateMetadata;
  objective: string;
  agentPersona: HybridTemplateComponentRef;
  instructions: HybridTemplateComponentRef;
  context: Record<string, string>;
  examples: HybridTemplateExample[];
  outputSchema: Record<string, unknown>;
}

export interface HybridTemplateValidationResult {
  valid: boolean;
  errors: string[];
  template?: HybridMissionTemplate;
}

export interface LoadHybridTemplateOptions {
  componentBaseDir?: string;
  resolveComponents?: boolean;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  processEntities: false,
  ignoreDeclaration: true,
});

const ajv = new Ajv({
  strict: false,
  allErrors: true,
});

const OUTPUT_SCHEMA_MAX_BYTES = 64 * 1024; // 64KB
const OUTPUT_SCHEMA_MAX_DEPTH = 16;
const OUTPUT_SCHEMA_MAX_NODES = 2000;
const OUTPUT_SCHEMA_MAX_PROPERTIES = 256;
const OUTPUT_SCHEMA_MAX_ARRAY_ITEMS = 1024;

const DRAFT_07_SCHEMA_IDS = new Set<string>([
  'http://json-schema.org/draft-07/schema#',
  'https://json-schema.org/draft-07/schema#',
  'http://json-schema.org/draft-07/schema',
  'https://json-schema.org/draft-07/schema',
]);

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function extractText(node: unknown): string | undefined {
  if (typeof node === 'string') {
    return node.trim();
  }
  if (node && typeof node === 'object') {
    const candidate = (node as Record<string, unknown>)['#text'];
    if (typeof candidate === 'string') {
      return candidate.trim();
    }
  }
  return undefined;
}

function parseMetadata(node: unknown, errors: string[]): HybridTemplateMetadata | undefined {
  if (!node || typeof node !== 'object') {
    errors.push('Missing <Metadata> block.');
    return undefined;
  }

  const record = node as Record<string, unknown>;
  const name = extractText(record.Name);
  const version = extractText(record.Version);
  const author = extractText(record.Author);

  if (!name) {
    errors.push('Metadata.Name is required.');
  }
  if (!version) {
    errors.push('Metadata.Version is required.');
  }
  if (!author) {
    errors.push('Metadata.Author is required.');
  }

  const signatureNode = record.Signature as Record<string, unknown> | undefined;
  const keyId = signatureNode ? extractText(signatureNode.KeyId) : undefined;
  const algorithm = signatureNode ? extractText(signatureNode.Algorithm) : undefined;
  const value = signatureNode ? extractText(signatureNode.Value) : undefined;

  if (!signatureNode) {
    errors.push('Metadata.Signature block is required.');
  } else {
    if (!keyId) {
      errors.push('Metadata.Signature.KeyId is required.');
    }
    if (!algorithm) {
      errors.push('Metadata.Signature.Algorithm is required.');
    }
    if (!value) {
      errors.push('Metadata.Signature.Value is required.');
    }
  }

  const tagsNode = record.Tags as Record<string, unknown> | undefined;
  const tagsRaw = tagsNode ? asArray(tagsNode.Tag as unknown) : [];
  const tags = tagsRaw.map((tag) => extractText(tag)).filter((tag): tag is string => Boolean(tag));

  if (tags.length === 0) {
    errors.push('At least one Metadata.Tags.Tag entry is required.');
  }

  if (!name || !version || !author || !keyId || !algorithm || !value || tags.length === 0) {
    return undefined;
  }

  return {
    name,
    version,
    author,
    signature: {
      keyId,
      algorithm,
      value,
    },
    tags,
  };
}

function parseComponent(
  node: unknown,
  label: string,
  errors: string[]
): HybridTemplateComponentRef {
  if (!node || typeof node !== 'object') {
    errors.push(`Missing <${label}> block.`);
    return {};
  }

  const record = node as Record<string, unknown>;
  const rawSrc = typeof record['@_src'] === 'string' ? record['@_src'].trim() : undefined;
  const src = rawSrc === '' ? undefined : rawSrc;
  const content = extractText(node);

  if (!src && !content) {
    errors.push(`<${label}> must provide either inline text or a src attribute.`);
  }

  return {
    src,
    content,
  };
}

function parseContext(node: unknown, errors: string[]): Record<string, string> {
  if (!node || typeof node !== 'object') {
    return {};
  }

  const items = asArray((node as Record<string, unknown>).Item as unknown);
  const context: Record<string, string> = {};

  items.forEach((item) => {
    if (!item || typeof item !== 'object') {
      errors.push('ContextData.Item must be an element.');
      return;
    }
    const record = item as Record<string, unknown>;
    const key = typeof record['@_key'] === 'string' ? record['@_key'].trim() : undefined;
    const value = extractText(item);
    if (!key) {
      errors.push('ContextData.Item is missing required key attribute.');
      return;
    }
    context[key] = value ?? '';
  });

  return context;
}

function parseExamples(node: unknown, errors: string[]): HybridTemplateExample[] {
  if (!node || typeof node !== 'object') {
    errors.push('Missing <Examples> block.');
    return [];
  }

  const entries = asArray((node as Record<string, unknown>).Example as unknown);
  if (entries.length === 0) {
    errors.push('Examples must contain at least one <Example>.');
  }

  const examples: HybridTemplateExample[] = [];

  entries.forEach((example) => {
    if (!example || typeof example !== 'object') {
      errors.push('Example entry must be an element.');
      return;
    }
    const record = example as Record<string, unknown>;
    const name = typeof record['@_name'] === 'string' ? record['@_name'].trim() : undefined;
    const input = extractText(record.Input);
    const output = extractText(record.Output);

    if (!name) {
      errors.push('Example is missing required name attribute.');
      return;
    }
    if (!input) {
      errors.push(`Example "${name}" is missing an <Input> payload.`);
    }
    if (!output) {
      errors.push(`Example "${name}" is missing an <Output> payload.`);
    }

    if (name && input && output) {
      examples.push({
        name,
        input,
        output,
      });
    }
  });

  return examples;
}

async function resolveComponentContent(
  component: HybridTemplateComponentRef,
  baseDir?: string
): Promise<void> {
  if (!component.src || !baseDir) {
    return;
  }

  const normalizedBase = path.resolve(baseDir);

  if (path.isAbsolute(component.src)) {
    throw new Error(
      `Component path ${component.src} must be relative to the component base directory.`
    );
  }

  const resolved = path.resolve(normalizedBase, component.src);
  const relative = path.relative(normalizedBase, resolved);

  if (!relative || relative === '') {
    throw new Error(
      `Component path ${component.src} must reference a file within the component base directory.`
    );
  }

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Component path ${component.src} escapes component base directory.`);
  }

  let stats;
  try {
    stats = await fs.lstat(resolved);
  } catch {
    throw new Error(`Component path ${component.src} does not exist.`);
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`Component path ${component.src} cannot reference a symbolic link.`);
  }

  if (!stats.isFile()) {
    throw new Error(`Component path ${component.src} must reference a file.`);
  }

  const content = await fs.readFile(resolved, 'utf8');
  component.content = content.trim();
}

interface SchemaComplexityStats {
  nodeCount: number;
}

function analyzeSchemaComplexity(
  value: unknown,
  depth = 1,
  stats: SchemaComplexityStats = { nodeCount: 0 },
  seen: WeakSet<object> = new WeakSet()
): SchemaComplexityStats {
  if (depth > OUTPUT_SCHEMA_MAX_DEPTH) {
    throw new Error(`maximum depth ${OUTPUT_SCHEMA_MAX_DEPTH} exceeded (observed ${depth})`);
  }

  stats.nodeCount += 1;
  if (stats.nodeCount > OUTPUT_SCHEMA_MAX_NODES) {
    throw new Error(`node count ${stats.nodeCount} exceeds limit ${OUTPUT_SCHEMA_MAX_NODES}`);
  }

  if (typeof value !== 'object' || value === null) {
    return stats;
  }

  const objectValue = value as Record<string, unknown>;
  if (seen.has(objectValue)) {
    return stats;
  }
  seen.add(objectValue);

  if (Array.isArray(value)) {
    if (value.length > OUTPUT_SCHEMA_MAX_ARRAY_ITEMS) {
      throw new Error(
        `array length ${value.length} exceeds limit ${OUTPUT_SCHEMA_MAX_ARRAY_ITEMS}`
      );
    }
    for (const item of value) {
      analyzeSchemaComplexity(item, depth + 1, stats, seen);
    }
    return stats;
  }

  const keys = Object.keys(objectValue);
  if (keys.length > OUTPUT_SCHEMA_MAX_PROPERTIES) {
    throw new Error(
      `object property count ${keys.length} exceeds limit ${OUTPUT_SCHEMA_MAX_PROPERTIES}`
    );
  }

  for (const key of keys) {
    analyzeSchemaComplexity(objectValue[key], depth + 1, stats, seen);
  }

  return stats;
}

function assertDraft7Compliance(schema: Record<string, unknown>): void {
  const schemaIdentifier = schema['$schema'];

  if (typeof schemaIdentifier !== 'string' || schemaIdentifier.trim().length === 0) {
    throw new Error('must declare "$schema": "http://json-schema.org/draft-07/schema#".');
  }

  const normalized = schemaIdentifier.trim();
  if (!DRAFT_07_SCHEMA_IDS.has(normalized)) {
    throw new Error(`must use a Draft-07 "$schema" identifier (received "${normalized}").`);
  }
}

function buildOutputSchema(node: unknown, errors: string[]): Record<string, unknown> | undefined {
  const raw = extractText(node);
  if (!raw) {
    errors.push('OutputSchema must contain a JSON Schema payload.');
    return undefined;
  }

  const sizeInBytes = Buffer.byteLength(raw, 'utf8');
  if (sizeInBytes > OUTPUT_SCHEMA_MAX_BYTES) {
    errors.push(
      `OutputSchema JSON Schema exceeds maximum allowed size of ${OUTPUT_SCHEMA_MAX_BYTES} bytes (received ${sizeInBytes} bytes).`
    );
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw);

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      errors.push('OutputSchema JSON Schema must be a JSON object.');
      return undefined;
    }

    const schemaObject = parsed as Record<string, unknown>;

    try {
      assertDraft7Compliance(schemaObject);
    } catch (complianceError) {
      errors.push(
        `OutputSchema JSON Schema ${complianceError instanceof Error ? complianceError.message : String(complianceError)}`
      );
      return undefined;
    }

    try {
      analyzeSchemaComplexity(schemaObject);
    } catch (complexityError) {
      errors.push(
        `OutputSchema JSON Schema exceeds complexity limits: ${
          complexityError instanceof Error ? complexityError.message : String(complexityError)
        }`
      );
      return undefined;
    }

    ajv.compile(schemaObject);
    return schemaObject;
  } catch (error) {
    errors.push(
      `OutputSchema JSON Schema validation failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
}

export function parseHybridTemplate(xml: string): HybridTemplateValidationResult {
  const errors: string[] = [];
  let document: Record<string, unknown>;

  try {
    document = parser.parse(xml);
  } catch (error) {
    errors.push(`Failed to parse XML: ${error instanceof Error ? error.message : String(error)}`);
    return { valid: false, errors };
  }

  const root = document.MissionTemplate as Record<string, unknown> | undefined;
  if (!root) {
    errors.push('Missing <MissionTemplate> root element.');
    return { valid: false, errors };
  }

  const apiVersion = typeof root['@_apiVersion'] === 'string' ? root['@_apiVersion'] : undefined;
  const kind = typeof root['@_kind'] === 'string' ? root['@_kind'] : undefined;

  if (!apiVersion) {
    errors.push('MissionTemplate.apiVersion attribute is required.');
  }
  if (!kind) {
    errors.push('MissionTemplate.kind attribute is required.');
  }

  const metadata = parseMetadata(root.Metadata, errors);
  const objective = extractText(root.MissionObjective);
  if (!objective) {
    errors.push('MissionObjective content is required.');
  }

  const agentPersona = parseComponent(root.AgentPersona, 'AgentPersona', errors);
  const instructions = parseComponent(root.Instructions, 'Instructions', errors);
  const context = parseContext(root.ContextData, errors);
  const examples = parseExamples(root.Examples, errors);
  const outputSchema = buildOutputSchema(root.OutputSchema, errors);

  const valid = errors.length === 0;
  if (!valid) {
    return { valid: false, errors };
  }

  const template: HybridMissionTemplate = {
    apiVersion: apiVersion as string,
    kind: kind as string,
    metadata: metadata as HybridTemplateMetadata,
    objective: objective as string,
    agentPersona,
    instructions,
    context,
    examples,
    outputSchema: outputSchema as Record<string, unknown>,
  };

  return {
    valid: true,
    errors: [],
    template,
  };
}

export async function loadHybridTemplate(
  filePath: string,
  options?: LoadHybridTemplateOptions
): Promise<HybridTemplateValidationResult> {
  const xml = await fs.readFile(filePath, 'utf8');
  const result = parseHybridTemplate(xml);
  if (!result.valid || !result.template) {
    return result;
  }

  if (options?.resolveComponents !== false) {
    const baseDir = options?.componentBaseDir ?? path.dirname(filePath);
    await Promise.all([
      resolveComponentContent(result.template.agentPersona, baseDir),
      resolveComponentContent(result.template.instructions, baseDir),
    ]);
  }

  return result;
}
