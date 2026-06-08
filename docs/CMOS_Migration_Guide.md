# CMOS Migration Guide

This guide walks existing Mission Protocol projects through the transition from the legacy, CMOS-dependent workspace layout to the new architecture where Mission Protocol runs standalone by default and only opts into CMOS features when the `cmos/` directory and SQLite database are available.

## Modes at a Glance

| Mode                       | Storage                                                                            | Requirements                                                        | Recommended Use                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Standalone (default)       | `agentic_state.json`, `SESSIONS.jsonl`, `PROJECT_CONTEXT.json` in the project root | No CMOS assets required                                             | Ship the starter template, run automation inside repos that do not include CMOS artifacts, or validate OSS builds. |
| CMOS-Integrated (optional) | Same root-level files **plus** `cmos/` (telemetry, backlog DB, CLI helpers)        | `cmos/` directory present, SQLite database at `cmos/db/cmos.sqlite` | Internal sprints that rely on backlog automation, research exports, or mission DB analytics.                       |

The `AgenticController` auto-detects the mode at runtime via `CmosDetector`. Detection caches for 60 seconds but can be force-refreshed via `controller.getCmosDetection({ forceRefresh: true })` whenever you add/remove the `cmos/` directory mid-session.

## Migration Checklist

1. **Snapshot the current workspace**
   ```bash
   mkdir -p backup/cmos-pre-migration-$(date +%Y%m%d)
   rsync -a cmos/ backup/cmos-pre-migration-$(date +%Y%m%d)/cmos/
   cp agents.md backup/cmos-pre-migration-$(date +%Y%m%d)/ 2>/dev/null || true
   ```
2. **Promote runtime files to the project root**
   ```bash
   cp -n cmos/context/agentic_state.json ./agentic_state.json 2>/dev/null || true
   cp -n cmos/SESSIONS.jsonl ./SESSIONS.jsonl 2>/dev/null || true
   cp -n cmos/PROJECT_CONTEXT.json ./PROJECT_CONTEXT.json 2>/dev/null || true
   ```
3. **Update Mission Protocol configuration**
   ```ts
   const controller = new AgenticController({
     statePath: resolve('agentic_state.json'),
     sessionsPath: resolve('SESSIONS.jsonl'),
     cmos: {
       enabled: true, // defaults to true; set false to force standalone
       projectRoot: process.cwd(), // root that the detector scans for cmos/
       detectionOptions: { cacheTtlMs: 60_000 },
       sync: {
         enabled: process.env.CMOS_SYNC === '1',
         telemetrySource: 'AgenticCMOSSync',
         triggers: ['mission_start', 'mission_complete'],
         includeSessionEvents: true,
       },
     },
   });
   ```
4. **Run the validation matrix below** and only remove `cmos/` permanently once both modes pass.

## Validation Matrix

| Scenario         | Steps                                                                            | Expected Result                                                                               |
| ---------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **With CMOS**    | `npm run build`<br>`npm run test:performance`<br>`./cmos/cli.py db show current` | Build + perf tests pass, CLI reports healthy DB, telemetry shows `database_available` events. |
| **Without CMOS** | `mv cmos cmos.hidden`                                                            |

`npm run test:performance`
`npm run build`
`mv cmos.hidden cmos`
`./cmos/cli.py db show current` | Tests still pass, detector reports standalone mode in logs, re-running CLI after restore shows projects unaffected. |

> Tip: Use `CmosDetector.getInstance({ cacheTtlMs: 0 })` in local scripts when you need instant detection after renaming directories during validation.

## Troubleshooting

- **Detector still reports CMOS present after removal** – force refresh detection (`controller.getCmosDetection({ forceRefresh: true })`) or instantiate the detector with a `cacheTtlMs` of 0 in the test harness.
- **Sync attempts to run without CMOS** – ensure `cmos.sync.enabled` is gated on `result.hasCmosDirectory` and guard feature flags in your `AgenticController` wiring.
- **Docs or loaders reference the old paths** – update playbooks to note that `agentic_state.json`, `SESSIONS.jsonl`, and `PROJECT_CONTEXT.json` now live at the repo root.

## References

- `analysis/cmos-integration-gap-analysis.md`
- `analysis/integration-architecture-plan.md`
- `analysis/migration-path.md`
