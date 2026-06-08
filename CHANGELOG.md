# Changelog

All notable changes to cmos-mcp are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.1.0 — 2026-06-08

First public release cut from the pro tree (sprints 64–72). A drop-in minor upgrade over 1.0.1 — additive only, no breaking changes. Adds five tool/action surfaces, refreshes the bundled seed schema's cross-store indexes, and relicenses to Apache-2.0.

### Added

- **`cmos_review`** — a bundled session-opener that returns a ≤4 KB project digest (identity, current sprint, project-scoped work queue, recent decisions, freshness, and the top-3 next actions promoted to a flat field) in a single call, replacing the older `cmos_agent_onboard` + `cmos_context(view)` + `cmos_mission(status)` opener.
- **`cmos_db` `pull` / `clone` actions** — plus `slug`, `limit`, and `maxPages` parameters for paginated pulls of dashboard-mirrored project state.
- **`cmos_message` `ack` action + `acknowledged` status** — explicit acknowledgement on the cross-project messaging rail.
- **`cmos_sprint` `forceComplete`** — an operator override to close a sprint past the build-freshness gate; it records an override warning rather than closing silently.
- **`cmos_decisions` `acrossProjects`** — fan `list` out across all registered projects for a recency-ordered cross-store portfolio view, each decision tagged with its source project.

### Changed

- **Seed schema cross-store indexes.** The bundled `cmos-seed/` starter schema gains the cross-store aggregation indexes and the `author_session_id` index rename. `schema_version` stays `2.1` — the internal index rename migrates via the schema-migration path, not as a consumer-facing contract change.

### Notes

- Verified **additive-only** vs 1.0.1 (15 tools vs 14; zero removals, renames, required-parameter tightening, or type/default changes; `bin` + `exports` byte-identical), so this is a **drop-in** upgrade — no consumer action required.
- **Relicensed ISC → Apache-2.0** (permissive + attribution via `NOTICE` + patent grant). See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## 1.0.1 — 2026-05-15

Patch release. Triages an OODS-Foundry-MCP intel report (2026-05-15) covering three CMOS-MCP server behaviors: one real bug fix, one verify-back to an existing fix, and one architectural item deferred to a future release.

### Fixed

- **`cmos_agent_onboard` cascade now trusts real activity over `sprints.end_date`.** When no Active/In Progress sprint exists (the steady-state for fork-and-forget projects), the cascade previously fell back to a status-and-`end_date` ordering. But `end_date` is admin-editable and frequently drifts later than the sprint's actual activity — closeout scripts and post-hoc backfills can write a date-only string (`'2026-05-14'`) that sorts after a younger sprint's ISO timestamp (`'2026-05-08T...'`). The result: `currentSprint` could surface a much older Completed sprint instead of the genuinely most-recent one. New Step 5 in `getCurrentSprint` queries `MAX(missions.completed_at, sessions.completed_at)` per non-Archived sprint and picks the highest, falling back to the legacy status-and-`end_date` ordering only when no activity rows exist. See [`src/tools/cmos/cmos-agent-onboard.ts`](src/tools/cmos/cmos-agent-onboard.ts) — `getCurrentSprint` + `getMostRecentlyActiveSprintIdIncludingCompleted`.

### Verified (no code change)

- **`cmos_session(action="complete", decisions=[…])` fan-out into `strategic_decisions`** — already shipped by Sprint 55 m02 on 2026-04-17 at `cmos-session-complete.ts:476-522`. Dedup key `(decision_text, session_id)`; `sprint_id` inherited from the session row; `decisions_fts_insert` trigger maintains FTS5 automatically. The intel report cited an example from 2026-04-16 — one day before the fix shipped. Sessions completed on or after 2026-04-17 land their `decisions[]` correctly. Historical pre-fix decisions remain in `sessions.captures` JSON and are not auto-backfilled; operator-side SQL is the right path if you want them surfaced.

### Deferred

- **PG-mirror drift between SQLite and the dashboard's Postgres replica** has been deferred to a future release. This is an architectural item, not a quick fix.

### Other

- Foundational docs and research papers (`cmos/foundational-docs/`, `cmos/research/`) swept for residual `cmos-mcp.com` references — 8 swapped to `cmos.aquex.ai`. Completes the URL cutover started in 1.0.0 (`s62-m04`), which was scoped to `.env` and runtime code.

## 1.0.0 — 2026-05-08

