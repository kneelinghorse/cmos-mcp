# Trust: what Reasonbook does on your machine

Reasonbook, formerly CMOS, keeps your project's record in a SQLite file inside your project, `rbook/db/rbook.sqlite`, and
runs as a local MCP server over stdin and stdout. It opens no listening port. The dashboard is
optional: without a dashboard credential, ordinary local work never contacts it.

Every statement here comes from the code, from [SECURITY.md](../SECURITY.md), or, for how Codex
starts a plugin's server, from a recorded test of Codex itself.

[Privacy](privacy.md) covers collection, dashboard account visibility, retention and removal.
Existing installations may still use older record and configuration locations until migrated;
the [upgrade guide](migrating-from-cmos.md) explains how those locations are selected and moved.
The paths below describe a new installation. Removing only those paths does not remove data that
remains in an older location.

## What leaves your machine, and when

| What                                           | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | How to stop or control it                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Reasonbook package, from your npm registry | The plugin's first launch installs its exact Reasonbook version and dependencies with `npm install`: into the plugin's data folder in Claude Code, or into `~/.config/rbook/plugins` in Codex, which both Codex plugins share. Until that install is ready, a command run through the plugin in Claude Code fetches the same version through `npx`. The one dependency with an install script, SQLite's `better-sqlite3`, downloads a prebuilt build from its GitHub releases, or Node's headers from nodejs.org when it has to build one | Install the exact version yourself: in Claude Code the plugin then uses that copy from your PATH instead of installing its own, while Codex always installs its own. Or set up the server without the plugin. Either way the package comes from npm                                                                                                                                                                                                                                                  |
| Your project's record, to the dashboard        | Only with a dashboard credential, or when you sign in. Signing in sends your computer's name in its request. With a credential: a snapshot of the whole `rbook.sqlite` file after writes in a registered project and at explicit session or sprint closes; a key recovered at startup; a shared project's sync around mission and sprint changes; and the calls you make (messages, status, sync, a sprint's carry-forward, and `rbook_auth`'s sign-in and key actions), including the message summaries in review and onboard            | `RBOOK_CHECKPOINT_SYNC=off` stops the automatic snapshot uploads, where it reaches the server. The developer plugin requests environment forwarding; the portable chat plugin uses its host's inherited environment. Configure a server yourself if your loader does not forward it. It does not stop a shared project's sync or the calls you make. Signing out stops the automatic uploads unless your environment sets a dashboard key or user and password; without a credential nothing is sent |
| The embedding model, from Hugging Face         | Only if you installed the optional `@xenova/transformers` package for semantic search: the first embedding downloads `Xenova/all-MiniLM-L6-v2` (about 25 MB) once, and installing that package also downloads native libraries for its `sharp` dependency                                                                                                                                                                                                                                                                                 | Leave the optional package out (the default), or set `RBOOK_OFFLINE_EMBEDDINGS=1`                                                                                                                                                                                                                                                                                                                                                                                                                    |

There is no remote telemetry. Reasonbook keeps a local log of tool and hook use in
`~/.config/rbook/telemetry/`: tool names, ids, counts, error codes, which of Reasonbook's published prompt
patterns a prompt matches and the slash command it starts with, never the text of your prompts or
your record. It keeps the three newest months and is never uploaded.

## What the hooks read and add

The Claude Code plugin and the Codex developer plugin run five hooks: session start, prompt submit,
stop, pre-compact and session end. From the harness they read the session id, the event's source or
reason, the turn id, the working folder, your prompt and the agent's last reply. In Claude Code they
also read the conversation transcript, in bounded pieces, to notice content that came from outside
the conversation and to find the last reply; Codex's transcript path is discarded. Raw session ids
and transcript paths are never stored. In Claude Code they also read when the harness's process
started: with `ps` on macOS, from `/proc` on Linux.

- **Session start** adds up to 6,000 characters: a digest of the project's record, your operator
  profile, the drafts waiting for your answer and a feedback count. In Claude Code it also links the
  conversation to the project. In any Git repository it notes the current commit and which files are
  changed or untracked (names only), so session end can say what changed. In a Git repository
  without a record, it offers to start one until you decline, which runs `ambient off` there.
- **Prompt submit** may add up to 1,500 characters: previews of related past decisions, drafts
  waiting for you, and reminders. When a reply has shown you a draft, Reasonbook keeps your next message,
  whatever it says, up to 1,000 characters, outside the record for up to two hours; a decision
  recorded from the draft carries your words.
- **Stop** keeps up to three `Would record:` lines that close a reply, with up to 600 characters
  before them, as drafts. A draft is never a decision until it is recorded.
- **Pre-compact** adds nothing. After compaction, session start runs again and adds the digest
  again.
- **Session end** closes the sessions the conversation opened and notes which files Git reports
  changed, as observations, not as authorship.

Only session start and prompt submit add anything to the conversation.

The hooks keep their own state in `~/.config/rbook/runtime/`:

- session ids, only as hashes;
- the folders and repositories you worked in;
- each session's Git note (the commit and the changed file names), deleted when the session-end hook
  completes, and otherwise kept until you delete it;
- your messages after a draft, until they expire;
- which records' previews you have already been shown, with no expiry.

The conversation-focused plugin, `reasonbook-chat`, has no hooks.

## Credentials

Signing in to the dashboard stores keys in `~/.config/rbook/credentials.json`, readable only by
you (mode 0600): your account's key, and a key for each project registered with the dashboard. The
keys are not encrypted: treat the file like an SSH private key. They are sent only to the dashboard
address (`https://reasonbook.ai`, or `RBOOK_DASHBOARD_URL` if you set it).

## Dependencies

On 2026-10-11, `npm audit --omit=dev` on this repository's lockfile reported no advisories for the
dependencies the package installs. The plugin installs without a lockfile, so the versions it gets
can differ. [SECURITY.md](../SECURITY.md#dependency-posture) lists what remains in the development
tree and why.

## Turning parts off

- **The hooks in one project:** `npx @aquex/reasonbook@<version> ambient off`, run in that project,
  with the version the plugin installed. The hooks still start and log their use locally, but add
  nothing. The command also updates the Reasonbook line in that project's `AGENTS.md`. `ambient on` turns
  them back on.
- **Automatic uploads:** `RBOOK_CHECKPOINT_SYNC=off` in the server's environment, or signing out
  (with no dashboard key, user or password set in the environment).
- **The plugin:** uninstall it in your client. The Reasonbook server can still run on its own.

## Removing your data

- **The record:** delete the project's `rbook/` folder. Init also wrote the project's `AGENTS.md`
  and `CLAUDE.md` if they did not exist; edit or delete them as you like.
- **An interrupted upload's copy:** an upload that stopped partway can leave a copy of the record in
  your temp folder, in a folder named `rbook-dashboard-upload-*`. The next upload removes your copies
  older than a day, except on Windows, where you delete them yourself.
- **Everything Reasonbook keeps for you on this machine:** delete `~/.config/rbook/` (credentials, the
  project registry, telemetry, hook state and your operator profile).
- **Dashboard sign-in:** `rbook_auth(action="logout")` revokes your account's key on the dashboard
  and removes it from this machine. Project keys stay valid, and stay in `credentials.json`, until
  you revoke each with `rbook_auth(action="revoke", keyId="<id>")`.
- **The dashboard's copy of a project:** `rbook_db(action="purge", confirm=true, expectedSlug="<slug>")`
  deletes the dashboard's copy of the record and its sync log. The uploaded database, the messages,
  and the activity and diagnostic logs remain, and the next upload rebuilds the copy unless uploads
  are off.
