# Changelog

All notable changes to cmos-mcp are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 2.7.0 — 2026-08-28

Sprint 87 "Mean What You Say" — Arc F sprint 1. Sprint 86 closed the axis a mechanical gate can
see: every identifier a surface names now exists. This one is the behavioural half — a surface
that asserts something that is not so where no name-existence sweep can look. A remedy that names
the wrong cause. A count that reports a write while hiding which rows it touched. An instrument
that reads evidence it created.

### Changed

- **`cmos_sprint(action="complete")` names the ids it archived, and hands back an undo handle.**
  The result gains `archivedDecisionIds`, `learningIds` and `preCloseSnapshotId`, and the rendered
  close line prints the ids rather than only a count, truncating past 30 with an explicit
  `+K more`. The archival was previously unnamed on the tool's published description, unitemised
  in its return, and irreversible.
- **`evergreen = 1` learnings are no longer archived at sprint close.** A behaviour change on a
  ratified write: an institutional-rule learning an operator flagged is no longer demoted every
  time a sprint ends. Decisions have no equivalent flag and are unaffected.
- **`cmos_status.last_sync_at` and `cmos_agent_onboard`'s sync-health counts now describe THIS
  project.** They were fetched unscoped and reported a platform-wide figure inside a
  project-scoped payload, so **these numbers change value on every install**. On this machine
  `last_sync_at` was 32 days optimistic.
- **Portfolio drift reasons now read "no new CMOS rows in Nd" instead of "no CMOS write in Nd",
  because the mechanism changed with the word.** Store freshness is derived from the newest row
  stamp across six domain tables rather than from a file mtime — a signal `cmos_review`'s own
  cross-store fan-out created by opening each store. Measured effect: silent stores 3 → 5, with
  two previously-understated ages corrected (41d → 105d, 41d → 78d) and one store that had been
  classified FRESH for months newly reported at 48d.
- **`MISSION_TERMINAL_STATUSES` no longer contains `Failed`,** which widens a live
  orphan-detection predicate: a sprint-less mission stored as `Failed` now reports as orphaned.
  Unwitnessed — no such row exists in this store or across the fleet.
- **Provenance tags stop naming `unknown-project`.** A row whose store records no identity now
  renders as `unattributed` rather than `proj:unknown-project`, which named a project that does
  not exist on the prompt-injection defence surface. **The untrusted fence is unchanged** — those
  rows are still framed as foreign.
- **`MessageSendResult.messageId` is now optional.** The dashboard's send route returns
  `messageId`; this field read `id` and rendered `ID: undefined` on every successful send. When no
  id comes back the line is omitted and an envelope warning names the absence.
- **`cmos_agent_onboard`'s messaging block reports a project-scoped unread count**, replacing
  `unreadCount` with `unreadCountScoped` / `unreadCountUserWide` / `unreadScope`.
- **The next-steps transition accepts `carried` rows.** Rows carried to a later sprint could not
  previously be completed, dropped or re-carried by id.
- **`skipped-unconfigured` is gone from the startup key-recovery status union.**

### Added

- `preCloseSnapshotId` on the sprint-close result — a database snapshot taken BEFORE the closeout
  transaction, so every archived row is restorable.
- `unmatchedIds` on the next-steps result: which requested ids a transition did not match.
- `unreadCountScoped` / `unreadScope` on `ListMessagesResult`.
- `--strict` on `npm run baseline:cross-store`, which exits non-zero when any store's counts are
  unreliable rather than publishing a partial share under a zero exit code.
- A per-store identity disclosure that names the store whose identity is unrecorded. It was one
  process-wide line naming no path, so in a portfolio fan-out the first affected store silenced
  every other one. **It is a disclosure, and heals no already-stamped row** — restamping rows that
  already carry the `unknown-project` literal is an operator action outside this package. Swept at
  close with `find <home> -maxdepth 7 -path '*/cmos/db/cmos.sqlite' -not -path '*/node_modules/*'`:
  45 stores, 32 resolving by a non-empty `project_id`, 13 collapsing to the literal, 0
  unclassifiable. Scope limit: one home directory on one machine — the count bounds nothing beyond
  it.

### Fixed

- **The mission-transition surface no longer crashes on a mission row this repo's own store
  holds.** Six handlers dereferenced a state-transition table with a status read from the
  database, throwing an unhandled `TypeError` that the MCP boundary reported as "an internal
  error … retry the call" — a loop with no exit. 15 mission rows across 4 of 21 registered stores
  were unusable through `cmos_mission_transition`.
- Two false refusal strings: a terminal mission was said to be unchangeable when only its STATUS
  is settled, and an unrecognized status was answered with a transition error rather than being
  named.
