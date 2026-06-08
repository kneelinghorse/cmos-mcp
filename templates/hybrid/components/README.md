# Hybrid Component Catalog

Reusable fragments for hybrid mission templates live in this directory. Components are referenced via the `<AgentPersona src="..."/>`, `<Instructions src="..."/>`, and `<ContextData src="..."/>` nodes in hybrid XML templates. Paths are resolved relative to the template that declares them, so reference files with `components/<category>/<file>.xml`.

## Quick Usage

```xml
<AgentPersona src="components/agent-persona/lead-architect.xml"/>
<Instructions src="components/instructions/structured-delivery.xml"/>
<ContextData src="components/context-data/engineering-default.xml"/>
```

- Import personas and instructions in any mission template under `templates/hybrid/`.
- Combine components freely; the bundles below capture recommended pairings.
- Keep `src` attributes pointing at existing files—validation will fail if a referenced fragment is missing.

## Recommended Bundles

- **Engineering Delivery**
  - Persona: `agent-persona/lead-architect.xml`
  - Instructions: `instructions/structured-delivery.xml`
  - Context: `context-data/engineering-default.xml`
  - Use for: structured implementation or validation-focused execution missions.
- **Product Discovery**
  - Persona: `agent-persona/product-strategist.xml`
  - Instructions: `instructions/product-discovery.xml`
  - Context: `context-data/product-discovery.xml`
  - Use for: framing opportunities, aligning stakeholders, and planning experiments.
- **Research Intelligence**
  - Persona: `agent-persona/research-analyst.xml`
  - Instructions: `instructions/research-sprint.xml`
  - Context: `context-data/research-lab.xml`
  - Use for: evidence gathering, comparative studies, and insight synthesis.

## Component Reference

### Agent Personas (`components/agent-persona/`)

| File | Focus | Highlights |
| --- | --- | --- |
| `lead-architect.xml` | Engineering delivery | Analytical tone, emphasises validation readiness and schema completeness. |
| `product-strategist.xml` | Product discovery | Outcome-oriented tone, balances research signals with roadmap decisions. |
| `research-analyst.xml` | Research intelligence | Investigative tone, prompts conflict surfacing and follow-up experiments. |

### Instruction Sets (`components/instructions/`)

| File | Flow | Highlights |
| --- | --- | --- |
| `structured-delivery.xml` | Hybrid mission delivery | Enforces validation checkpoints and checklist-driven execution. |
| `product-discovery.xml` | Discovery workflow | Guides hypothesis framing, experiment planning, and artefact capture. |
| `research-sprint.xml` | Research sprint | Focuses on evidence pipelines, contributor roles, and findings reporting. |

### Context Payloads (`components/context-data/`)

| File | Domain | Highlights |
| --- | --- | --- |
| `engineering-default.xml` | Engineering | Monorepo environment, quality gate expectations, and escalation contacts. |
| `product-discovery.xml` | Product | Target segment, research cadence, and decision ownership metadata. |
| `research-lab.xml` | Research | Lab identity, evidence vault path, and review cadence. |

## Extending the Catalog

1. Duplicate the most relevant component and adjust the payload (maintain well-formed XML).
2. Add the new file under the matching category directory (e.g., `agent-persona/`).
3. Update this catalog with the new component description and recommended bundle if applicable.
4. Reference the component from a hybrid template and run `npm test -- tests/import-export/hybrid-template-parser.test.ts` (or the full CI suite) to confirm validation continues to pass.
