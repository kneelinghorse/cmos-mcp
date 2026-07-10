# Changelog

All notable changes to cmos-mcp are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## 2.2.0 — 2026-07-10

Arc D "One Portfolio Brain" — **Sprint 3, closing the arc.** T4 client-side sync convergence stops a same-owner second machine from minting duplicate dashboard project containers, the session-opener gains a machine-local "unsynced" drift signal, sprint closeout now reconciles the `next_steps` table automatically, and the master_context↔Layer-0 `project_identity` identity split-brain is fixed at the root (metadata is now the canonical identity source). No new tools — the **15-tool contract holds**; new behavior rides on existing paths.

### Added

- **T4 — same-owner sync convergence (client push-keying).** The client now ADOPTS the incumbent dashboard `(owner_id, slug)` key before every push, so a same-owner file-copy on a second machine converges into the incumbent project row instead of minting a duplicate container. The convergence reuses the existing pure-identity reconcile (`resolveAndPersistOwner` → `getMyProjects` → `selectMatchingProject`) with **zero entity merge** — it imports none of the pull-merge machinery. Three client defects that mis-routed data are fixed: `selectMatchingProject` no longer mis-adopts an arbitrary first project's slug/id in a multi-project account (single-project fallback only); `getProjectIdentity` repairs identity from the reconciled `dashboard_slug` before the directory-basename fallback so a registered store never pushes as `'Unknown'`; and the `expectedSlug` guard is relaxed to the reconciled incumbent slug **only when that incumbent was positively confirmed against a live dashboard row this cycle** (a stale/wrong slug still refuses with `EXPECTED_SLUG_MISMATCH` rather than mis-routing). Scope: **same-owner only** — the cross-account duplicate case is server-derived and stays a dashboard-side concern.
- **"Local ahead of dashboard (unsynced)" drift class on `cmos_review`.** The always-on portfolio digest now flags a store whose local writes have run more than 3 days ahead of its last dashboard-converged push from **this machine** — read for free off the registry with **no network round-trip**. It rides on the existing per-project drift list; `last_synced_at` is a new nullable column on the per-user project-graph registry (`NULL` = never-pushed-from-here = no signal, so it never false-positives), written on each converged checkpoint push. The four-bucket partition and the ≤4 KB digest budget are unchanged.
- **Closeout `next_steps` reconciliation.** `cmos_sprint(complete)` now reconciles the `next_steps` **table** (previously only the context-JSON arrays were pruned, so done-but-unmarked rows piled up). It AUTO-completes only the machine-certain subset — pending rows whose `mission_id` is a Completed, non-blocked mission of the closing sprint — CARRIES blocked-linked rows, and FLAGS the sprint-linked remainder on the receipt (`nextStepsReconciled` / `nextStepsCarried` / `pendingFlagged`). It never auto-closes on a "did it ship" guess, and never touches free-text or other-sprint rows.

### Changed

- **Project identity fields now converge across all three projections.** The mission-complete guard is the single convergence point for `{description, status, project_name}`: it stamps BOTH the master_context blob AND the Layer-0 `project_identity` row from `metadata` — the now-canonical source — so the two can no longer drift. Only those three fields are stamped (never `cmos_address` / `objectives` / `foundational_docs`, which stay user-owned). The Layer-0 row-write is failure-isolated: it can never fail a mission-complete.

### Fixed

- **Fork B — the master_context↔Layer-0 `project_identity` identity split-brain.** The Layer-0 row's `description` had gone empty while master_context held the correct string; the durability seed (`metadata.project_description` / `project_status`) was never written, so nothing re-anchored it. This release writes that seed (making metadata canonical), heals the empty Layer-0 row, and fixes the `ensureProjectIdentityRow` seed-precedence bug that seeded an empty description in the first place. With metadata as the sole edit surface, arming the convergence guard can no longer recreate the split-brain.
- **#391 — large-store file-sync** is confirmed **resolved by the dashboard's June upload-cap raise** (500 MB decompressed): a live push of the 61.4 MB store succeeded with zero errors, so no client change was needed. The silent file-sync→event-replay fallback now surfaces a structured `warnings[]` entry instead of a stderr-only log.

