# Security posture

This document describes what CMOS-MCP does with your data, credentials, and network — plainly and
truthfully. Every claim below names the source it rests on — a file in the
[source repository](https://github.com/kneelinghorse/cmos-mcp) and, where it helps, the function or
constant to look for — so you can verify it. (The npm package ships compiled code, so the links point
at the repository.) If something here does not match the code, that is a bug in this document —
please report it.

CMOS-MCP is a **local-first** MCP server. The default, fully-supported mode is: a stdio server running
on your machine, reading and writing a single SQLite file in your project. Nothing listens on a
network port. Ordinary local-only operations do not contact the dashboard. Dashboard-backed tool
calls can, and startup may conditionally recover a missing project key when a registered project and
usable stored user credential make that recovery possible. Authentication bootstrap can use the
baked default host without an environment setting.

## Reporting a vulnerability

Please report security issues via the GitHub issue tracker
([github.com/kneelinghorse/cmos-mcp/issues](https://github.com/kneelinghorse/cmos-mcp/issues)). For a
sensitive report you would rather not file publicly, open a minimal issue asking for a private channel
and we will follow up. There is no bug-bounty program.

## What listens on the network

**Nothing.** CMOS-MCP is a stdio MCP server (`bin: cmos-mcp` → `dist/index.js`, `package.json`). It
speaks JSON-RPC over stdin/stdout to its MCP host and opens **no** listening socket.

A previous release also shipped an HTTP transport bin (`cmos-mcp-http`) that bound a port with
`Access-Control-Allow-Origin: *`, no authentication, and full read-write access to every registered
store. **It has been removed** — source, bin, export, script, docs, and PM2 config are all deleted
(see the `[2.0.0] → Removed` entry in [CHANGELOG.md](CHANGELOG.md)). There is no unauthenticated
network surface.

## Outbound network

CMOS makes outbound requests in exactly two situations, both optional:

1. **The dashboard, once you have a credential, or when you ask for it.** The URL resolves from
   `CMOS_DASHBOARD_URL`, then the baked `https://cmos.aquex.ai` default (`DEFAULT_DASHBOARD_URL` in
   [dashboard-client.ts](https://github.com/kneelinghorse/cmos-mcp/blob/main/src/tools/cmos/dashboard-client.ts)).
   - **Sign-in.** `cmos_auth(action="login")` or `login_init` contacts that host even when no URL
     variable or credential exists. `login_complete` polls only when given a `deviceCode`; without
     one it returns a local `MISSING_PARAMETER` and sends nothing.
   - **Every close uploads the whole database.** Once any dashboard credential exists — a stored
     device-code key, `CMOS_DASHBOARD_API_KEY`, or the `CMOS_DASHBOARD_USER` and
     `CMOS_DASHBOARD_PASSWORD` pair — every `cmos_session(action="complete")` and
     `cmos_sprint(action="complete")` uploads the **entire SQLite file** of the project to the
     dashboard in the background. The first upload also registers the project there and stores its
     project-scoped key. A close made by an implicit session, when the server process ends, uploads
     nothing. Set **`CMOS_CHECKPOINT_SYNC=off`** to stop the upload
     (`triggerCheckpointBackfill` in [checkpoint-backfill.ts](https://github.com/kneelinghorse/cmos-mcp/blob/main/src/tools/cmos/checkpoint-backfill.ts)).
   - **Calls you make.** Messaging, status and sync health, `cmos_db` sync actions (backfill, pull,
     clone, purge), sprint carry-forward, and the onboard and review summaries of messages.
   - **Startup key recovery**, when a registered project and a usable user-scoped credential exist
     but the project's key is missing.

   Without a credential, ordinary local work sends nothing: the baked address alone does not make
   any tool upload project data.

2. **HuggingFace (`huggingface.co`)**, only when the optional `@xenova/transformers` package is
   installed next to cmos-mcp. The default install does not include it, and then cmos-mcp never
   contacts HuggingFace: retrieval is keyword-only and `cmos_db(action="health")` reports semantic
   search off. With the package installed, the first write that records an embedding (a decision,
   learning or mission) or the first search downloads the embedding model
   `Xenova/all-MiniLM-L6-v2` (~25 MB, [embedding-pipeline.ts](https://github.com/kneelinghorse/cmos-mcp/blob/main/src/intelligence/embedding-pipeline.ts)),
   which is then cached locally. You can force **embedding-model loading to remain offline** with
   `CMOS_OFFLINE_EMBEDDINGS=1` (and optionally a pre-seeded `CMOS_MODEL_CACHE_DIR`): the loader sets
   `env.allowRemoteModels=false` before loading
   ([transformers-offline-env.ts](https://github.com/kneelinghorse/cmos-mcp/blob/main/src/intelligence/transformers-offline-env.ts)), and if the model is
   not present locally the vector arm degrades to keyword-only retrieval instead of blocking on a
   fetch (`getEmbedder` in [embedding-pipeline.ts](https://github.com/kneelinghorse/cmos-mcp/blob/main/src/intelligence/embedding-pipeline.ts)). The token
   counter's tokenizer (`Xenova/claude-tokenizer`) loads only when something counts tokens, and no
   tool does. A local-forever install never _hard-requires_ a network fetch.

## Authentication model

Dashboard authentication is **optional**. Device-code bootstrap uses the effective dashboard URL
described above and does not require an existing credential. After bootstrap, credential-bearing
project clients are constructed by `DashboardClient.fromEnvForProject()`
([dashboard-client.ts](https://github.com/kneelinghorse/cmos-mcp/blob/main/src/tools/cmos/dashboard-client.ts)); the selected credential source is
surfaced as an `authTier` (the `AuthTier` type and `deriveAuthTier` in
[auth-state.ts](https://github.com/kneelinghorse/cmos-mcp/blob/main/src/auth/auth-state.ts)):

- **`device-code` (preferred).** RFC 8628 device-code flow via `cmos_auth(action="login_init")` +
  `login_complete`. Mints user-scoped and project-scoped `cmk_` keys stored locally.
- **`legacy-env`.** A `CMOS_DASHBOARD_API_KEY` environment variable (`CMOS_DASHBOARD_API_KEY_ENV`
  in [dashboard-client.ts](https://github.com/kneelinghorse/cmos-mcp/blob/main/src/tools/cmos/dashboard-client.ts)). Kept as a CI/script fallback; the
  server emits a one-time `[WARN]` nudging migration to device-code (`warnLegacyAuth`, same file).
- **`password-fallback`.** Email + password login. Also emits the migration `[WARN]`.
- **`none`.** No stored credential — ordinary local work remains local and credential-requiring
  dashboard operations refuse gracefully. Credential bootstrap remains available: `login` /
  `login_init` require no existing key and may contact the baked dashboard host.

## Data & credentials at rest

- **Project data** lives in one SQLite file, `cmos/db/cmos.sqlite`, inside your project. It is not
  encrypted at rest (it is an ordinary SQLite database on your disk, with your filesystem's
  permissions).
- **Credentials** live at `<configDir>/credentials.json`, where `configDir` defaults to
  `~/.config/cmos-mcp` and honors `CMOS_CONFIG_DIR` (`CMOS_CONFIG_DIR_ENV` in
  [credential-store.ts](https://github.com/kneelinghorse/cmos-mcp/blob/main/src/intelligence/credential-store.ts)). The file is written atomically with
  **`0600`** permissions (`writeFileAtomic(…, { mode: 0o600 })`, same file).
- **The `cmk_` keys in that file are stored in plaintext** — there is **no** encryption at rest and
  we make no such claim (the key fields in
  [credential-store.ts](https://github.com/kneelinghorse/cmos-mcp/blob/main/src/intelligence/credential-store.ts) are documented "Plaintext `cmk_…`
  key"). The protection is filesystem permissions (`0600`), not cryptography. Treat
  `credentials.json` like an SSH private key.

## Backups & deletion — the honest reality

- **Database snapshots** are copies of the SQLite file under `cmos/db/snapshots/`.
  `cmos_db(action="snapshot")` takes one on demand. CMOS takes one itself in three places: before
  and after every `cmos_sprint(action="complete")`, and before `cmos_db(action="prune_snapshots")`
  applies. `cmos_db(action="restore")` copies the live database to `cmos/db/snapshots/pre-restore/`
  before replacing it. Nothing else snapshots first.
- **Retention deletes.** `CMOS_MAX_SNAPSHOTS` (default 50, `resolveMaxSnapshots` in
  [cmos-db-snapshot.ts](https://github.com/kneelinghorse/cmos-mcp/blob/main/src/tools/cmos/cmos-db-snapshot.ts)) caps how many snapshots are kept:
  taking one deletes the oldest beyond the cap, automatic ones included.
- The environment variables `CMOS_AUTO_SNAPSHOT`, `CMOS_SNAPSHOT_RETENTION_DAYS`, and `DB_PATH`
  appear in older docs but are **vestigial — no code reads them.** Do not rely on them.
- There is **no `deleted_at` soft-delete net** on the main store. Decisions and learnings carry a
  status (`active`/`superseded`/`archived`/`stale`), but `cmos_db(action="restore")` replaces the
  whole database (its pre-restore copy is the way back), and `cmos_db(action="purge")` deletes this
  project's data from the dashboard mirror.
- **Snapshot content can be emptied.** `cmos_db(action="prune_snapshots")` is a dry run unless
  `confirm=true`; applied, it empties the content of context-snapshot copies CMOS wrote on its own
  (rows, ids, references and events stay) after taking a database snapshot.

## Untrusted / foreign content

Text that CMOS did not author locally — inbound message bodies and summaries, project directory
descriptions, and decision/learning rows synced from _other_ projects — is treated as **data, not
instructions**. It is rendered inside a source-labeled, self-escaping "untrusted" fence and carries an
additive `{source, trust:"foreign"}` descriptor
([provenance-frame.ts](https://github.com/kneelinghorse/cmos-mcp/blob/main/src/intelligence/provenance-frame.ts)), applied across the message list,
onboarding, directory, and cross-store/pull-merged decision & learning renders. The `cmos_message` and
`cmos_agent_onboard` tool descriptions state this contract to the calling agent.

- **Decision & learning read surfaces framed:** after a `cmos_db pull`, the local
  `strategic_decisions` / `learnings` tables can hold rows authored in another project. `project_id` is
  derived read-time (no migration; column-presence guarded so ancient stores degrade to `NULL` and
  render bare, never throw) and a foreign **decision or learning** row — its `project_id` ≠ the resolved
  local project — renders inside the untrusted fence, while local rows stay bare, at **every** surface
  that renders such rows:
  - the retrieval/search reads: mission-start "relevant decisions"
    ([relevance-surfacing.ts](https://github.com/kneelinghorse/cmos-mcp/blob/main/src/tools/cmos/relevance-surfacing.ts) →
    [cmos-mission-start.ts](https://github.com/kneelinghorse/cmos-mcp/blob/main/src/tools/cmos/cmos-mission-start.ts), decision text **and** evidence),
    `cmos_context(action="search")`, `cmos_decisions(action="search")`, `cmos_learnings(action="search")`
    (threaded through the retriever's `RankedResult` and the two direct-SELECT search paths);
  - the aggregate/digest reads: `cmos_context(action="view")` (full + compact),
    `cmos_agent_onboard` "Recent Decisions", and the `cmos_review` digest's recent-decisions.

  This closes the former mission-start "relevant decisions" limitation for decision/learning content.

- **MISSION / SPRINT / SESSION read surfaces framed:** the same pull-merge path
  stamps a foreign `project_id` onto pulled `missions` / `sprints` / `sessions` rows. Their
  name / objective / context / title / focus / summary fields are now derived read-time (same
  column-presence PRAGMA guard, so ancient stores degrade to `NULL` and render bare, never throw) and a
  foreign row — its `project_id` ≠ the resolved local project — renders inside the untrusted fence while
  local rows stay bare, at **every** surface that renders such rows:
  - `cmos_agent_onboard` current-sprint header, active-session, and pending & blocked missions;
  - `cmos_mission(action="list")` name/objective, `cmos_mission(action="show")` name/title/focus
    (inline) + objective/context/success_criteria/deliverables (block);
  - `cmos_mission(action="status")` local work-queue (In Progress/Current/Queued/Blocked names +
    objectives + sprint title/focus) and `acrossProjects=true` portfolio mission names (foreign fenced,
    the local project's own rows bare — the `[proj:X]` tag is metadata, not a trust boundary);
  - the `cmos_review` digest sprint title/focus, portfolio mission names, and the `Next:` recommendation
    (a foreign referenced mission renders **id-only** so its name never lands unfenced in the ≤4KB digest);
  - the `cmos_agent_onboard` **suggested actions** and the `cmos_review` promoted **next_actions** they
    feed — a foreign mission/session referenced by a "continue/start/resolve/complete" action renders
    **id-only** (name/title dropped) rather than fenced, keeping the byte-capped digest clean;
  - `cmos_session(action="list")` title/summary and `cmos_session(action="search")` title + matched
    snippets.

  This closes the former foreign MISSION/SPRINT/SESSION limitation; the decision/learning sweep above
  and this row-type sweep together frame every local-store read surface that can carry a pull-merged row.
  Scope boundary (ratified): the framed field set is name / objective / context / title / focus / summary
  (+ success_criteria / deliverables on `mission show`). Mission `notes` and `reference_docs` are **not**
  framed — they are operator-authored operational metadata (a blocker reason, a doc URI), rendered on a
  narrow set of surfaces, and were deliberately left out of the sweep; revisit if a real cross-owner share
  makes them an injection vector.

- The separate content sanitizer ([content-sanitizer.ts](https://github.com/kneelinghorse/cmos-mcp/blob/main/src/intelligence/content-sanitizer.ts))
  guards CMOS's own **write** paths against a specific tool-call-marshalling corruption; it is not the
  inbound-rendering mechanism above.

## Dependency posture

Since 3.2.0 a consumer install carries no embedding stack. Measured on packed tarballs installed with
`npm install --omit=dev` into an empty project: 3.1.0's install was 305.7 MB and `npm audit` reported
1 critical and 5 high advisories, all through `@xenova/transformers` (`protobufjs`, `onnx-proto`,
`onnxruntime-web`, `sharp`); the 3.2.0 install is 44.7 MB and reports none. `@xenova/transformers` is an
optional peer dependency. If you install it for semantic search, its chain carries those advisories
into your tree, and this package's `overrides` cannot reach a dependent's tree: pin `protobufjs` to
`^7` in your own `overrides`. In this repository the override still pins it for the development tree
(where the package is a dev dependency), guarded by
[tests/release/dependency-overrides.test.ts](https://github.com/kneelinghorse/cmos-mcp/blob/main/tests/release/dependency-overrides.test.ts).
A small number of **moderate, dev-only** advisories remain in the `jest-cucumber → @cucumber/* → uuid`
test-framework chain; clearing them requires a breaking downgrade of the test framework, so they are
an accepted residual. They are not in any shipped runtime path.

## Sanctioned deployment shape

**Recommended: one project-local stdio server per project.** Launch CMOS from the project directory
(or let your MCP host advertise the project via `roots/list`) so attribution resolves to the right
project. Sender/attribution resolution never consults `CMOS_PROJECT_ROOT` at tool-dispatch time — that
env var is retained only as a bootstrap hint so the server can find its own `.env` (the module note
in [sender-context.ts](https://github.com/kneelinghorse/cmos-mcp/blob/main/src/intelligence/sender-context.ts)).

**The one topology to avoid:** a single _global_ MCP entry that pins `CMOS_PROJECT_ROOT` to one repo
while you work across several registered projects. That configuration ties `.env` bootstrap — and
any dashboard key that `.env` holds — to one repo that every sibling session shares. The server emits
a startup `[WARN]` when it detects exactly this — `CMOS_PROJECT_ROOT` pinned **and** more than one
project registered (`evaluateStartupTopology` in [index.ts](https://github.com/kneelinghorse/cmos-mcp/blob/main/src/index.ts)). If you see that warning,
prefer a project-local server or pass `projectRoot` explicitly per call.

**Credentials belong in `~/.config/cmos-mcp`, not a repo `.env`.** Keeping `cmk_` keys out of any
repository avoids committing or mirroring them. The publish/mirror tooling additionally fails hard if
a real `.env` (anything but `.env.template`) ever reaches the public tree (the leak guard in
[scripts/mirror-to-public.sh](https://github.com/kneelinghorse/cmos-mcp/blob/main/scripts/mirror-to-public.sh)).

### Read-only review agents (the review deployment)

CMOS ships a fail-closed **read-only mode** for agents that should never mutate your store — e.g. a
code-review agent. When `CMOS_AGENT_ROLE=review` is set, a dispatch-layer guard
([read-only-agent-guard.ts](https://github.com/kneelinghorse/cmos-mcp/blob/main/src/tools/cmos/read-only-agent-guard.ts), classifying every action via the
fail-closed [action-taxonomy.ts](https://github.com/kneelinghorse/cmos-mcp/blob/main/src/tools/cmos/action-taxonomy.ts)) hard-rejects every write-classified
tool call **before any database is opened** and is a strict no-op when the env is unset.

To close the _other_ data-loss vector — a review agent running `git reset`/`stash`/`clean`/etc. — the
repo ships a PreToolUse hook ([scripts/hooks/block-git-mutations.sh](https://github.com/kneelinghorse/cmos-mcp/blob/main/scripts/hooks/block-git-mutations.sh))
that rejects destructive git commands. It is **role-gated**: a strict no-op unless
`CMOS_AGENT_ROLE=review`, so it is safe to wire into any settings. To run a review deployment, use a
**separate** Claude Code / MCP host instance and apply
[scripts/hooks/review-agent.settings.json](https://github.com/kneelinghorse/cmos-mcp/blob/main/scripts/hooks/review-agent.settings.json) (copy it to that
instance's `.claude/settings.json`) — it sets `CMOS_AGENT_ROLE=review` and wires the hook, activating
both guards together.

**Honesty caveat (important).** The machine-enforced read-only guarantee holds under this
**separate-read-only-server** deployment, where the review agent's MCP server is launched with
`CMOS_AGENT_ROLE=review`. It does **not** automatically extend to in-session subagents spawned by a
normal build agent: those subagents share the parent's environment and MCP connection, so the parent's
(writable) server serves them. For read-only investigation _within_ a build session, use a read-only
subagent type (e.g. the `Explore` agent) — that is a mitigation, not the machine-hard guarantee.

---

_Last verified against the source for release 3.2.0._