First public release. Published to npm as [`@aquex/cmos-mcp`](https://www.npmjs.com/package/@aquex/cmos-mcp). Local-first by default; the hosted dashboard at [cmos.aquex.ai](https://cmos.aquex.ai) is optional.

cmos-mcp has been in continuous internal development since November 2025. v1.0 marks the point where the protocol surface, auth model, attribution boundary, and context layer are stable enough to draw a line and version against.

### Highlights

- 14 consolidated MCP tools with action parameters, structured error envelopes, and a uniform cold-start payload.
- Device-code auth (RFC 8628) with a per-machine credential store. No shared secrets, no env-var token paste.
- Sender attribution rebuilt around an explicit boundary module — the previous implementation could mis-attribute messages between sibling projects.
- Context v2: project identity at Layer 0, FTS5 retrieval, and a versioned blob migration system. Master context typically sits under 20KB instead of 80KB+.
- Staleness signal hygiene: auto-reaffirm-on-cite, evergreen flag, and a saner threshold default.
- Hosted dashboard is opt-in. Set `CMOS_DASHBOARD_URL` to connect; leave it unset to stay fully local.

### Auth (originally shipped Sprints 57–59)

- **`cmos_auth` tool** with `login_init`, `login_complete`, `logout`, `rotate`, `revoke`, `list`, `reissue`. Agents can run the full credential lifecycle without leaving the conversation.
- **Two-call device-code login** (`login_init` + `login_complete`) for IDE MCP hosts where stderr prompts are invisible. The legacy single-call `login` action is kept for terminal callers.
- **Per-machine credential store** at `~/.config/cmos-mcp/credentials.json`. Atomic writes, mode 0600, two trees (`userScopedKeys` and `projectKeys`) with `parentKeyId` linkage. Honors `CMOS_CONFIG_DIR`.
- **Auto-issue capture on register** — `POST /api/projects/register` returns `{key, keyId, label}` on first registration; cmos-mcp persists it transparently. Lost project keys recover on next startup via `runStartupProjectKeyRecovery()`.
- **Symmetric logout** — revokes the current user-scoped key on the dashboard and clears the local row in one atomic operation. Project-scoped child keys are deliberately not cascade-revoked.
- **Scope-aware unified revoke** — `POST /api/keys/:keyId/revoke` covers both user-scoped and project-scoped rows; the MCP determines scope locally before calling so cleanup routes correctly.
- **`whoami` + `authState` on onboard** — every cold-start payload reports `identitySource`, `authTier`, project/user keys, and last delivery observed. Surfaces `cmos_auth` suggestedActions when credentials drift.
- **Legacy-auth WARN** on stderr when falling back to `CMOS_DASHBOARD_API_KEY` or password auth, with a one-line migration pointer.

### Attribution (originally shipped Sprints 53–54)

- **Sender-context boundary module** at `src/tools/cmos/sender-identity.ts`. Single source of truth for sender attribution: matches `metadata.dashboard_project_id` first, then the local `cmos_address` against `/api/projects/me`, then fail-closed (`undefined`) — never picks a sibling.
- **Dispatcher refactor.** `CMOS_PROJECT_ROOT` no longer leaks into the tool-dispatch chain. Sender resolution is independent of working directory.
- **Self-send probe.** Sending `cmos://derek/<own>` to itself is rejected with HTTP 400. The MCP uses this as a runtime sanity check.
- **Sibling hardening.** Verified across 12 active projects post-rebuild — no cross-project mis-attribution observed.

### Context v2 (originally shipped Sprints 49–51)

- **Project identity (Layer 0)** as a first-class context type. `cmos_context(action="view", contextType="project_identity")` reads/writes the canonical identity payload — `project_id`, `cmos_address`, `platform`, `tier`, `objectives`, etc. Consumed by every onboard.
- **FTS5 retrieval** for decisions, learnings, missions, and sessions. `cmos_context(action="search")` runs relevance-scored queries with optional recency boost; the same retriever powers `cmos_decisions(action="search")` and the supersession detector.
- **Onboard v2.** `cmos_agent_onboard` returns a curated <4KB payload optimized for cold-start, with explicit warnings for staleness, sync drift, orphans, and credential issues.
- **Blob reduction.** `master_context` blobs that previously ran 86KB+ now typically sit under 20KB. Versioned blob migration system (`schema-migrations.ts` + lazy migration on read/write) lets the schema evolve without breaking existing databases.
- **Last-reviewed tracking.** Decisions and learnings carry `last_reviewed_at`; cited items get bumped automatically (see staleness hygiene below).

### Staleness hygiene (originally shipped Sprint 61)

- **Auto-reaffirm-on-cite.** Decisions and learnings cited via `citesLearningIds[]` (explicit) or detected via JS keyword overlap (implicit, floor 15) get their `last_reviewed_at` bumped automatically. Citing a learning in a session capture or mission completion treats it as fresh.
- **Threshold default 10 → 20 sprints.** `DEFAULT_STALENESS_THRESHOLD` is exported from the staleness module so downstream tools share the value.
- **Evergreen flag.** `cmos_learnings(action="update", evergreen=true)` marks an institutional rule excluded from the staleness signal. Lazy migration on first read/write of the learnings table.

### Tool-surface changes

This is the section to read carefully if you've been tracking pre-1.0 internal builds.

- **`cmos_learnings(action="update")` now requires `status` OR `evergreen`** (decision #634). Previously `status` was the only mutation field; the evergreen flag is now a peer. At least one of the two must be set per update call. Impact: any caller passing only `learningId` with no other fields will now error — pass at least `status` or `evergreen=...`.
- **14 consolidated tools.** `cmos_status` is the newest, added in v1.0 for cross-side parity with `cmos_agent_onboard.authState`. It returns five fields: `cmos_address`, `dashboard_url`, `auth_tier`, `last_sync_at`, `last_delivery_observed_at`.
- **`cmos_auth(action="logout")` is symmetric with `login`.** Logout revokes the user-scoped key on the dashboard and clears the local row atomically. Project-scoped child keys are not cascade-revoked.
- **Dashboard-not-configured is now actionable.** Tools that relay to the dashboard (sync, messaging, registry) return a structured `DASHBOARD_NOT_CONFIGURED` error with a sign-up pointer when `CMOS_DASHBOARD_URL` is unset, instead of a generic network error.
- **HTTP 402 = `DASHBOARD_UPGRADE_REQUIRED`.** Paid-tier denial (e.g., cross-user messaging from a free account) returns a typed error code with the dashboard's detail message and a sign-up URL.
- **Content-field sanitizer.** Free-text fields on write paths (`cmos_session(capture|complete)`, `cmos_mission(add|update)`, `cmos_mission_transition(complete|block|defer)`, `cmos_context(update)`) strip XML-marshalling fingerprints (`<content …>`, `<parameter …>`, `<invoke …>`, `<function_calls …>` outside code fences). The write succeeds but `sanitizedFields[]` surfaces what was trimmed — re-emit cleanly to store the full content.
- **`agentFeedback` field.** `cmos_agent_onboard`, `cmos_session(complete)`, and `cmos_mission_transition(complete)` accept an optional `agentFeedback` (≤2000 chars) to log UX rough edges. Reviewable via `cmos_feedback(action="list")`.
- **Test isolation.** Jest provisions a per-run `CMOS_CONFIG_DIR` tmpdir so the test suite never touches `~/.config/cmos-mcp/`. Set `CMOS_CONFIG_DIR` outside tests to override the default config directory.

### Packaging

- **Package name: `@aquex/cmos-mcp`** (scoped). v1.0.0 is the first public version.
- **`bin` field exposes `cmos-mcp` and `cmos-mcp-http`.**
- **`files` allowlist** ships only `dist/`, `cmos-seed/`, `LICENSE`, `README.md`. Working DB, planning docs, internal docs, and test fixtures are excluded — verified by `npm pack --dry-run`.
- **Default `CMOS_DASHBOARD_URL=https://cmos.aquex.ai`** baked at the dashboard-client level. Empty-string env values are treated as unset (avoids the IDE-spawn empty-env trap).
- **Bundled-env safety guard.** `runStartupBundledEnvCheck` warns on stderr if the server starts from `node_modules/` and finds a stray `.env` adjacent — protects against accidental secret publish.
- **`engines.node >= 18`.** No preinstall/postinstall scripts.

### URL cutover

- **`https://cmos.aquex.ai`** is the canonical dashboard URL going forward (per decision #620).
- **`https://cmos-mcp.com`** is soft-deprecated. The dashboard team's allowlist keeps it accepting in-flight clients during the transition; new installs default to the aquex.ai URL.
- The cutover is env-only — no code-level URL hardcoding survives in `src/`.

### Known issues at v1.0

- **Sync is checkpoint-driven, not continuous.** Sprint 41 replaced the continuous sync pipeline with explicit `cmos_db(action="backfill")` operations. This is the intended model — there's no plan to restore continuous sync.
- **One-way mirror.** SQLite is source of truth; Postgres is a read replica. Restoring state from a different machine requires a fresh login plus a backfill flow.
- **Cross-user messaging is paid-tier.** Same-user multi-device messaging and receive-from-paid are free. Paid-tier denial returns HTTP 402 with the structured `DASHBOARD_UPGRADE_REQUIRED` error.
- **28 evergreen-candidate learnings** flagged in the staleness audit are pending an institutional-rule sweep — operator-driven, not blocking.
- **Historical corrupted rows.** Sprint 60 surfaced 26 historical rows with XML-marshalling artifacts; the sanitizer prevents new corruption but the existing rows are report-only (run `npm run detect:corrupted` to audit).

### Migration notes

- **Coming from `cmos-mcp` (unscoped)?** The package was never publicly published under that name — internal builds installed from a tarball or git URL. Switch your MCP client config to `@aquex/cmos-mcp`:

  ```json
  { "command": "npx", "args": ["-y", "@aquex/cmos-mcp"] }
  ```

- **Existing CMOS databases are forward-compatible.** Lazy schema migrations run on first read/write. No manual migration step.
- **Custom `cmos_learnings(action="update")` callers** should pass at least one of `status` or `evergreen` per call (see Tool-surface changes above).

[1.0.0]: https://github.com/kneelinghorse/cmos-mcp/releases/tag/v1.0.0
