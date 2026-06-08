# Product Workflow Integration

The product domain packs translate discovery insights and engineering decisions into customer-facing narratives, launch plans, and executive storytelling. Sprint 4 Phase 3 completes the trilogy by wiring competitive analysis, dashboard planning, and product requirements into a cohesive workflow.

## Pack Progression

1. **Competitive Analysis** (`product.competitive-analysis`) synthesizes market positioning to anchor product bets.
2. **Dashboard Blueprint** (`product.dashboard-blueprint`) defines the measurement layer leadership needs to steer adoption.
3. **Product Requirements Document** (`product.prd`) captures scope, dependencies, and launch guardrails for execution pods.

The sample missions in `examples/product-workflow/` show how each product artifact references the prior stage so product and intelligence teams stay aligned on context and decisions.

## Validation Guardrails

- Run `npm run test -- tests/smoke/product-domain-packs-smoke.test.ts` to ensure product packs load and the samples populate schema-required fields.
- Run `npm run validate:packs` to confirm the registry metadata stays in sync across discovery, engineering, and product workflows.
- Optional: Execute `npm run lint` after modifications to ensure new samples respect repository linting and formatting rules.
