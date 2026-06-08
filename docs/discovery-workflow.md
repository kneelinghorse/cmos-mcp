# Discovery Workflow Integration

The discovery domain packs establish a guided progression from initial signal collection to an executive go/no-go decision. Sprint 4 Phase 1 integrates the four core packs and provides a single workflow that other teams can reuse.

## Pack Progression

1. **Opportunity Scan** (`discovery.opportunity-scan`) captures the initial signal and determines whether to continue.
2. **Problem Definition** (`discovery.problem-definition`) translates validated signals into a precise problem statement with evidence.
3. **Research Orchestrator** (`discovery.research-orchestrator`) coordinates five research lenses and resolves conflicting findings.
4. **Go/No-Go Synthesis** (`discovery.go-no-go-synthesis`) aggregates research outputs, scores each lens, and records the final decision.

The sample missions under `examples/discovery-workflow/` show how data flows from one stage to the next. Each mission is linked to the previous stage through dependencies and shared evidence references.

## Validation Guardrails

- Run `npm run test -- tests/smoke/discovery-domain-packs-smoke.test.ts` to ensure the discovery packs are loadable and the samples parse correctly.
- Run `npm run validate:packs` to confirm registry metadata and discovery samples stay aligned with the registered packs.
