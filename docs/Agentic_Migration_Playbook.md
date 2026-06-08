# Agentic Migration Playbook

Sprint 8 introduces the agent memory layer (`agents.md`), worker delegation guardrails, boomerang workflows, and expanded observability. This playbook walks teams through upgrading an existing Mission Protocol workspace from the Sprint 7 baseline to the full agentic stack.

## Prerequisites

- Node.js 18+ with the repository built (`npm run build`) so the compiled intelligence utilities are available under `dist/`.
- A committed `agents.md` playbook aligned with the CMOS template shipped in `agents.md` at the repository root.
- The workspace already tracks missions through `cmos/missions/backlog.yaml` and appends events to `cmos/SESSIONS.jsonl`.

## Step 1 – Align the Playbook

1. Copy the canonical sections from `agents.md` (Project Overview, Build & Development Commands, Coding Standards & Style, Security & Quality Guardrails, Architecture Patterns, AI Agent Specific Instructions).
2. Update the metadata block at the bottom (`Last Updated`, `Version`, `Maintained by`) before every release.
3. Keep guidance single-line where possible so loaders can emit concise summaries and missions can embed the content without reflow.

## Step 2 – Patch Project Context

The loader promotes playbook metadata into `cmos/PROJECT_CONTEXT.json` so downstream tools can reason about the active guardrails. After loading `agents.md`, confirm the working memory block looks similar to the following:

```jsonc
{
  "working_memory": {
    "agents_md_path": "./agents.md",
    "agents_md_loaded": true,
    "agents_md_version": "1.0.1",
    "session_count": 44,
    "last_session": "2025-11-04T05:41:33Z",
  },
}
```

If the loader cannot read the playbook it emits structured validations (`AGENTS_MD_NOT_FOUND`, `AGENTS_MD_EMPTY`, `AGENTS_MD_NO_SECTIONS`). Treat any `action: "block"` validation as a deployment blocker.

## Step 3 – Wire the Loader

Integrate the loader so every controller boot verifies the playbook and updates working memory:

```ts
import path from 'path';
import { AgentsMdLoader } from './dist/intelligence/agents-md-loader.js';

const loader = new AgentsMdLoader({ cacheTtlMs: 60_000 });
const projectRoot = path.resolve(__dirname, '..');

async function hydrateProjectContext(existingContext) {
  const result = await loader.load(projectRoot, existingContext);

  if (!result.loaded) {
    console.warn('agents.md fallback', result.validations);
  }

  return {
    ...existingContext,
    working_memory: {
      ...existingContext?.working_memory,
      ...result.contextPatch.working_memory,
    },
  };
}
```

Set `forceRefresh: true` for long-running agents that need to pick up playbook edits before the default 60-second cache TTL expires.

## Step 4 – Activate Agentic Controller

The controller (`dist/intelligence/agentic-controller.js`) orchestrates RSIP loops, sub-agent delegation, boomerang workflows, and observability streams:

```ts
import { AgenticController } from './dist/intelligence/agentic-controller.js';
import { loadWorkerManifest } from './dist/intelligence/worker-manifest-loader.js';

const controller = new AgenticController({
  telemetry: { stream: console },
  boomerang: { enabled: true, retentionDays: 7, fallbackThreshold: 2 },
});

const workerManifest = await loadWorkerManifest({ projectRoot });
await controller.bootstrap({ workerManifest });
```

- The worker manifest loader enforces the delegation guardrails introduced in B8.4.
- Boomerang defaults (`enabled`, `retentionDays`, `cleanupCadence`, `fallbackThreshold`) mirror the playbook configuration.
- Observability hooks stream structured `AgenticMissionEvent` objects; persist them if you need audit trails.

## Step 5 – Validate Telemetry

1. Track loader metrics: bytes read, load duration, and validation codes. Feed these into your existing telemetry pipeline.
2. Update `cmos/SESSIONS.jsonl` after every mission with `action`, `status`, and `next_hint` so historical analytics remain accurate.
3. Store the loader status in artifacts if you ship mission outcomes downstream (`artifacts/mission-outcomes/latest.json`).

## Troubleshooting

- **agents.md loads stale content** – The loader caches successful reads for 60 seconds. Pass `{ forceRefresh: true }` when updates must be immediate.
- **Validation escalates to `action: "block"`** – Resolve the underlying issue (missing file, unreadable path, empty sections) before continuing. The agentic controller refuses to start when blocking validations are present.
- **Delegation fails to start** – Inspect worker manifest validations emitted by `loadWorkerManifest`. Every delegate must declare guardrails, telemetry hooks, and allowed tool surfaces.
- **Boomerang fallback triggers frequently** – Increase `boomerang.fallback_threshold` or expand the retention window so checkpoints survive longer-running missions.

Following this playbook keeps mission authors aligned with the agent memory layer while unlocking the delegation, boomerang, and observability gains from Sprint 8.