- A read-only client could not open a store that was not already in WAL mode, because the
  `journal_mode` pragma is itself a write and was issued unconditionally. Latent: no shipped code
  path passes `readonly: true` to that client today.
- The published seed no longer ships three empty-string identity rows, and its `Schema Version`
  stamps and one documented column name (`event_data` → `payload`) now match the schema it ships.
- The `whoami` no-roots warning no longer fires alongside a fully resolved payload.
- A `cmos_auth(action="reissue")` that fails dashboard-side no longer destroys the local project
  key, and its error message no longer double-prefixes `Dashboard error:`.

### Removed

Every entry here is unreachable or ignored surface **by measurement**, which is what keeps this
release MINOR rather than MAJOR. Each cites its evidence.

- `CmosReviewResult.warnings` — assigned `[]` at `cmos-review.ts` exactly once and never written
  anywhere, so its renderer could only ever print an empty list and its size-trim stage could only
  ever remove nothing. The **envelope** warnings channel is a different object and is unaffected.
- `MessagingSummary.unreadCount`, replaced by `unreadCountScoped` / `unreadCountUserWide` /
  `unreadScope`. Measured live: `.data.messaging === null` — the block carrying this field did not
  render at all, because its client resolved through an env-only path that errors on a device-code
  install. See the revival below.
- `'none'` from the `KeySource` union — **no producer in `src/` ever emitted it**; a resolver that
  finds no credential returns a failure rather than a success carrying `keySource: 'none'`. Now
  asserted by a standing gate that every union member has a producer
  (`tests/auth/user-scoped-resolution-gate.test.ts`).
- `skipped-unconfigured` from the startup-recovery status union — **zero producers** once the
  null-client path routes through classification, asserted by the same gate. It was not repointed:
  filing a genuine internal inconsistency under a word meaning "not configured" would name the
  wrong cause, and a store holding keys is not unconfigured.

**The one genuine consumer break is in `### Changed`, not here:** `MessageSendResult.messageId`
becomes optional. It ships MINOR on this project's own measured precedent — `## 2.4.0`'s "One
consumer-visible break — see **Changed**" and 2.6.0's `unreadCount` → `unreadCountUserWide`
rename — and it carries its own named bullet rather than being bundled.

### Revived

Two surfaces that were silently absent, not wrong. Said as revivals deliberately: claiming a wrong
number was corrected would assert something that never happened on screen.

- **`cmos_agent_onboard`'s messaging block STARTS APPEARING** for device-code installs. It
  resolved its client through an env-only path, so on such installs it errored and returned null
  with an explicit "don't warn" comment — the block rendered nothing at all.
- **The `Healed stale cmos_address from X to Y` notice STARTS APPEARING** on the strict-success
  path, where it has been silently dropped since sprint 53.

## 2.6.0 — 2026-08-12

Sprint 86 "Say Only What You Know" — the honest-surface release. Sprint 85 made the durable
**record** honest; this release makes the **surface** honest: a shipped string, count or schema
that confidently asserts something that is not so. The **15-tool contract holds** —
`cmos_mission` gains a `move` action, which is a new action on an existing tool, not a 16th tool.

Nothing that worked was taken away. The two `### Removed` entries below are unreachable or
ignored surface, which is why this is a MINOR and not a MAJOR.

### Changed

- **Counts and success flags returned by write actions are now computed from what the database
  did, rather than from what the handler intended (s86 m02).** The one operators have been
  reading is `cmos_sprint(action="complete").nextStepsReconciled`: it now reports the rows the
  bulk `UPDATE` actually changed. That number can differ from the intended count for **two
  different reasons, and they are not the same news**. Either the statement errored — which is
  now surfaced as a `writeFailures` entry carrying the database's own error code — or a target
  row was simply no longer `pending` when the statement ran, which is a benign `WHERE`-miss and
  produces **no** `writeFailures` entry. A lower number is not by itself evidence that anything
  went wrong; read `writeFailures` to tell the two apart.
- **`cmos_sprint(action="list")` and `cmos_sprint(action="show")` now report `totalMissions`
  EXCLUDING Deferred and Dropped missions, accompanied by a new `parkedMissions` count
  (s86 m08).** This is a corrected count on two **read** actions, and it is a separate risk
  from the write-side change above: the numbers move on every store, for every sprint that ever
  deferred or dropped a mission, with no call-site change on the consumer's part. A sprint that
  completed all its live work while parking some now reads as complete instead of being
  permanently punished in its own denominator. Both actions read the `sprint_summary` view
  directly, so a store gets the new numbers as soon as the view migration runs. Where the view
  cannot be upgraded (a read-only store, or a same-named base table already occupying the name),
  both actions report `parkedMissions: 0` and carry the migration's reason rather than failing.
