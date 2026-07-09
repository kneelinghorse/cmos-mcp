# Security posture

This document describes what CMOS-MCP does with your data, credentials, and network — plainly and
truthfully. Every claim below is backed by a `file:line` reference so you can verify it in the source.
If something here does not match the code, that is a bug in this document — please report it.

CMOS-MCP is a **local-first** MCP server. The default, fully-supported mode is: a stdio server running
on your machine, reading and writing a single SQLite file in your project. Nothing listens on a
network port. The optional dashboard integration is off unless you configure it.

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
(see the `[Unreleased] → Removed` entry in [CHANGELOG.md](CHANGELOG.md)). There is no unauthenticated
network surface.

## Outbound network

CMOS makes outbound requests in exactly two situations, both optional:

1. **The dashboard**, only when you set `CMOS_DASHBOARD_URL` (or use the baked default
   `https://cmos.aquex.ai`, [dashboard-client.ts:36](src/tools/cmos/dashboard-client.ts)). Used by
   `cmos_message`, `cmos_auth`, and `cmos_db` sync actions. With no dashboard configured and no
   credentials, these degrade gracefully and nothing is sent.
2. **HuggingFace (`huggingface.co`)**, on first use of semantic retrieval, to download the embedding
   model `Xenova/all-MiniLM-L6-v2` (~25 MB, [embedding-pipeline.ts:38](src/intelligence/embedding-pipeline.ts))
   and, for token counting, `Xenova/claude-tokenizer` ([tokenizer-bootstrap.ts:70](src/intelligence/tokenizer-bootstrap.ts)).
   After the first download the models are cached locally. You can force **fully offline** operation
   with `CMOS_OFFLINE_EMBEDDINGS=1` (and optionally a pre-seeded `CMOS_MODEL_CACHE_DIR`): the loader
   sets `env.allowRemoteModels=false` before loading
   ([transformers-offline-env.ts](src/intelligence/transformers-offline-env.ts)), and if the model is
   not present locally the vector arm degrades to BM25-only retrieval instead of blocking on a fetch
   ([embedding-pipeline.ts](src/intelligence/embedding-pipeline.ts) `getEmbedder`). A local-forever
   install never _hard-requires_ a network fetch.

## Authentication model

Dashboard authentication is **optional** and, when used, is resolved by
`DashboardClient.fromEnvForProject()` in this priority order
([dashboard-client.ts](src/tools/cmos/dashboard-client.ts)), surfaced as an `authTier`
([auth-state.ts:39](src/auth/auth-state.ts), `deriveAuthTier` at
[auth-state.ts:209](src/auth/auth-state.ts)):

- **`device-code` (preferred).** RFC 8628 device-code flow via `cmos_auth(action="login_init")` +
  `login_complete`. Mints user-scoped and project-scoped `cmk_` keys stored locally.
- **`legacy-env`.** A `CMOS_DASHBOARD_API_KEY` environment variable
  ([dashboard-client.ts:26](src/tools/cmos/dashboard-client.ts)). Kept as a CI/script fallback; the
  server emits a one-time `[WARN]` nudging migration to device-code
  ([dashboard-client.ts](src/tools/cmos/dashboard-client.ts) `warnLegacyAuth`).
- **`password-fallback`.** Email + password login. Also emits the migration `[WARN]`.
- **`none`.** No credentials — local-only operation; dashboard features return a graceful
  "not configured" error.

## Data & credentials at rest

- **Project data** lives in one SQLite file, `cmos/db/cmos.sqlite`, inside your project. It is not
  encrypted at rest (it is an ordinary SQLite database on your disk, with your filesystem's
  permissions).
- **Credentials** live at `<configDir>/credentials.json`, where `configDir` defaults to
  `~/.config/cmos-mcp` and honors `CMOS_CONFIG_DIR`
  ([credential-store.ts:13-14](src/intelligence/credential-store.ts)). The file is written with
  **`0600`** permissions ([credential-store.ts:116](src/intelligence/credential-store.ts)).
- **The `cmk_` keys in that file are stored in plaintext** — there is **no** encryption at rest and
  we make no such claim ([credential-store.ts:47](src/intelligence/credential-store.ts) and
  [:72](src/intelligence/credential-store.ts) label the fields "Plaintext `cmk_…` key"). The
  protection is filesystem permissions (`0600`), not cryptography. Treat `credentials.json` like an
  SSH private key.

## Backups & deletion — the honest reality

- Backups are **manual only.** `cmos_db(action="snapshot")` copies the database on demand; the number
  of retained snapshots is capped by `CMOS_MAX_SNAPSHOTS` (default 50,
  [cmos-db-snapshot.ts:338](src/tools/cmos/cmos-db-snapshot.ts)). There is **no automatic snapshot**
  before destructive operations.
- The environment variables `CMOS_AUTO_SNAPSHOT`, `CMOS_SNAPSHOT_RETENTION_DAYS`, and `DB_PATH`
  appear in older docs but are **vestigial — no code reads them.** Do not rely on them.
