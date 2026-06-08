# Author Onboarding Guide

Welcome to Mission Protocol v2. This guide gives mission authors a practical path from first-run setup to advanced intelligence tooling. Use it as the canonical onboarding reference for Sprint 5 and beyond.

## Quick Start Checklist

1. **Install & build**
   ```bash
   npm install
   npm run build
   ```
2. **Verify the workspace** – Run `npm test` to confirm the full 803-test suite.
3. **List available domain packs**
   ```bash
   npx mission-protocol list_available_domains
   ```
4. **Create your first mission** – For example:
   ```bash
   npx mission-protocol create_mission \
     --domain foundation \
     --output missions/examples/foundation-kickoff.yaml
   ```
5. **Score mission quality**
   ```bash
   npx mission-protocol get_mission_quality_score \
     --mission missions/examples/foundation-kickoff.yaml
   ```
6. **Run dependency intelligence**
   ```bash
   npx mission-protocol get_dependency_analysis \
     --mission missions/examples/foundation-kickoff.yaml
   ```
7. **Publish outcomes artifacts**
   ```bash
   npm run outcomes
   ```

## Agentic Workspace Checklist

The Sprint 8 upgrades add persistent agent memory and agentic orchestration guardrails. Before creating or updating missions, make sure every workspace satisfies the following:

1. **agents.md present and structured** – Keep the project playbook at `./agents.md` with, at minimum, the `Project Overview`, `Build & Development Commands`, and `AI Agent Specific Instructions` sections from the canonical template.
2. **PROJECT_CONTEXT tracking** – Ensure `cmos/PROJECT_CONTEXT.json` has `working_memory.agents_md_path`, `working_memory.agents_md_loaded`, and `working_memory.agents_md_version` set after each session. These are patched automatically by the loader.
3. **Validate the loader handshake** – From the repository root, confirm the loader can resolve and parse the playbook:

   ```bash
   node - <<'NODE'
   const { AgentsMdLoader } = require('./dist/intelligence/agents-md-loader.js');

   (async () => {
     const loader = new AgentsMdLoader();
     const result = await loader.load(process.cwd());
     console.log({
       path: result.path,
       version: result.version,
       loaded: result.loaded,
       validations: result.validations,
     });
   })().catch((error) => {
     console.error('agents.md load failed', error);
     process.exitCode = 1;
   });
   NODE
   ```

4. **Respect cache TTL** – The loader caches successful reads for 60 seconds. Pass `{ forceRefresh: true }` when you need to consume an updated playbook inside automation.

## Mission Protocol Essentials

- **Generic mission template**: `templates/generic_mission.yaml` implements the ICEV (Intent, Context, Execution, Verification) structure shared by every pack.
- **Domain packs**: Located under `templates/packs/` with manifests in `templates/registry.yaml`.
- **MCP tooling**: The `mission-protocol` CLI exposes quality scoring, dependency analysis, token optimization, and splitting as command-line tools and MCP endpoints.
- **Artifacts**: Generated analytics land in `artifacts/` (`mission-outcomes/latest.json`, `quality-metrics/latest.json`).

## Domain Pack Catalog (24 packs)

Every pack is production-ready with validated schemas and smoke coverage. Generate a mission by passing `--domain <pack-name>` to `mission-protocol create_mission`.

### Foundation & Build

- `foundation` — Governance baseline and organizational scaffolding. Example: `mission-protocol create_mission --domain foundation --output missions/examples/foundation-kickoff.yaml`
- `build.architecture-mission` — 4–6 hour architecture plans aligned to discovery evidence.
- `build.implementation` — Execution missions with implementation steps, dependencies, and rollback plans.
- `build.technical-research` — Structured technical research and prototype evaluations.

### Discovery Suite

- `discovery.go-no-go-synthesis` — Multi-lens synthesis with scoring to decide proceed/pivot.
- `discovery.opportunity-scan` — Session-scoped scan for validating problem and actor fit.
- `discovery.pivot-analysis` — Analyze discovery findings to determine pivot vs. persevere.
- `discovery.problem-definition` — Evidence-backed problem framing with actors and outcomes.
- `discovery.research-orchestrator` — Coordinate parallel research missions with cross-validation.
- `discovery.research-sub-mission` — Focused research lens capturing findings and confidence.

### Product & Market

- `business.market-research` — Market sizing, competitive signals, stakeholder insights.
- `market.customer-development` — Early adopter hypothesis validation and interviewing plans.
- `product.competitive-analysis` — Competitive teardown with advantages and differentiators.
- `product.dashboard-blueprint` — Dashboard design aligned to target audiences and signals.
- `product.prd` — Product requirements document for aligning scope, intent, and success metrics.
- `design.ux-research-summary` — Synthesize UX research findings into actionable guidance.

### Engineering Quality & Process

- `engineering.adr` — Architecture decision records with context, options, and outcomes.
- `engineering.bug-fix` — Full lifecycle bug fixes including root cause and prevention.
- `engineering.tdd` — Technical design documents preceding development.
- `process.code-review` — Structured code review checklists with quality gating.
- `process.design-review` — Goal-oriented design review facilitation.
- `qa.bug-report` — High-signal QA bug reports with reproduction and severity context.

### Research & Software Delivery

- `research.general` — Hypothesis-driven research with evidence and conclusions.
- `software.technical-task` — Software implementation missions with story, approach, NFRs.

For pack file anatomy and authoring practices, see `docs/domain-pack-authoring.md`.

## Intelligence & Process Features

- **Mission Outcome Analytics (Sprint B5.1)** – Run `npm run outcomes` to regenerate `artifacts/mission-outcomes/latest.json`, summarizing progress, velocity, and blocked missions across the backlog.
- **Dependency & Context Intelligence (Sprint B5.2)** – Use `mission-protocol get_dependency_analysis --mission <path>` to surface dependency graphs enriched with mission history and context propagation.
- **Quality Scoring** – `mission-protocol get_mission_quality_score --mission <path>` grades Clarity, Completeness, and AI-Readiness and emits actionable recommendations.
- **Token Optimization & Splitting** – `mission-protocol update_token_optimization` and `mission-protocol create_mission_splits` reduce token footprint and split complex missions while respecting workspace guardrails.

## Author Workflow Examples

- **Discovery → Product**: Generate discovery missions with the `discovery.*` packs, run dependency analysis to understand sequencing, then graduate output into `product.prd` and `product.dashboard-blueprint` missions.
- **Engineering Delivery**: Pair `software.technical-task` with `engineering.tdd` and `process.code-review` to cover design, implementation, and quality gates. Use quality scoring before handoff.
- **Research Accelerator**: Combine `research.general` with `discovery.research-sub-mission` to drive hypothesis validation, then synthesize decisions in `discovery.go-no-go-synthesis`.

Refer to `docs/discovery-workflow.md`, `docs/engineering-workflow.md`, and `docs/product-workflow.md` for end-to-end examples already wired to these packs.

## Validation Before Handoff

- Run `npm test` to keep integration and smoke suites green.
- Regenerate telemetry with `npm run metrics` if you modify pack metadata.
- Re-run `npm run outcomes` to update artifacts after completing a mission cycle.

With these steps, new mission authors can confidently navigate all domain packs, leverage intelligence tooling, and deliver production-quality documentation from their first session.