- **33 published numeric declarations tighten from `"type": "number"` to `"type": "integer"`
  (s86 m04).** CLIENT-SIDE VALIDATION ONLY — no server behaviour changes, and no call that was
  correct before is rejected now. 30 scalar parameters plus 3 array item types (`nextStepIds`,
  `constraintIds`, `decisionIds`). Three parameters deliberately remain `number` because they
  are genuinely non-integer: `cmos_sprint.targetSizePercent`, `cmos_context.targetSizePercent`
  and `cmos_context.recencyWeight`.
- **SEPARATE, and a different risk class: three input schemas change their accepted value sets
  (s86 m04), and one of them WIDENS.** `cmos_learnings.status`'s **published** enum widens from
  `['active','archived','superseded']` to include **`'stale'`** — the server has been writing
  that value itself (`src/tools/cmos/staleness-detection.ts:519`,
  `UPDATE learnings SET status = 'stale'`), and 246 such rows exist
  across 7 of the 18 stores measured, so the published contract had been forbidding callers from
  naming a value the server writes. `cmos_decisions` never had this asymmetry, which is the
  evidence the enum was the wrong side rather than the data. With the set corrected,
  `cmos_learnings.status` and `cmos_decisions.status` tighten from a bare string to that
  four-member enum, so a value outside it is now a validation error instead of a silent no-match.
  `cmos_learnings.category` goes the **other** way: its published enum is **dropped entirely**
  and its input stays a free string, because the column is `TEXT` with no `CHECK` constraint and
  a closed set claimed an enforcement the server does not perform — the fleet already carries an
  out-of-set value. The four canonical categories are documented as guidance, not as a contract.
- **Every leaf formatter now renders the envelope `warnings` channel (s86 m02).**
  `CmosToolResult.warnings` ships inside `structuredContent`, but an agent reads
  `content[0].text` — so a warning no formatter rendered was present in the payload and
  unreadable in practice. Measured before the fix, across 76 leaf formatters: **14 rendered the
  envelope channel, 57 rendered nothing at all, a further 4 rendered only a data-level
  `warnings` field of their own** (a different channel), and 1 takes no result at all. So 61
  leaves were silent on the envelope channel. **Consumer-visible consequence: advisories that
  have been shipping invisible since 2.5.0 — including s85-m04's `missionId` advisory — appear
  in the text channel for the first time.** Answers get longer; nothing else about them changes.
- **Separately: the write actions that can partially fail now render a data-level
  `writeFailures` block (s86 m02b).** This is a **different channel** from the envelope
  `warnings` above — it is `result.data.writeFailures`, not an envelope field — and it is
  carried by the seven actions whose writes can fail row-wise while the answer still succeeds:
  `cmos_sprint(complete)`, `cmos_session(capture)`, `cmos_session(complete)`,
  `cmos_context(next_steps)`, `cmos_context(constraints)`, `cmos_decisions(batch_update)` and
  `cmos_project(update)`. An empty list renders nothing, deliberately: a `WHERE` that matched no
  rows is a legitimate outcome, not a failure. Other actions do not carry this field.
- **`cmos_message(action="list").unreadCount` is renamed to `unreadCountUserWide`, joined by a
  new view-scoped `unreadInThisView` (s86 m07).** The dashboard's unread number is USER-WIDE
  across every project you own, while the rows returned beside it are scoped to the calling
  credential, tab and filters — under one name they produced a header that read
  `0 total, 7 unread` against an empty pending inbox, a badge that names no project and can
  never clear. `unreadInThisView` counts the returned rows with status `pending`. **Consumer
  risk: a JSON key disappears — anything reading `unreadCount` off this result now gets
  `undefined`.** A non-fatal warning also names the scope mismatch whenever the resolved
  credential is not project-scoped.
- **The exported TypeScript type `ResolveAddressResult` is corrected to the wire shape
  (s86 m07).** `resolved` changes from `boolean` to an object
  (`{userId?, username?, displayName?, projectId?, projectName?, projectSlug?}`), and the
  never-populated top-level `projectName` / `agentId` members are gone. The endpoint has always
  returned an object here; the declaration described a response it does not send. **Consumer
  risk: a TypeScript compile break for anyone importing the type** — a different risk class
  from the rename above, which no TS consumer sees at compile time.
