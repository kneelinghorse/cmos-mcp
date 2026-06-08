import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  loadHybridTemplate,
  parseHybridTemplate,
} from '../../src/import-export/hybrid-template-parser';

const fixturesDir = path.resolve(__dirname, '../../templates/hybrid');
const sampleTemplatePath = path.join(fixturesDir, 'sample-mission.xml');

describe('hybrid-template-parser', () => {
  it('loads and validates the sample hybrid mission template', async () => {
    const result = await loadHybridTemplate(sampleTemplatePath);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.template).toBeDefined();

    const template = result.template!;
    expect(template.apiVersion).toBe('mission-template.v2');
    expect(template.kind).toBe('HybridMissionTemplate');
    expect(template.metadata.name).toBe('Structured Mission Template POC');
    expect(template.metadata.tags).toEqual(['hybrid', 'example']);
    expect(template.agentPersona.src).toBe('components/agent-persona/lead-architect.xml');
    expect(template.agentPersona.content).toContain('<AgentPersona>');
    expect(template.instructions.src).toBe('components/instructions/structured-delivery.xml');
    expect(template.instructions.content).toContain('<Instructions>');
    expect(template.context.domain).toBe('intelligence');

    const outputSchema = template.outputSchema as { title?: string; required?: string[] };
    expect(outputSchema.title).toBe('StructuredMissionResult');
    expect(outputSchema.required).toContain('summary');
  });

  it('reports a missing OutputSchema payload', async () => {
    const xml = await fs.readFile(sampleTemplatePath, 'utf8');
    const missingSchemaXml = xml.replace(
      /<OutputSchema>[\s\S]*<\/OutputSchema>/,
      '<OutputSchema></OutputSchema>'
    );

    const result = parseHybridTemplate(missingSchemaXml);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('OutputSchema must contain a JSON Schema payload.');
  });

  it('reports malformed JSON Schema content', async () => {
    const xml = await fs.readFile(sampleTemplatePath, 'utf8');
    const malformedSchemaXml = xml.replace(
      /<OutputSchema><!\[CDATA\[[\s\S]*?\]\]><\/OutputSchema>/,
      '<OutputSchema><![CDATA[{"$schema":"http://json-schema.org/draft-07/schema#","title": "Broken",]]></OutputSchema>'
    );

    const result = parseHybridTemplate(malformedSchemaXml);

    expect(result.valid).toBe(false);
    expect(
      result.errors.find((message) =>
        message.includes('OutputSchema JSON Schema validation failed')
      )
    ).toBeDefined();
  });

  it('rejects oversized OutputSchema payloads', async () => {
    const xml = await fs.readFile(sampleTemplatePath, 'utf8');
    const largeSchema = JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      description: 'a'.repeat(70_000),
    });
    const oversizedSchemaXml = xml.replace(
      /<OutputSchema>[\s\S]*<\/OutputSchema>/,
      `<OutputSchema><![CDATA[${largeSchema}]]></OutputSchema>`
    );

    const result = parseHybridTemplate(oversizedSchemaXml);

    expect(result.valid).toBe(false);
    expect(
      result.errors.find((message) =>
        message.includes('OutputSchema JSON Schema exceeds maximum allowed size')
      )
    ).toBeDefined();
  });

  it('enforces Draft-07 compliance for OutputSchema payloads', async () => {
    const xml = await fs.readFile(sampleTemplatePath, 'utf8');
    const missingDialectXml = xml.replace(
      /<OutputSchema>[\s\S]*<\/OutputSchema>/,
      '<OutputSchema><![CDATA[{"type":"object"}]]></OutputSchema>'
    );

    const result = parseHybridTemplate(missingDialectXml);

    expect(result.valid).toBe(false);
    expect(
      result.errors.find((message) =>
        message.includes('OutputSchema JSON Schema must declare "$schema"')
      )
    ).toBeDefined();
  });

  it('rejects OutputSchema payloads that exceed complexity thresholds', async () => {
    const xml = await fs.readFile(sampleTemplatePath, 'utf8');
    const deepSchema: Record<string, unknown> = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
    };

    let cursor: Record<string, unknown> = deepSchema;
    for (let depth = 0; depth < 20; depth += 1) {
      const child: Record<string, unknown> = { type: 'object' };
      cursor['properties'] = { [`level${depth}`]: child };
      cursor['required'] = [`level${depth}`];
      cursor = child;
    }
    cursor['type'] = 'string';

    const deepSchemaJson = JSON.stringify(deepSchema);
    const deepSchemaXml = xml.replace(
      /<OutputSchema>[\s\S]*<\/OutputSchema>/,
      `<OutputSchema><![CDATA[${deepSchemaJson}]]></OutputSchema>`
    );

    const result = parseHybridTemplate(deepSchemaXml);

    expect(result.valid).toBe(false);
    expect(
      result.errors.find((message) =>
        message.includes('OutputSchema JSON Schema exceeds complexity limits')
      )
    ).toBeDefined();
  });

  it('rejects OutputSchema payloads with oversized arrays', async () => {
    const xml = await fs.readFile(sampleTemplatePath, 'utf8');
    const largeEnumSchema = JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'string',
      enum: Array.from({ length: 1025 }, (_, index) => `value-${index}`),
    });

    const oversizedArrayXml = xml.replace(
      /<OutputSchema>[\s\S]*<\/OutputSchema>/,
      `<OutputSchema><![CDATA[${largeEnumSchema}]]></OutputSchema>`
    );

    const result = parseHybridTemplate(oversizedArrayXml);

    expect(result.valid).toBe(false);
    expect(
      result.errors.find((message) =>
        message.includes('OutputSchema JSON Schema exceeds complexity limits')
      )
    ).toBeDefined();
  });

  it('rejects OutputSchema payloads with excessive object properties', async () => {
    const xml = await fs.readFile(sampleTemplatePath, 'utf8');
    const propertyKeys = Array.from({ length: 300 }, (_, index) => `field_${index}`);
    const largePropertiesSchema = JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: propertyKeys.reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = { type: 'string' };
        return acc;
      }, {}),
    });

    const oversizedPropertiesXml = xml.replace(
      /<OutputSchema>[\s\S]*<\/OutputSchema>/,
      `<OutputSchema><![CDATA[${largePropertiesSchema}]]></OutputSchema>`
    );

    const result = parseHybridTemplate(oversizedPropertiesXml);

    expect(result.valid).toBe(false);
    expect(
      result.errors.find((message) =>
        message.includes('OutputSchema JSON Schema exceeds complexity limits')
      )
    ).toBeDefined();
  });

  it('rejects OutputSchema payloads that are not objects', async () => {
    const xml = await fs.readFile(sampleTemplatePath, 'utf8');
    const arraySchema = JSON.stringify([
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'string',
      },
    ]);

    const arraySchemaXml = xml.replace(
      /<OutputSchema>[\s\S]*<\/OutputSchema>/,
      `<OutputSchema><![CDATA[${arraySchema}]]></OutputSchema>`
    );

    const result = parseHybridTemplate(arraySchemaXml);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('OutputSchema JSON Schema must be a JSON object.');
  });

  it('rejects OutputSchema payloads with unsupported $schema identifiers', async () => {
    const xml = await fs.readFile(sampleTemplatePath, 'utf8');
    const invalidDialectSchema = JSON.stringify({
      $schema: 'http://json-schema.org/draft-06/schema#',
      type: 'object',
    });

    const invalidDialectXml = xml.replace(
      /<OutputSchema>[\s\S]*<\/OutputSchema>/,
      `<OutputSchema><![CDATA[${invalidDialectSchema}]]></OutputSchema>`
    );

    const result = parseHybridTemplate(invalidDialectXml);

    expect(result.valid).toBe(false);
    expect(
      result.errors.find((message) => message.includes('must use a Draft-07 "$schema" identifier'))
    ).toBeDefined();
  });

  it('flags structural issues when required metadata is missing', () => {
    const invalidXml = `
      <MissionTemplate apiVersion="mission-template.v2" kind="HybridMissionTemplate">
        <Metadata>
          <Name></Name>
          <Signature>
            <KeyId></KeyId>
            <Algorithm></Algorithm>
            <Value></Value>
          </Signature>
          <Tags></Tags>
        </Metadata>
        <MissionObjective></MissionObjective>
        <AgentPersona src="components/agent-persona/lead-architect.xml" />
        <Instructions src="components/instructions/structured-delivery.xml" />
        <ContextData />
        <Examples></Examples>
        <OutputSchema><![CDATA[{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}]]></OutputSchema>
      </MissionTemplate>
    `;

    const result = parseHybridTemplate(invalidXml);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'Metadata.Name is required.',
        'Metadata.Version is required.',
        'Metadata.Author is required.',
        'Metadata.Signature.KeyId is required.',
        'Metadata.Signature.Algorithm is required.',
        'Metadata.Signature.Value is required.',
        'At least one Metadata.Tags.Tag entry is required.',
        'MissionObjective content is required.',
        'Missing <Examples> block.',
      ])
    );
  });

  it('skips component resolution when disabled', async () => {
    const result = await loadHybridTemplate(sampleTemplatePath, {
      resolveComponents: false,
    });

    expect(result.valid).toBe(true);
    expect(result.template?.agentPersona.content).toBeUndefined();
    expect(result.template?.instructions.content).toBeUndefined();
  });

  it('reports missing component payloads', () => {
    const xml = `
      <MissionTemplate apiVersion="mission-template.v2" kind="HybridMissionTemplate">
        <Metadata>
          <Name>component-check</Name>
          <Version>1.0.0</Version>
          <Author>test@example.com</Author>
          <Signature>
            <KeyId>key</KeyId>
            <Algorithm>PGP-SHA256</Algorithm>
            <Value>sig</Value>
          </Signature>
          <Tags>
            <Tag>hybrid</Tag>
          </Tags>
        </Metadata>
        <MissionObjective>Check components</MissionObjective>
        <AgentPersona role="observer"></AgentPersona>
        <Instructions src="components/instructions/structured-delivery.xml" />
        <ContextData>
          <Item key="domain">testing</Item>
        </ContextData>
        <Examples>
          <Example name="baseline">
            <Input><![CDATA[{"prompt":"test"}]]></Input>
            <Output><![CDATA[{"summary":"ok"}]]></Output>
          </Example>
        </Examples>
        <OutputSchema><![CDATA[{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}]]></OutputSchema>
      </MissionTemplate>
    `;

    const result = parseHybridTemplate(xml);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      '<AgentPersona> must provide either inline text or a src attribute.'
    );
  });

  it('flags context items missing key attributes', () => {
    const xml = `
      <MissionTemplate apiVersion="mission-template.v2" kind="HybridMissionTemplate">
        <Metadata>
          <Name>context-check</Name>
          <Version>1.0.0</Version>
          <Author>test@example.com</Author>
          <Signature>
            <KeyId>key</KeyId>
            <Algorithm>PGP-SHA256</Algorithm>
            <Value>sig</Value>
          </Signature>
          <Tags>
            <Tag>hybrid</Tag>
          </Tags>
        </Metadata>
        <MissionObjective>Check context</MissionObjective>
        <AgentPersona src="components/agent-persona/lead-architect.xml" />
        <Instructions src="components/instructions/structured-delivery.xml" />
        <ContextData>
          <Item label="invalid">value</Item>
        </ContextData>
        <Examples>
          <Example name="baseline">
            <Input><![CDATA[{"prompt":"test"}]]></Input>
            <Output><![CDATA[{"summary":"ok"}]]></Output>
          </Example>
        </Examples>
        <OutputSchema><![CDATA[{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}]]></OutputSchema>
      </MissionTemplate>
    `;

    const result = parseHybridTemplate(xml);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('ContextData.Item is missing required key attribute.');
  });

  it('rejects component src paths outside the component base directory', async () => {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-escape-'));
    const templatePath = path.join(sandbox, 'escape.xml');

    const xml = `
      <MissionTemplate apiVersion="mission-template.v2" kind="HybridMissionTemplate">
        <Metadata>
          <Name>escape-guard</Name>
          <Version>1.0.0</Version>
          <Author>test@example.com</Author>
          <Signature>
            <KeyId>key</KeyId>
            <Algorithm>PGP-SHA256</Algorithm>
            <Value>sig</Value>
          </Signature>
          <Tags>
            <Tag>hybrid</Tag>
          </Tags>
        </Metadata>
        <MissionObjective>Ensure path traversal is blocked</MissionObjective>
        <AgentPersona src="../outside.xml" />
        <Instructions mode="inline">Inline instructions</Instructions>
        <ContextData>
          <Item key="domain">testing</Item>
        </ContextData>
        <Examples>
          <Example name="baseline">
            <Input><![CDATA[{"prompt":"test"}]]></Input>
            <Output><![CDATA[{"summary":"ok"}]]></Output>
          </Example>
        </Examples>
        <OutputSchema><![CDATA[{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}]]></OutputSchema>
      </MissionTemplate>
    `;

    try {
      await fs.writeFile(templatePath, xml);
      await expect(loadHybridTemplate(templatePath)).rejects.toThrow(
        'Component path ../outside.xml escapes component base directory.'
      );
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  });

  it('rejects component src paths that do not resolve to a file', async () => {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-missing-'));
    const templatePath = path.join(sandbox, 'missing.xml');

    const xml = `
      <MissionTemplate apiVersion="mission-template.v2" kind="HybridMissionTemplate">
        <Metadata>
          <Name>missing-component</Name>
          <Version>1.0.0</Version>
          <Author>test@example.com</Author>
          <Signature>
            <KeyId>key</KeyId>
            <Algorithm>PGP-SHA256</Algorithm>
            <Value>sig</Value>
          </Signature>
          <Tags>
            <Tag>hybrid</Tag>
          </Tags>
        </Metadata>
        <MissionObjective>Ensure component existence validation</MissionObjective>
        <AgentPersona src="components/missing-agent.xml" />
        <Instructions mode="inline">Inline instructions</Instructions>
        <ContextData>
          <Item key="domain">testing</Item>
        </ContextData>
        <Examples>
          <Example name="baseline">
            <Input><![CDATA[{"prompt":"test"}]]></Input>
            <Output><![CDATA[{"summary":"ok"}]]></Output>
          </Example>
        </Examples>
        <OutputSchema><![CDATA[{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}]]></OutputSchema>
      </MissionTemplate>
    `;

    try {
      await fs.writeFile(templatePath, xml);
      await expect(loadHybridTemplate(templatePath)).rejects.toThrow(
        'Component path components/missing-agent.xml does not exist.'
      );
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  });
});
