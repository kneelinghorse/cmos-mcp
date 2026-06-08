# Template Runtime Store

This directory contains the canonical mission templates for the Mission Protocol system.

## Contents

### Core Templates

- **registry.yaml** - Central registry of all available domain packs
- **generic_mission.yaml** - Universal mission template following the ICEV pattern (Intent-Context-Execution-Verification)
- **hybrid/** - Structured XML/JSON mission templates, reusable components, and validation assets introduced in Sprint 6 (B6.1)

### Domain Packs

All domain packs are located in the `packs/` directory. Each pack contains:
- `pack.yaml` - Manifest with metadata and version information
- `schema.json` - JSON Schema defining the structure of domain-specific fields
- `template.yaml` - Default template with placeholder values

#### Available Domain Packs

1. **foundation** (v1.0.0)
   - Core infrastructure and governance baseline
   - Fields: governanceChecklist, stakeholders

2. **software.technical-task** (v1.0.0)
   - Software development missions
   - Fields: userStory, technicalApproach, nonFunctionalRequirements, outOfScope

3. **business.market-research** (v1.0.0)
   - Business analysis and market research
   - Fields: stakeholders, keyMetrics, dataSources, researchSummary

4. **build.implementation** (v1.0.0)
   - Technical implementation and development builds
   - Fields: type, implementationSteps, technicalDependencies, testingStrategy, rollbackPlan

5. **build.technical-research** (v1.0.0)
   - Technical research and architectural investigation
   - Fields: type, researchObjectives, technologiesUnderInvestigation, evaluationCriteria, prototypeRequirements

- The registry also includes discovery sequencing packs (`discovery.*`), engineering workflows (`engineering.*`, `process.*`, `qa.bug-report`), product strategy templates (`product.*`, `market.customer-development`, `design.ux-research-summary`), research scaffolds (`research.general` now pattern-driven with PRD/SRD alignment and handoff checklists), and architecture handoffs (`build.architecture-mission`). Run `mission-protocol get_available_domains` (alias `list_available_domains`) to view every pack name and description.

### Hybrid XML/JSON Format

- `hybrid/sample-mission.xml` demonstrates the hybrid specification with component references and an embedded JSON Schema `<OutputSchema>` block.
- `hybrid/components/` houses reusable fragments (personas, instructions, context payloads) referenced via `src` attributes. See `hybrid/components/README.md` for the catalog and recommended bundles.
- Hybrid templates target the `mission-template.v2` API surface, enabling semantic XML tags with strict JSON Schema output contracts.
- Validation utilities and migration helpers live under `src/import-export/hybrid-template-parser.ts` with accompanying tests in `tests/import-export/hybrid-template-parser.test.ts`.
- Component catalog coverage now includes engineering (`agent-persona/lead-architect.xml`, `context-data/engineering-default.xml`), product (`agent-persona/product-strategist.xml`, `instructions/product-discovery.xml`, `context-data/product-discovery.xml`), and research workflows (`agent-persona/research-analyst.xml`, `instructions/research-sprint.xml`, `context-data/research-lab.xml`).

## Provenance

These templates were restored in Sprint 1 (B1.1) based on:
- Architectural specifications from `cmos/research/r1.1_The_Universal_Mission_Framework.md`
- Design patterns from `cmos/research/r1.2_Architectural_Design_Specification.md`
- Domain pack authoring guidelines from `docs/domain-pack-authoring.md`

All templates validate against their respective schemas and successfully load through the `DomainPackLoader`.

## Verification

Run the smoke test to verify template integrity:

```bash
npm test -- tests/integration/template-runtime-store.test.ts
```

## Usage

Templates are loaded automatically by the MCP server at initialization. They can be accessed via:
- `get_available_domains` (alias `list_available_domains`) - List all registered domain packs
- `create_mission` - Create a new mission using a domain pack

## Maintenance

When adding new domain packs:
1. Create directory in `packs/`
2. Add `pack.yaml`, `schema.json`, and `template.yaml`
3. Register in `registry.yaml`
4. Author at least one sample mission (under `cmos/missions/`) that exercises the pack
5. Add automated validation (unit test or smoke test) that loads the pack and checks schema compliance
6. Update `cmos/missions/backlog.yaml` or sprint plans if the pack introduces new missions
7. Run smoke tests (`npm test -- tests/integration/template-runtime-store.test.ts`) to verify
8. Update this README and other relevant docs
9. Follow the `docs/pack-manifest-style-guide.md` rules and run `npm run validate:packs` to confirm manifest formatting.

### Domain Pack Addition Checklist

When incorporating new domain packs introduced during active development:

- Confirm `pack.yaml`, `template.yaml`, and `schema.json` share the same `name`, `displayName`, and versioning.
- Add the pack to `templates/registry.yaml` and ensure `get_available_domains` surfaces it.
- Create a sample mission (Build.Implementation or Planning format) demonstrating how to use the pack.
- Add or update automated tests (e.g., `tests/domains/` or integration suites) so the pack is exercised in CI.
- Document the addition in sprint backlog or roadmap notes, and include any dependencies or prerequisites.
- Run `npm run validate:packs` (if available) or future validation scripts to confirm coverage and metadata consistency.
- Update documentation references (README, guides) so mission authors can discover and apply the new pack.
- Review `docs/versioning-contract.md` for version alignment expectations and migration workflow before publishing.

### Placeholder Conventions

- Strings that require author input should default to an empty string (`""`) unless an enum mandates a specific value.
- Arrays should default to `[]`; when a schema enforces `minItems`, populate entries with empty strings (`""`) to satisfy the constraint while signalling required author input.
- Optional objects can default to `null` where appropriate (none currently require this).
- Avoid textual hints such as "Link to ...", "Concise summary ...", or sample IDs like `BUG-1234`—`npm run validate:packs` enforces these standards.