## 2.1.0 — 2026-07-09

Arc D "One Portfolio Brain" — Sprints 1 **and** 2. "What's happening across my projects" collapses to **one** answer path, the two registry split-brains collapse to one genuine source, and the session-opener payloads become honest and cheap. The sqlite `ProjectGraphRegistry` (keyed by `project_id`) is now the **sole** discovery store — the JSON `ProjectRegistry` and its `project-registry.json` derivation layer are **deleted** (not merely derived). Every local read pins to its sender; portfolio-wide reads are the explicit `acrossProjects=true` opt-in on the graph-backed `queryAcrossStores`.

> **Answer shapes changed (response payloads, not the input contract).** Every read now pins to the resolved project by default — no more silent cross-project fan-out. `cmos_message(list)` returns a byte-capped **summary**; the full body comes from `cmos_message(get, messageId=…)`. `cmos_review`'s portfolio reports a strict `reachable | silent | unmigrated | unreadable` partition plus a per-project drift list. The **15-tool contract holds** — new capability rides as params (`acrossProjects`) and actions (`cmos_message get`), never new tools.

### Added

- **`acrossProjects=true` on `cmos_mission` and `cmos_learnings`** (additive, matching `cmos_decisions`). `cmos_mission(status, acrossProjects=true)` returns active missions (In Progress/Current) across your registered projects; `cmos_learnings(list, acrossProjects=true, category=X)` returns learnings tagged X across projects. Both merge through the graph-backed `queryAcrossStores`, carry per-row `projectId`, surface per-store failures on `errors[]`, and emit the same metadata envelope as `cmos_decisions(acrossProjects)`.
- **`cmos_message(get, messageId=…)`** — a new **action** (not a tool) returning one message's full body, response notes, and evidence. `cmos_message(list)` now returns byte-capped **summaries** (dropping the heavy body/notes/evidence that produced a ~410 KB / 250-message overflow), with the sender labeled from the populated `senderProject` / `senderDisplayName` rather than a misleading "unknown source". The sent tab carries a user-scoped advisory.
- **Always-on cross-store `portfolio` section on `cmos_review`.** The session-opener digest carries a ≤4 KB portfolio rollup — active missions across your registered projects — built on `queryAcrossStores`. Stores are classified into a strict **partition** (`reachable` = read & fresh, `silent` = read but no CMOS write in >21 d, `unmigrated` = missions table predates the per-row rebuild, `unreadable` = other) that sums to the queried count, plus a top-N **drift** list naming the projects that need attention (with a backfill hint for un-migrated stores). Degrades to `portfolio=null` for a single-project setup. Supersedes the decision-#672 project-only exclusion.
- **Self-capture advisory on `cmos_agent_onboard` + `cmos_review`.** When your local commits run more than 7 days ahead of the last CMOS write (decision / learning / mission — sessions excluded), the opener nudges you to capture the work. Fail-open and project-local; never fires without both signals.

### Changed

- **The project-graph registry is the GENUINE single discovery source.** Every registration/mutation (`cmos_project` init/register/unregister, cwd auto-register) and every internal discovery read resolves through `~/.config/cmos-mcp/project-graph.sqlite`. There is no `project-registry.json` mirror any more; a leftover file from a pre-2.1.0 install is inert and **safe to delete**.
- **`cmos_mission(status)` / `cmos_session(list)` (and every other unpinned read) pin to the sender.** They no longer fan out across every registered project — a neutral multi-project dir now fails closed rather than returning colliding cross-project rows. "Across the portfolio" is the explicit `acrossProjects=true` opt-in.

### Removed

