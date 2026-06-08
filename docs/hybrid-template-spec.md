# Hybrid Mission Template Specification

> Mission B6.1 deliverable: structured XML/JSON mission template format.

## Goals

- Provide deterministic structure for AI agents while preserving human readability.
- Embed JSON Schema contracts directly in mission templates for output validation.
- Support reusable template components with lightweight composition semantics.

## XML Envelope

```xml
<MissionTemplate apiVersion="mission-template.v2" kind="HybridMissionTemplate">
  <Metadata>
    <Name/>
    <Version/>
    <Author/>
    <Signature>
      <KeyId/>
      <Algorithm/>
      <Value/>
    </Signature>
    <Tags>
      <Tag/>
    </Tags>
  </Metadata>
  <MissionObjective/>
  <AgentPersona src="components/..."/>
  <Instructions src="components/..."/>
  <ContextData>
    <Item key="...">...</Item>
  </ContextData>
  <Examples>
    <Example name="...">
      <Input><![CDATA[...]]></Input>
      <Output><![CDATA[...]]></Output>
    </Example>
  </Examples>
  <OutputSchema><![CDATA[{ ...json schema... }]]></OutputSchema>
</MissionTemplate>
```

- `apiVersion` tracks schema evolution (`mission-template.v2`).
- `kind` distinguishes hybrid templates from legacy YAML assets.
- Composition nodes (`AgentPersona`, `Instructions`) support inline or externalised content via `src` attributes.

## Embedded JSON Schema

- `OutputSchema` wraps a Draft-07 compliant JSON Schema inside CDATA for lossless transport.
- Validation extracts the CDATA payload and executes Ajv-based checks against mission output payloads.
- Schema storage remains co-located with mission assets for single-source accuracy.

## Component Library

- Components live under `templates/hybrid/components/` grouped by concern (e.g., `agent-persona`, `instructions`, `context-data`).
- Components are referenced via `src` and resolved relative to the template root by tooling.
- Each component is a valid XML fragment that can be inlined during import for downstream systems without XML include support.
- Catalog coverage spans engineering (delivery personas + default context), product discovery (strategy lead persona, hypothesis checklist, market context), and research intelligence (analyst persona, sprint workflow, lab context).

## Validation Pipeline

1. Parse XML envelope with `fast-xml-parser` using strict mode (no entity expansion).
2. Validate structural requirements (required elements, attribute constraints).
3. Resolve component references and merge XML fragments.
4. Extract JSON Schema payload, parse as JSON, and validate with Ajv.
5. Emit consolidated `HybridMissionTemplate` JSON representation for downstream use.

## Migration Guardrails

- `scripts/migrate-yaml-to-hybrid.ts` (scaffold) will convert legacy YAML templates by mapping YAML keys into XML nodes and carrying JSON Schema payloads forward.
- Migration maintains checksum provenance by hashing original YAML and writing to `<ContextData><Item key="legacyChecksum">...</Item></ContextData>`.
- Rollback support: generated templates preserve the YAML path in `ContextData` so the converter can rehydrate the original YAML document.

## Next Steps

- Extend TemplateImporter to auto-detect XML vs YAML and route through the hybrid parser.
- Flesh out component catalogs per domain pack (product, engineering, research).
- Expand integration tests to validate round-trip conversion and schema enforcement.
