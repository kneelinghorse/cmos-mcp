#!/usr/bin/env ts-node

/**
 * Minimal scaffold to migrate legacy YAML mission templates into the hybrid XML/JSON format.
 *
 * Usage:
 *   npx ts-node scripts/migrate-yaml-to-hybrid.ts <legacy.yaml> <hybrid.xml>
 *
 * The converter is intentionally conservative. It extracts high-signal fields from the YAML file
 * and emits a standards-compliant hybrid template referencing shared components. Additional
 * enrichment (component selection, schema tuning) can be layered on top of the generated asset.
 */

import { promises as fs } from 'fs';
import path from 'path';
import YAML from 'yaml';

export interface LegacyTemplate {
  schemaType?: string;
  schemaVersion?: string;
  missionId?: string;
  objective?: string;
  context?: Record<string, unknown>;
  successCriteria?: string[];
  deliverables?: string[];
}

function ensureString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function toContextItems(context: Record<string, unknown> | undefined): string {
  if (!context) {
    return '';
  }

  return Object.entries(context)
    .map(([key, value]) => {
      if (value === undefined || value === null) {
        return '';
      }
      const serialized =
        typeof value === 'string' ? value : YAML.stringify(value, { indent: 2 }).trim();
      return `    <Item key="${key}">${serialized}</Item>`;
    })
    .filter(Boolean)
    .join('\n');
}

function toSchema(deliverables: string[] | undefined): string {
  const base = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'MigratedMissionResult',
    type: 'object',
    required: ['summary'],
    properties: {
      summary: { type: 'string', minLength: 10 },
      deliverables: {
        type: 'array',
        items: {
          type: 'string',
        },
        default: deliverables ?? [],
      },
    },
  };

  return JSON.stringify(base, null, 2);
}

export function buildHybridTemplate(
  legacy: LegacyTemplate,
  sourcePath: string,
  componentBase = 'components'
): string {
  const missionId =
    ensureString(legacy.missionId) ?? path.basename(sourcePath, path.extname(sourcePath));
  const objective = ensureString(legacy.objective) ?? 'Define mission objective.';
  const schemaVersion = ensureString(legacy.schemaVersion) ?? '1.0.0';
  const schemaType = ensureString(legacy.schemaType) ?? 'Unknown';

  const contextItems = toContextItems(legacy.context ?? {});
  const deliverables = Array.isArray(legacy.deliverables)
    ? (legacy.deliverables.filter((item): item is string => typeof item === 'string') as string[])
    : undefined;

  const tags = [schemaType.toLowerCase(), 'migrated'];
  const outputSchema = toSchema(deliverables);

  const objectiveCData = objective.replace(/\]\]>/g, ']]]]><![CDATA[>');

  return `<?xml version="1.0" encoding="UTF-8"?>
<MissionTemplate apiVersion="mission-template.v2" kind="HybridMissionTemplate">
  <Metadata>
    <Name>${missionId}</Name>
    <Version>${schemaVersion}</Version>
    <Author>Unknown</Author>
    <Signature>
      <KeyId>migration-placeholder</KeyId>
      <Algorithm>PGP-SHA256</Algorithm>
      <Value>BASE64_SIGNATURE_PLACEHOLDER</Value>
    </Signature>
    <Tags>
      ${tags.map((tag) => `<Tag>${tag}</Tag>`).join('\n      ')}
    </Tags>
  </Metadata>
  <MissionObjective><![CDATA[${objectiveCData}]]></MissionObjective>
  <AgentPersona src="${componentBase}/agent-persona/lead-architect.xml" />
  <Instructions src="${componentBase}/instructions/structured-delivery.xml" />
  <ContextData>
    <Item key="legacySource">${path.relative(process.cwd(), sourcePath)}</Item>
${contextItems}
  </ContextData>
  <Examples>
    <Example name="summary-only">
      <Input><![CDATA[{"context":"${missionId}"}]]></Input>
      <Output><![CDATA[{"summary":"Describe mission outcome."}]]></Output>
    </Example>
  </Examples>
  <OutputSchema><![CDATA[
${outputSchema}
  ]]></OutputSchema>
</MissionTemplate>
`;
}

export async function migrateTemplate(
  legacyPath: string,
  outputPath: string,
  componentBase = 'components'
): Promise<void> {
  const yamlRaw = await fs.readFile(legacyPath, 'utf8');
  const parsed = YAML.parse(yamlRaw) as LegacyTemplate;
  const hybrid = buildHybridTemplate(parsed, path.resolve(legacyPath), componentBase);
  await fs.writeFile(outputPath, hybrid, 'utf8');
}

async function main(): Promise<void> {
  const [, , legacyPath, outputPath] = process.argv;
  if (!legacyPath || !outputPath) {
    // eslint-disable-next-line no-console
    console.error(
      'Usage: npx ts-node scripts/migrate-yaml-to-hybrid.ts <legacy.yaml> <hybrid.xml>'
    );
    process.exitCode = 1;
    return;
  }

  try {
    await migrateTemplate(legacyPath, outputPath);
    // eslint-disable-next-line no-console
    console.log(`Hybrid template written to ${outputPath}`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