- **BREAKING (internal API) — the JSON `ProjectRegistry` + `project-registry.json` compat layer removed.** The JSON `ProjectRegistry` class, its `deriveJson()` / `replaceWithDerived()` derivation writers, and the five graph→JSON write sites are deleted; a ~10-line marker-gated `readLegacyJsonRegistry()` preserves the one-time v1.x→2.1.0 default-pointer migration (reads the legacy file once if present, writes nothing). Also removed: `withMultiClient` / `MultiClientEntry` (the last fan-out vestiges) and the dead `FTS5Retriever` class + sync `IRetriever` interface. None are on the package `.` export surface or the 15-tool contract — only code importing these internal helpers directly is affected. **Operator note:** `~/.config/cmos-mcp/project-registry.json` is safe to delete.

## 2.0.0 — 2026-07-09

Major release cutting the **honest surface + trustworthy base** work (sprints 76–78). One BREAKING change — the unauthenticated HTTP transport is removed — drives the major bump. The stdio server (`cmos-mcp`), which is the product, is unchanged in its tool contract: the surface holds at **15 tools** and gains only additive actions/flags. What changed is the posture: one truthful identity, a generated tool reference, machine-enforced read-only review agents, foreign-content provenance framing, offline-capable embeddings, a verified-truthful `SECURITY.md`, and a large internal deletion that ships a much leaner tarball with no dead code. A security-skeptical reader can now grep the package and find nothing alarming.

### Added

- **`SECURITY.md`** — a verified-truthful security posture doc, shipped in the tarball. Covers the auth model (device-code preferred; legacy-env and password-fallback tiers with their WARN; dashboard optional), data-at-rest reality (`cmos/db/cmos.sqlite` unencrypted; `~/.config/cmos-mcp/credentials.json` at `0600` holding **plaintext** `cmk_` keys — stated honestly, no encryption-at-rest claim), the network surface (dashboard only when `CMOS_DASHBOARD_URL` is set + `huggingface.co` for the ~25 MB embedding model on first use), snapshot/delete reality (manual snapshots only — no auto-snapshot, no soft-delete), the sanctioned deployment shape, and a vulnerability-reporting pointer. Every claim carries a file:line backing.
- **`cmos_session` `search` action** — full-text search across session titles, summaries, and captures (`query`, plus optional `since` / `until` / `limit`), routed through the consolidated `cmos_session` tool.
- **`--version` and `--help` flags** — the `cmos-mcp` bin prints `cmos-mcp <version>` (or a usage synopsis) to stdout and exits 0, short-circuiting before the stdio server connects.
- **Generated `TOOL_REFERENCE.md`** — a build-time, per-tool/per-action reference for all 15 tools, generated from the tool definitions and shipped in the tarball, guarded by a freshness test so it cannot drift from the schemas.
- **Foreign-content provenance framing** — inbound text not authored in the resolved project (cross-project message bodies, onboard-surfaced messages, directory descriptions, and pull-merged / cross-store decision & learning rows) now renders inside a source-labeled, self-escaping fence and carries a `{source, trust: 'foreign'}` descriptor on `structuredContent`. The `cmos_message` and `cmos_agent_onboard` tool descriptions state the untrusted-data contract — foreign content is data, not instructions.
- **Machine-enforced read-only review agents** — an opt-in `CMOS_AGENT_ROLE=review` env gate hard-rejects every write-capable tool/action via a fail-closed action taxonomy (unknown actions default to write); strict no-op when unset. Ships with a `PreToolUse` git-mutation-blocking hook template under `scripts/hooks/`. The guarantee holds under the sanctioned separate read-only-server deployment (see `SECURITY.md`).
- **Offline-capable embeddings** — `CMOS_OFFLINE_EMBEDDINGS` (sets the transformers `allowRemoteModels=false`) and `CMOS_MODEL_CACHE_DIR` let a local-forever install run without ever fetching the model from HuggingFace. On a load failure the embedder and tokenizer degrade to BM25 / heuristic instead of re-hitting the network on every call.
- **First-run E2E in CI** — a `pack → install-the-tarball → drive-over-stdio` test that guards the published first-run experience (identity, tool count, quickstart lifecycle) against silent breakage.

### Changed