- **`cmos_message(action="send")` may now return non-fatal `warnings`, and
  `cmos_message(action="directory")` rows gain `createdAt`, `ownerDisplayName`, `ambiguousWith`
  and a correctly-populated `isOwner` (s86 m07).** A send whose target shares a slug prefix with
  another project under the same owner — the `cmos://derek/cmos-mcp` vs
  `cmos://derek/cmos-mcp-pro` case — now says so in the rendered answer and carries
  `targetProjectId` / `targetProjectName` for the project it actually reached. **The send is
  never blocked by this check.** Directory rows carry the ambiguity annotation and, for the
  first time, a real ownership signal: the public directory route never returns `isOwner`, so
  every row (including your own) was previously framed as foreign. `createdAt` is the
  REGISTRATION date and is labelled as such — it is not an activity or freshness signal.
  **Consumer risk: additive only.**
- **`cmos_auth(action="reissue").revokedKeyIds` reports the keyIds the dashboard actually
  revoked** instead of always `[]`, and names them in the rendered answer rather than only in
  `structuredContent`. A success answer previously asserted "nothing was revoked" while the
  dashboard had revoked N keys. A companion **`revokedKeyIdsReported`** boolean distinguishes
  "the dashboard reported an empty list" from "the dashboard reported no list at all" — the
  response body is not validated, so an absent field must not be rendered as an empty one.