- There is **no `deleted_at` soft-delete net** on the main store. Decisions and learnings carry a
  status (`active`/`superseded`/`archived`/`stale`), but `cmos_db(action="purge")` and
  `cmos_db(action="restore")` are genuinely destructive. Take a manual snapshot first.

## Untrusted / foreign content

Text that CMOS did not author locally — inbound message bodies and summaries, project directory
descriptions, and decision/learning rows synced from _other_ projects — is treated as **data, not
instructions**. It is rendered inside a source-labeled, self-escaping "untrusted" fence and carries an
additive `{source, trust:"foreign"}` descriptor
([provenance-frame.ts](src/intelligence/provenance-frame.ts)), applied across the message list,
onboarding, directory, and cross-store/pull-merged decision & learning renders. The `cmos_message` and
`cmos_agent_onboard` tool descriptions state this contract to the calling agent.

- **Known limitation (stated plainly):** the mission-start "relevant decisions" surfacing
  ([relevance-surfacing.ts](src/tools/cmos/relevance-surfacing.ts)) does **not** yet frame foreign
  rows — it surfaces local-store decisions (which, after a `cmos_db pull`, can include rows authored
  in another project) without the provenance fence. Framing there requires threading `project_id`
  through the retriever and is a follow-up.
- The separate content sanitizer ([content-sanitizer.ts](src/intelligence/content-sanitizer.ts))
  guards CMOS's own **write** paths against a specific tool-call-marshalling corruption; it is not the
  inbound-rendering mechanism above.

## Dependency posture

`npm audit` is clear of critical and high advisories in the transformers/protobuf chain: the
transitive `protobufjs` is pinned to `^7` via `package.json` `overrides` (the fix for the critical
`onnx-proto → protobufjs` cluster), guarded by [tests/release/dependency-overrides.test.ts](tests/release/dependency-overrides.test.ts).
A small number of **moderate, dev-only** advisories remain in the `jest-cucumber → @cucumber/* → uuid`
test-framework chain; clearing them requires a breaking downgrade of the test framework, so they are
an accepted residual. They are not in any shipped runtime path.

## Sanctioned deployment shape

**Recommended: one project-local stdio server per project.** Launch CMOS from the project directory
(or let your MCP host advertise the project via `roots/list`) so attribution resolves to the right
project. Sender/attribution resolution never consults `CMOS_PROJECT_ROOT` at tool-dispatch time — that
env var is retained only as a bootstrap hint so the server can find its own `.env`
([sender-context.ts:27-29](src/intelligence/sender-context.ts)).

**The one topology to avoid:** a single _global_ MCP entry that pins `CMOS_PROJECT_ROOT` to one repo
while you work across several registered projects. That configuration ties `.env` bootstrap and
fallback attribution to one repo that every sibling session shares. The server emits a startup
`[WARN]` when it detects exactly this — `CMOS_PROJECT_ROOT` pinned **and** more than one project
registered ([index.ts](src/index.ts) `evaluateStartupTopology`). If you see that warning, prefer a
project-local server or pass `projectRoot` explicitly per call.

**Credentials belong in `~/.config/cmos-mcp`, not a repo `.env`.** Keeping `cmk_` keys out of any
repository avoids committing or mirroring them. The publish/mirror tooling additionally fails hard if
a real `.env` (anything but `.env.template`) ever reaches the public tree
([scripts/mirror-to-public.sh:78-88](scripts/mirror-to-public.sh)).

### Read-only review agents (the review deployment)

CMOS ships a fail-closed **read-only mode** for agents that should never mutate your store — e.g. a
code-review agent. When `CMOS_AGENT_ROLE=review` is set, a dispatch-layer guard
([read-only-agent-guard.ts](src/tools/cmos/read-only-agent-guard.ts), classifying every action via the
fail-closed [action-taxonomy.ts](src/tools/cmos/action-taxonomy.ts)) hard-rejects every write-classified
tool call **before any database is opened** and is a strict no-op when the env is unset.

To close the _other_ data-loss vector — a review agent running `git reset`/`stash`/`clean`/etc. — the
repo ships a PreToolUse hook ([scripts/hooks/block-git-mutations.sh](scripts/hooks/block-git-mutations.sh))
that rejects destructive git commands. It is **role-gated**: a strict no-op unless
`CMOS_AGENT_ROLE=review`, so it is safe to wire into any settings. To run a review deployment, use a
**separate** Claude Code / MCP host instance and apply
[scripts/hooks/review-agent.settings.json](scripts/hooks/review-agent.settings.json) (copy it to that
instance's `.claude/settings.json`) — it sets `CMOS_AGENT_ROLE=review` and wires the hook, activating
both guards together.

**Honesty caveat (important).** The machine-enforced read-only guarantee holds under this
**separate-read-only-server** deployment, where the review agent's MCP server is launched with
`CMOS_AGENT_ROLE=review`. It does **not** automatically extend to in-session subagents spawned by a
normal build agent: those subagents share the parent's environment and MCP connection, so the parent's
(writable) server serves them. For read-only investigation _within_ a build session, use a read-only
subagent type (e.g. the `Explore` agent) — that is a mitigation, not the machine-hard guarantee.

---

_Last verified against the source: Sprint 78 (Arc C, "Trustworthy Base")._