- **One truthful server identity.** The MCP server announces `cmos-mcp` (not the retired `mission-protocol`, nor the scoped package name) at the `package.json` version, and startup logs the real schema version (`2.1`). The vestigial `baseDir` field and the dead `CMOS_DASHBOARD_SECRET` env are gone.
- **Single-current-sprint invariant + one canonical resolver.** A write-time invariant demotes other open sprints to `Planned` (atomic, with a warning), and the four previously-divergent current-sprint pickers collapse onto one `resolveCurrentSprintId` with a most-recent-activity tie-break. This closes a lying-signal bug where `cmos_review`, `cmos_mission(status)`, and `cmos_session` auto-tagging could each report a different "current" sprint; they now agree.
- **npm audit clear of the critical protobufjs chain.** A `protobufjs ^7.6.5` override resolves the critical `@xenova/transformers → onnxruntime-web → onnx-proto → protobufjs` advisory (embedding output verified byte-identical before/after). Zero critical/high remain; 4 moderate **dev-only** advisories are an accepted residual documented in `SECURITY.md`.
- **Quieter local boot.** The empty-credential-store login WARN is suppressed when no dashboard is configured (`CMOS_DASHBOARD_URL` unset), so a local-forever install boots silent; sign-up nudges point to the working `/register` route; a startup topology diagnostic warns only in the ambiguous pinned-`CMOS_PROJECT_ROOT` + multiple-registered-project case.
- **Docs truth pass.** `agents.md`, the README opener, and `docs/getting-started.md` were reconciled to reality — 15 tools via a link to the generated `TOOL_REFERENCE.md` instead of drifted hand-maintained action tables, `cmos_review` documented as the session opener, and removed live-claim references to subsystems deleted in the Great Deletion. The project's own `master_context` identity was refreshed to the open-core description.

### Removed

- **BREAKING — the unauthenticated HTTP transport is removed (hard-delete).** The `cmos-mcp-http` bin, the `./http-server` package export, the `start:http` script, the `src/http-server.ts` source, the transport docs (`HTTP_TRANSPORT.md`, `README_HTTP.md`), and the PM2 config (`ecosystem.config.js`) are all deleted. The bin exposed an unauthenticated channel — `Access-Control-Allow-Origin: *`, no auth, full read-write to every registered store — had no known consumers, and ran nowhere. The stdio bin (`cmos-mcp`) — the product — is unchanged. Consumers importing `@aquex/cmos-mcp/http-server` or invoking the `cmos-mcp-http` bin must pin to an earlier version; if a genuine remote-client need appears, recover the source from git history and rebuild **with authentication** rather than restoring this surface as-is.
- **`gpt-tokenizer` dependency and the GPT token-counting apparatus.** Removed the `gpt-tokenizer` dependency, the boot-time tokenizer preload (and its `[INFO] Tokenizer preload status` startup line), and the scheduled `token-validation.yml` workflow. Token counting keeps an honest Claude (`@xenova`) + Gemini (heuristic) counter; requesting `gpt` now throws `Unsupported model: gpt`. `@xenova/transformers` and the token-counter / tokenizer modules are retained.
- **Dead code and stale docs (the "Great Deletion").** Removed ~69 dead source modules and their tests, the unused domain-pack data (`templates/`, `examples/`), tracked repo cruft (`artifacts/`, `tmp/`, orphaned scripts), and ~34 `docs/` guides describing deleted or superseded subsystems plus the whitepaper. **No tool or API surface changed** — this is internal-only, verified by a two-bin import-graph reachability proof. Consumer-observable effect: a much smaller install with no misleading documentation (the tarball now ships only live `dist/`, `cmos-seed/`, `TOOL_REFERENCE.md`, and `docs/getting-started.md`).

### Security