- **Attribution failures are two distinct errors, not one wrong cause.** The single
  `DEVICE_CODE_REQUIRED` message asserted that the device-code flow "must be run", which is
  false whenever the credential store already holds a user-scoped key — the credentials existed
  and worked, they simply were not the ones selected. `DEVICE_CODE_REQUIRED` is now returned
  only for a store with zero user-scoped keys (and names the store's path); a resolved
  credential that cannot be attributed (caller-supplied override, legacy
  `CMOS_DASHBOARD_API_KEY`, or the user+password fallback) returns the new
  **`CREDENTIAL_NOT_ATTRIBUTABLE`** naming which arm supplied it.
- **`cmos_auth(action="rotate")` no longer passes a dashboard 401 through blind.** The generic
  suggestion pointed every install at `CMOS_DASHBOARD_USER`/`CMOS_DASHBOARD_PASSWORD`; rotate
  now names the local row's keyId, states that it authenticates with the project-scoped
  credential resolved for that root, and points at `reissue`. The error **code is unchanged**
  (`DASHBOARD_AUTH_FAILED`) and rotate's credential selection is deliberately untouched.
- **The `DASHBOARD_AUTH_FAILED` suggestion no longer names only the password fallback.**
  Device code has been the default bootstrap since 2.x; the suggestion now covers the arms that
  exist without asserting which one authenticated.
- **Startup project-key recovery: `skipped-no-parent-key-id` is replaced by
  `skipped-no-user-scoped-key` and `skipped-unattributable-credential`, both logged at
  `[WARN]`** (previously one status at `[INFO]`). Its message also no longer claims that
  `/reissue` on the next startup will recover the key — startup recovery skips outright whenever
  a local row exists. Consumers matching the old status string must update.

### Added

- **`cmos_mission(action="move", missionId, toSprintId)` — a supported sprint re-bind
  (s86 m08).** `missions.sprint_id` carried two facts in one column ("which sprint created
  this" and "which sprint owns its execution"), and until now the only way to correct it was
  raw SQL against durable state. The move refuses a terminal mission and refuses a closed
  destination sprint, and it distinguishes a destination that does not exist from one that is
  closed — the two need different corrective actions. A new **action on an existing tool**: the
  15-tool contract is unchanged.
- **`sprint_summary.parked_missions`** — the view now carries the Deferred/Dropped count
  alongside the corrected `total_missions`. Applied by a lazy migration on first read.
- **Three parameters that the handlers supported but the tool schema never published, and the
  router never forwarded (s86 m03): `cmos_context.statusFilter`, `cmos_session.expiresAt` and
  `cmos_session.agentFeedback`.** Stated precisely, because it is easy to describe wrongly: at
  2.5.0 none of these three appeared on the tool it belongs to. `agentFeedback` was published
  only on `cmos_agent_onboard` and `cmos_mission_transition`; `statusFilter` only on
  `cmos_project`; `expiresAt` appeared in no shipped artifact at all. The behaviour existed in
  the handlers and there was no way for a caller to reach it. 2.6.0 publishes all three on the
  right tools and wires the router through to them. **Consumer risk: additive.** These are new
  parameters, not repairs to a contract you could already have depended on — the input schemas
  are strict, so a 2.5.0 client passing them got a validation error rather than a silent no-op.
- **`cmos_learnings(action="reaffirm").evergreen` is live**, and the answer carries
  `previousEvergreen` / `newEvergreen` so a caller can see whether the flag actually moved.
- **Per-action parameter tables in `TOOL_REFERENCE.md`.** The generated reference now shows
  which parameters belong to which action, rather than one flat table per tool.

### Fixed

- **`cmos_auth(action="reissue")` now works in the state it exists for (s86 m06).** Reissue is
  the documented lost-key recovery path, and it succeeded only when the local project-key row
  was **absent** — the one state it is not needed in. Client resolution returns a
  project-scoped credential whenever a local row merely EXISTS (the local store has no
  revocation or expiry concept), so a present-but-revoked row short-circuited resolution,
  the mint could not be attributed to a parent credential, and the call failed. Reissue now
  resolves through a new user-scoped entry point (`DashboardClient.fromEnvForUser`, arms
  3 → 4 → 5). **Arm order and `keySource` values are unchanged for every other caller** — both
  entry points share one copy of the chain.
- **A reissue that cannot attribute the mint no longer destroys the local project-key row.**
  The row was removed _before_ the handler discovered the credential problem, so an operator
  asking for a repair was left with no project key at all — strictly worse off than before the
  call. Classification now precedes every write. **Scope, stated precisely:** this covers the
  credential-attribution failures, which are the ones an operator reaches when already broken.
  A reissue that gets past attribution and then fails dashboard-side (the mint 500s or 401s)
  still clears the row first — unchanged from previous releases, and load-bearing, because the
  underlying recovery call is a no-op while a row is present. Restoring the row on a
  dashboard-side failure is tracked as follow-up hardening.
- **The reissue error suggestion is rendered.** `cmos_auth`'s formatter dropped
  `error.suggestion` entirely, and only the formatted text becomes `content[0].text` — so every
  auth suggestion string was invisible in the channel agents read.
- **`cmos_sprint(action="analytics", limit=N)` returned the OLDEST N sprints and called them
  "recent" (s86 m05).** The bound was applied to an ascending ordering, so an operator asking
  for the last 5 sprints got sprints 9–13 of an 86-sprint history, with trend directions
  computed over them. The `LIMIT` now binds a descending ordering inside a subquery with
  oldest-first restored outside it — the trend comparison depends on ascending input, so a bare
  `ORDER BY` flip would have inverted every reported direction instead. The answer also echoes
  the window it actually analysed.
- **`cmos_message(action="send")` could deliver to the wrong project when two projects under
  the same owner share a slug prefix (s86 m07)** — the `cmos://derek/cmos-mcp` vs
  `cmos://derek/cmos-mcp-pro` case. Resolution is exact-match first, and an ambiguous address is
  named in the answer with the project actually reached.
- **Shipped documentation that contradicted the security document in the same tarball
  (s86 m05).** `README.md` asserted three data-loss guarantees — a `deleted_at`-style soft
  delete, automatic pre-destructive snapshots, and blanket dry-run support — that `SECURITY.md`
  in the same published package explicitly refuted, and that contradiction shipped in 2.3.0,
  2.4.0 and 2.5.0. **`SECURITY.md` was the correct document**; `README.md` and
  `docs/getting-started.md` were moved toward it, never the reverse, and each claim was verified
  at source (no table has a `deleted_at` column; `CMOS_AUTO_SNAPSHOT` is read by nothing in the
  tree). A gate now resolves every code-shaped identifier in the shipped prose against `src/`,
  the seed schema, and `package.json` scripts and `files[]`.
- **`cmos-seed/README.md`'s Quick Start named a command the server rejects** — the seed's own
  recommended first call.

### Removed

Both entries are surface that was unreachable or ignored. Neither is a working capability, which
is why 2.6.0 is a MINOR.

- **`cmos_context(action="update").arrayUpdates.decisions_made` and `.learnings` (s86 m04).**
  Dead since Sprint 51's context-blob reduction: the handler's `hasArrayUpdates` check tested
  only the two surviving keys, so a caller passing `decisions_made` **alone** received
  `INVALID_PARAMETER` — from an error whose own suggestion told them to pass `decisions_made`.
  `arrayUpdates.constraints` and `arrayUpdates.context_notes` are unaffected.
- **`CMOS_ERROR_CODES.BUILD_STALE` and the `errors.buildStale` factory (s86 m05).** Unreachable
  since the s74 review retired the enforced build-freshness gate — no caller, and no test
  enumerated the constant. Its `suggestion:` string also told operators to "pass
  `forceComplete: true` to override", a parameter the same package documents as a no-op. The
  live, unrelated `buildStaleAdvisory` in `cmos_sprint(action="complete")` is untouched:
  build-freshness remains advisory and never blocks a close.

## 2.5.0 — 2026-08-10

Sprint 85 "Honest Provenance" — the write-behavior release. The **15-tool contract holds**.
This release changes what the durable record says when nothing is open: the stamp is now
honest, at the cost of some sprint-scoped reporting no longer counting untagged work.

### Changed

- **A session started when no sprint is in an open status now records
  `sessions.sprint_id = NULL` (s85 m03).** Previously the session inherited the most recent
  **Completed** sprint — a durable stamp naming a sprint that was already closed. Decisions,
  learnings, constraints **and next-steps** captured in such a session likewise record
  `sprint_id = NULL`. Display is deliberately unchanged: onboard, review and mission status
  still _name_ the most recent sprint — "which sprint am I looking at" and "which sprint
  should this row carry" are now answered by two different resolvers, on purpose.
- **A `Planned` sprint with only Queued missions no longer receives the write-side tag
  either**, though display still names it. A `Planned` sprint carrying an In Progress or
  Current mission, or any sprint in an open status (Active / In Progress / Current), still
  tags writes normally.
- **Decisions captured with no open sprint are excluded from `cmos_decisions(action="review")`
  staleness triage** — its scoring filters `sprint_id IS NOT NULL`. A new advisory on that
  action reports the excluded count (`N active decisions have no sprint tag and are excluded
from staleness scoring`) rather than hiding the gap.
- **Sprint-scoped retro, analytics and close-summary counts drop for untagged work.**
  `cmos_sprint(action="retro")` and `cmos_sprint(action="complete")` each now name the
  untagged count explicitly instead of under-reporting silently. No `session_missions`
  fallback attribution is performed — that would reinvent the guessing the write path
  refuses to do.
- **Context retention no longer prunes untagged sessions.** A session with NULL `sprint_id`
  is retained by `removeArchivedDetail` rather than swept with its (former) sprint.
- **`cmos_sprint(action="carry_forward")` no longer emits the `null_sprint_sessions` item.**
  Its stated cause ("require dashboard event processor update") was never a dashboard bug,
  and after this release a NULL `sprint_id` is the intended record, not a defect to escalate.
- **No migration, no backfill — go-forward only.** Existing rows are untouched by design:
  the dashboard mirror's session upsert is `COALESCE(existing, incoming)` and cannot clear a
  value, so a local NULL-out of historical rows would diverge from the mirror permanently.
- `cmos_session(action="start")` on a store with nothing open returns `sprintId: null`,
  `sprintAutoTagged: false`, a new **`advisorySprintId`** field carrying the read-resolved
  hint, and a warning telling the caller the session is recorded untagged. The hint rides a
  separate field because `{sprintId, sprintAutoTagged: false}` already means "the caller
  passed `sprintId` explicitly".

### Added

- **`missionId` on `cmos_session(action="complete")` (s85 m04, #487).** The consolidated
  router now forwards the existing top-level param to the complete path, and the
  `decisions[]` / `nextSteps[]` INSERT paths stamp `mission_id`. Per-capture `missionId`
  still wins for next-steps; the call-level value applies uniformly to decisions.
- **`missionId` filters on `cmos_decisions(action="list")`, `cmos_learnings(action="list")`
  and `cmos_context(action="next_steps")` (s85 m04).** The mission → row trail is now
  queryable end-to-end; rows with NULL `mission_id` are excluded by the filter, not errored.
- **A non-blocking warning on decision/learning captures that omit `missionId`** while at
  least one mission is In Progress/Current, naming the candidate mission ids and the exact
  param. Next-step captures never warn (96.4% of next-steps are born at session-complete
  with no mission in progress — it would be pure noise). Nothing is ever silently inferred.
- **Two indexes**: `idx_learnings_mission` and `idx_next_steps_mission`, in the seed schema
  and as marker-gated migrations, so the new filters don't table-scan.

### Fixed

- **`mission_id` was omitted from two `cmos_session(action="complete")` INSERT paths**
  (the `nextSteps[]` and `decisions[]` column lists), so rows born there could never carry
  provenance even when the caller knew the mission.
- **The dedup-ordering shadow bug**: identical text passed in both `nextSteps[]` and a
  next-step capture carrying `missionId` let the unstamped insert win and skip the stamped
  twin. The mission-bearing capture loop now runs first.

## 2.4.0 — 2026-08-10

Sprint 84 "Messaging-Cutover Adoption + Trust-Hardening" plus sprint 85's published-surface
hygiene. The **15-tool contract holds**. One consumer-visible break — see **Changed**.

### Changed

- **A dashboard 403 now surfaces as `DASHBOARD_FORBIDDEN`, not `DASHBOARD_AUTH_FAILED` (s84 m02).**
  **This is the one break in this release.** 401 and 403 previously shared an arm in the
  `DashboardClient` request path, so an authorization failure was reported as an authentication
  failure. Any consumer branching on the error-code string must update. Beyond the naming, the
  split fixes a latent bug the sprint-47 dashboard cutover triggers: an `apiKey` client that read
  a 403 as "auth failed" cleared its cached token and sent `Bearer null` on the next call.
- **Foreign mission / sprint / session text is framed at read time (s84 m03).** After a
  `cmos_db(action="pull")`, local tables can hold rows authored in another project. Mission
  name/objective/context, sprint title/focus and session title now render inside the untrusted
  provenance fence when the row's `project_id` differs from the resolved local project, across
  ~10 read surfaces (`cmos_agent_onboard` pending/blocked, `cmos_mission` list/show/status, the
  `cmos_review` portfolio and sprint fields). Local rows still render bare. Column-presence is
  PRAGMA-guarded, so ancient stores degrade to `NULL` rather than throwing. This closes the
  known limitation documented in 2.3.0 and the SECURITY.md mission-start gap.
- **Build-freshness advisories are gated to `projectType === 'build'` (s84 m05).** A `general` or
  `managed` project no longer receives build-tier staleness advice it has no use for.

### Added

- **`offset` + `returnedCount` on `cmos_message(action="list")` (s84 m02).** SQL-side pagination
  against the dashboard's own paging, so large inboxes page without re-fetching. Omitting
  `offset` reproduces the previous request byte-for-byte.
- **`cmos_message(action="get")` (s84 m02).** Read one message by id with its full body, notes and
  evidence — the byte-capped `list` summaries stay small and the body is fetched on demand.
  Shipped as an **action**, not a 16th tool.
- **`evergreen` on the constraint reaffirm path (s84 m05).** `cmos_context(action="constraints",
constraintAction="reaffirm", evergreen=true)` sets a durable flag that permanently excludes an
  institutional rule from staleness review and the stale-constraint banner. Unlike a plain
  reaffirm — which only resets the clock and ages out again — this does not decay.
- **`npm run prune:snapshots` (s84 m04).** Reclaims the write-only `context_snapshots.content`
  blob (~99% of that table) by **content-tombstone**: the row, all metadata, `content_hash`, the
  `strategic_decisions.snapshot_id` foreign key and the `snapshot_taken` event are all kept; only
  the content bytes are released. **Dry-run by default**; `--apply` is required and is
  irreversible. `cmos_context(action="history")` now surfaces `contentPruned` per row, and
  `cmos_sprint(action="complete")` emits a non-blocking growth advisory — never an auto-prune.
- **Additive identity UUIDs on message rows (s84 m01).** `senderUserId` / `senderProjectId` /
  `targetUserId` / `targetProjectId` alongside the existing fields.

### Fixed

- **`TOOL_REFERENCE.md` shipped a malformed table row (s85 m01).** The renderer interpolated a
  JSON-Schema type union (`string | object`) raw into a markdown table cell, and the bare pipe
  split that row into an extra column. The type cell now passes through the table-cell escaper.
  A new render-validity gate asserts a column-count invariant over the real definitions plus an
  adversarial synthetic — the existing freshness gate compares rendered against committed output
  and is structurally unable to catch a formatting defect.
- **181 agent-facing references named tools or actions that do not exist (s85 m01).** Strings that
  teach an agent how to call CMOS were left behind by the 38→15 tool consolidation, in error
  `suggestion` fields, `warnings[]`, tool descriptions and rendered output — including two invalid
  actions in the general-tier first-session prompt and two non-existent tools emitted on every
  stale-context session start. All corrected to their consolidated forms, now guarded by a
  mechanical AST-based gate over `src/` with no allowlist.
- **The bundled seed docs taught a tool surface that no longer exists (s85 m01).** `cmos-seed/`
  ships in the package and is copied into every project by `cmos_project(action="init")`; its five
  docs — including `build-session-prompt.md`, the recipe a fresh project's build agent follows —
  carried 118 stale references, advertised "27+ tools", and listed a `cmos_backlog_export()` that
  has never existed. Rewritten to the 15-tool action-dispatched surface and covered by the same
  gate.
- **Version-tolerant message NAME reads (s84 m01).** The sprint-47 dashboard cutover repurposes
  `targetProject` / `senderProject` to slugs and adds `*Name` twins; reads now prefer the name
  field and fall back, so they are correct in both eras. Byte-identical to 2.3.0 on pre-cutover
  rows.
- **Schema fidelity on two dual-surface params (s85 m01).** `cmos_mission`'s `context` (top-level
  and nested in `fields`) declared no type while zod already accepted a string-or-object union, so
  the reference published a bare `object` for a param where a string is legal;
  `cmos_context`'s `fieldUpdates[].value` now declares the complete JSON Schema type set, matching
  its deliberately unconstrained zod side.

### Internal

- `TierConfig.toolsUse` removed — unreachable, since the exports map allows only `.` and
  `./package.json` (s84 m05).
- `npm run snapshots:update` added; the bare `snapshots` script omits `-u` and fails rather than
  rewriting, which every re-baseline hit (s85 m01).
- `verify:dist` extended with the s84 answer shapes: the pagination param on the built schema, the
  evergreen flag's durable round-trip, and `contentPruned` on `cmos_context(action="history")`.

## 2.3.0 — 2026-07-11

Arc E "Retrieval + Tiers" — the **last phase-2 arc; phase 2 is complete.** Two sprints: **E1 (s82) Retrieval Spine** — an honest recall gate plus the mission-recall lever — and **E2 (s83) Tiers + Framing** — tier config that works for npm strangers and read-time `project_id`-aware retrieval trust. No new tools — the **15-tool contract holds**; all new behavior rides on existing paths.

### Added

- **Retrieval recall gate (s82 m02).** The un-runnable recall reporter became a `dist/`-backed pass/fail gate: 24 golden fixtures (8/type) re-authored against the post-flush corpus, per-type floors, a baseline-delta regression assert, and an embedder-loaded check (an adversarial reviewer caught the original check was structurally always-true; fixed). Honest baseline recorded: mission top-3 **0.25** (not the stale 43% the plan carried).
- **Mission-recall graph arm (s82 m04).** A **mission-only** 1-hop graph-neighbor arm (same `sprint_id` + `mission_dependencies`) fused as a depth-decayed third RRF term behind a default-**off** `expandGraph` (on only for `cmos_context` search). Lifts mission top-3 recall **0.25 → 0.50**; decisions/learnings unchanged (structural). A 12-agent adversarial review caught + fixed 5 real defects before close.
- **`projectType` on `cmos_project(init)` (s83 m05).** `init` now writes a `project_type` metadata row (default `build`, no-clobber on idempotent re-init) so the first onboard emits the matching `tierSelectionPrompt` (`managed` → Sprint Zero, `general` → first-session) instead of always `build`.

### Changed

- **Tier config now resolves for npm consumers (s83 m05).** `loadTierConfig` resolves against the **resolved store root** (dirname³ of the connected DB path), and falls back to the bundled `cmos-seed/tiers` when a store has no copied `cmos/tiers` (two-pass: exact tier across all dirs, then `build.md`) — fixing the silent no-op that left every auto-discovery npm consumer with a `null` tierConfig. The `agents.md` and `platform-vision.md` tier tables were rewritten as onboarding **vocabulary** only: tiers are **advisory framing, not tool gating** — every tool is always callable in every tier (the `tools_use`/`tools_skip` lists filter only advisory `suggestedAction` hints).
- **Stale-learnings flush (s82 m01).** 28 stale learnings triaged (evergreen / reaffirm / archive) so the onboard staleness banner stops being ~50% noise; the s73 leak-gap decisions were re-surfaced as active learnings; the constraint-reaffirm path folded under `cmos_context`.

### Security

- **Foreign decision/learning provenance framing at every local read surface (s83 m06).** After a `cmos_db pull`, the local `strategic_decisions` / `learnings` tables can hold rows authored in another project. `project_id` is now derived **read-time** (no migration; column-presence guarded so ancient stores degrade to `NULL` and render bare, never throw), and a **foreign** decision/learning row (its `project_id` ≠ the resolved local project) renders inside the untrusted provenance fence — while local rows stay bare — at every surface that renders such rows: mission-start "relevant decisions" (decision text **and** evidence), `cmos_context(action="search")`, `cmos_decisions(action="search")`, `cmos_learnings(action="search")`, `cmos_context(action="view")` (full + compact), `cmos_agent_onboard` "Recent Decisions", and the `cmos_review` digest's recent-decisions. Two adversarial review passes hardened this: the first caught four bare-text surfaces beyond the four originally planned (now framed); the second confirmed the decision/learning coverage is complete. Closes the SECURITY.md mission-start limitation for decision/learning content.
- **Known limitation (honestly documented, deferred):** foreign **mission / sprint / session** text (name / objective / context / title / focus from pull-merged rows) is **not yet framed** at its read surfaces (`cmos_agent_onboard` pending/blocked, `cmos_mission` list/show/status, the `cmos_review` portfolio + sprint title/focus). That is a distinct row-type sweep tracked as a follow-up; the hostile-injection exposure is gated on the parked multi-party collaboration arc (today's pulled rows are the operator's own single-owner projects). See [SECURITY.md](SECURITY.md).

### Internal

- **Mission-embedding trim — negative result (s82 m03).** Trimming the mission embedding input to name+objective did **not** lift mission recall (the "notes dilute" premise was refuted — the cause is corpus density); reverted to the 4-field input per the recorded decision. The recall win came from the graph arm (m04). No user-facing change.

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
