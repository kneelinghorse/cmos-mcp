# Versioning Contract

This note describes how version information flows across the mission template runtime and the checks that keep the fields in sync.

## Domain Pack Metadata

- `templates/packs/*/pack.yaml` `version` is the source of truth for each pack release.
- `templates/registry.yaml` repeats that identifier in both the `version` and `schema_version` fields so downstream tooling can gate compatibility without opening every manifest.
- The Jest guard in `tests/validation/version-contract.test.ts` cross-validates the manifest against the registry entry and fails if any of the three values diverge.
- When bumping a pack, update the manifest and registry together, then run `npm run validate:packs` and `npm test -- tests/validation/version-contract.test.ts` to confirm the contract stays intact.

## Mission Template API Levels

- Structured mission exports produced by `createTemplateFromMission` and the `get_template_export` MCP tool use `apiVersion: mission-template.v1`.
- Hybrid XML templates target the newer `mission-template.v2` surface; the sample under `templates/hybrid/sample-mission.xml` anchors this value and is covered by the same contract test.
- If a future API level ships, add the new value alongside the existing ones, document the migration range, and extend the contract test so both versions stay discoverable.

## Migration Workflow

1. Design the change and decide whether it is backwards compatible (patch/minor) or breaking (major) under SemVer.
2. Update `pack.yaml`, mirror the value in the corresponding `templates/registry.yaml` entry, and adjust dependent docs or samples.
3. If the change alters behaviour, register the new version with `VersionManager` and author any required migrations via `MigrationEngine` (see `docs/Extension_System_Guide.md#template-versioning` for API details).
4. Run `npm run validate:packs`, then execute the contract test as noted above to catch drift early.
5. Record the release in docs or changelog material so downstream agents know how to upgrade.