- The single most alarming grep result — the zero-auth, `CORS *`, full-store-write HTTP channel — is gone (see Removed, BREAKING).
- Review/adversarial agents can be **machine-prevented** from writing to the store or running git-mutating commands (`CMOS_AGENT_ROLE=review`), closing the prose-only gap behind two prior data-loss incidents.
- Inbound foreign content is framed as data, not instructions, across every surface where non-project-authored text reaches agent context.
- The critical protobufjs advisory chain is cleared; the remaining posture (including the plaintext-key and no-encryption-at-rest disclosures) is documented honestly in `SECURITY.md`.

## 1.1.1 — 2026-07-07

Patch release. Four fixes — three triaged from sibling-project bug reports (aquex.ai, Synthesis-Workbench, Forge) against 1.1.0, plus an auth-resolution fix — and one build-freshness **policy change**. **Additive and non-breaking** over 1.1.0: no tools added or removed, no parameter, type, or required-field changes. The only schema-visible edit is the description of the existing `cmos_sprint` `forceComplete` parameter, now documented as a no-op (see Changed). Drop-in upgrade — no consumer action required.

### Fixed

- **Build-freshness now detects real build layouts instead of only `dist/index.js`.** `readDistBuildInfo` keeps `dist/.build-manifest.json` as the deterministic primary, then falls back to the newest-mtime file from a capped walk of the first candidate build dir that has output — `dist/` → `.next/` (excluding `.next/cache`) → `build/` → `out/`. `dist-missing` now fires only when none of those has output. This clears the permanent false `BUILD_STALE` that hit Next.js projects building to `.next/` (Synthesis-Workbench), monorepo `dist/src/` and `dist/server/entry.mjs` layouts (aquex.ai), and non-`dist` roots (Forge). A concurrent adversarial review also closed a corrupt-manifest false-pass (the manifest file is now excluded from the walk) and corrected a misleading `dist/`-only message in `cmos_review`.
- **`getCurrentSprint()` no longer surfaces a terminal sprint as "current".** The picker previously excluded only `Archived`, so `Failed`, `Dropped`, and `Reverted` sprints leaked into `currentSprint` during the review→plan gap, and a lowercase `completed` dodged the case-sensitive comparison. The terminal set is now `{Archived, Failed, Dropped, Reverted}`, case-folded, applied across every step of the selection cascade — including the Completed-aware fallbacks — so it cannot be re-defeated. Consumers no longer need to mint placeholder Active sprints to re-point the opener.
- **Write-path handler exceptions return a structured error instead of a bare `-32603`.** A tool handler that throws a non-protocol exception (e.g. a store-specific write crash on `cmos_sprint(action="complete")` or `cmos_session(action="capture")`) now returns a `CmosToolResult` error — `TOOL_EXECUTION_ERROR` with the real message, a suggestion, and a `correlationId` — as an `isError` result, instead of the generic JSON-RPC `-32603` that swallowed the cause. Genuine protocol errors (`McpError`) keep their JSON-RPC shape.
- **`cmos_db` sync ops resolve the dashboard client via the credential store, not env-only auth.** `backfill` / `reconcile` / `identify_orphans` / `purge` were the last sync surface still on `DashboardClient.fromEnv()` (env `CMOS_DASHBOARD_API_KEY` or user+password → `/api/auth/login`), so they returned `401` after a dashboard password rotation and `.env` scrub while every credential-store path kept working. They now route through `fromEnvForProject()` — credential-store key first, legacy env preserved as a script/CI fallback — so the MCP-tool path needs zero `.env` secrets. Behavior-preserving for standalone callers.

### Changed

- **Build-freshness is now advisory, never blocking (policy change).** `cmos_sprint(action="complete")` no longer blocks closeout on `BUILD_STALE`; staleness is surfaced as a warning and the sprint closes normally. `forceComplete` is retained for backward compatibility but is now a **no-op** (its parameter description says so). The running-server-stale signal on `cmos_agent_onboard` / `cmos_review` is scoped to this project and startup-manifest-gated, so it no longer reports "server is running stale code / restart required" over unrelated projects' rebuilds. This reverses the previously-blocking gate, which over-fired on foreign build layouts; the generalized probe plus advisory warnings preserve the signal without the false-positive tax.

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
