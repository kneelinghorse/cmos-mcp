# CMOS in your harness

Coverage checked against vendor documentation on **2026-10-09**. These adapters target
**CMOS 3.3.0**. Every
non-Claude adapter below is **UNVERIFIED in a live harness**. Local fixture tests check
the CLI contract and package contents; they do not prove that a vendor loads the file
or delivers its output to a model.

Install the CLI before enabling hooks:

```sh
npm install -g @aquex/cmos-mcp@3.3.0
cmos-mcp --version
npm root -g
```

The last command locates the global packages directory. The configuration sources
listed below live in its `@aquex/cmos-mcp/adapters/` directory. Merge entries into an
existing destination instead of replacing unrelated hooks. Make `cmos-mcp` available
on the harness process's PATH. Hooks call the installed CLI directly: invoking `npx`
inside a hook would spend its short deadline finding or downloading the package.

Configure the CMOS MCP server in your harness separately; an adapter adds lifecycle
hooks, not an MCP server. See [getting started](getting-started.md).

## Coverage

“Start” means the adapter can provide the project digest. “Prompt” means it can
inject recall and a pending draft offer before a user turn. “Reply” means it can
read the next user reply through a hook. These describe the implemented adapter
contract, subject to the live-verification limitation above.

| Harness                                      | Start         | Prompt / draft offer                                        | Reply observation                | Close                          | Decision approval through MCP                                         |
| -------------------------------------------- | ------------- | ----------------------------------------------------------- | -------------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| Claude Code plugin                           | Yes           | Yes                                                         | Yes                              | SessionEnd                     | Hook evidence when the MCP server shares the verified harness session |
| Codex adapter                                | Yes           | Yes; Stop can capture a draft from `last_assistant_message` | Yes                              | Hook cleanup; manual MCP close | Agent-attested; MCP session linkage is unverified                     |
| Cursor IDE / CLI adapter                     | Yes           | No                                                          | No                               | Manual                         | Agent-attested                                                        |
| Devin CLI / Devin Local adapter              | Yes           | Yes for existing drafts; no automatic Stop draft capture    | Observed; no named-draft binding | Hook cleanup; manual MCP close | Agent-attested; MCP session linkage is unverified                     |
| Copilot CLI / cloud adapter                  | Yes           | No                                                          | No                               | Manual                         | Agent-attested                                                        |
| VS Code Local adapter                        | Yes           | No                                                          | No                               | Manual                         | Agent-attested                                                        |
| Zed / Warp / goose, using the fallback below | Agent-invoked | Agent-invoked                                               | Agent judgment                   | Agent-invoked                  | Agent-attested                                                        |

Agent-attested decisions mean the agent states that the operator approved the text.
Constraint, rule and profile drafts require verified hook approval and cannot use
agent-attested capture. A stable ID in hook stdin alone does not establish a
connection to the MCP server process. Non-Claude
transcripts are not scanned as Claude transcripts; their outside-content provenance
remains unknown. Without MCP session linkage, SessionEnd cleans up hook-owned
state but cannot close the MCP process's separate session; close that session through
MCP. Stop, compaction and end hooks never request an extra model turn.

## Codex

Merge [`adapters/codex/hooks.json`](../adapters/codex/hooks.json) into project
`.codex/hooks.json`. In the Codex CLI, use `/hooks` to inspect the loaded commands
and review/trust their definitions. Trust applies to the exact definition; changed
definitions require review again. Do not bypass this review or write trust records
on the operator's behalf. Project configuration must be in a trusted, active
configuration layer. [Codex hooks](https://learn.chatgpt.com/docs/hooks)

The adapter maps `session_id`, `cwd`, `turn_id` and `last_assistant_message` into the
shared CLI. It wires SessionStart, UserPromptSubmit, Stop, PreCompact and SessionEnd;
start and prompt use the nested `hookSpecificOutput.additionalContext` envelope.
Codex MCP prompt support has not been established: use its skills or the fallback
instructions below. **Live runtime: UNVERIFIED.**

## Cursor IDE and CLI

Merge [`adapters/cursor/hooks.json`](../adapters/cursor/hooks.json) into
`.cursor/hooks.json`. Trust the workspace. If CMOS hooks are also imported from
Claude configuration, turn off **Settings → Agents → Third-Party Imports → Include
Third-Party Plugins, Skills, and Other Configs**, or remove the duplicate imported
CMOS hook registration. That switch affects other imported configuration too.
Cursor runs matching hooks from every source; native priority does not suppress
duplicates. [Third-party imports](https://cursor.com/docs/reference/third-party-hooks)

This adapter wires only `sessionStart`, returning `additional_context`. Current
docs identify its `session_id` as the same ID as `conversation_id`. Cursor's prompt
hook cannot inject the pending offer, so this adapter does not wire it. Hosted cloud
agents do not provide this session-start boundary; this adapter therefore does not
claim cloud coverage. Check Customize's Hooks tab and the Hooks output channel.
**Live runtime: UNVERIFIED.** [Cursor hooks](https://cursor.com/docs/hooks)

## Devin CLI and Devin Local

Merge [`adapters/devin/hooks.v1.json`](../adapters/devin/hooks.v1.json) into
`.devin/hooks.v1.json`. This file is the event map itself, without a `hooks` wrapper.
It wires SessionStart, UserPromptSubmit and SessionEnd. The adapter uses
`DEVIN_PROJECT_DIR`, `session_id` and `prompt_id`; start/prompt output uses the nested
`hookSpecificOutput.additionalContext` envelope. Run `/hooks` to inspect loaded
sources. **Live runtime: UNVERIFIED.** [Devin hooks](https://docs.devin.ai/cli/extensibility/hooks/overview)

Merge [`adapters/devin/config.json`](../adapters/devin/config.json) into
`.devin/config.json` to set `read_config_from.claude` to `false` and prevent imported
Claude hooks from running alongside these native hooks. This also disables imported
Claude rules, skills and MCP configuration; retain the required native configuration
and AGENTS.md. Do not install the CMOS plugin's hooks alongside this adapter.
[Devin import controls](https://docs.devin.ai/cli/reference/configuration/read-config-from)

The documented Stop payload has no assistant reply, and PostCompaction is a different
boundary from CMOS's pre-compact hook. Neither event is wired. Prompt hooks observe
replies, but without Stop they cannot establish which named draft the assistant
showed for approval. Record agreed decisions
through MCP; without verified session linkage, their draft approval is agent-attested.
[Devin lifecycle](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks)

## GitHub Copilot and VS Code Local

Choose **one** of these alternatives for `.github/hooks/cmos.json`:

- **Copilot CLI or cloud agent:** [`adapters/copilot/cmos.json`](../adapters/copilot/cmos.json).
  Uses `version: 1`, `sessionStart`, `sessionId`, and top-level `additionalContext`.
  Its Bash and PowerShell commands invoke the same installed CLI. Cloud jobs require
  the package and project store to be available in the job; their network access is
  restricted and their filesystem is ephemeral. No prompt hook is wired because
  config-file prompt output is discarded. **Live runtime: UNVERIFIED.**
  [Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference)
- **VS Code Local session target:** [`adapters/vscode/cmos.json`](../adapters/vscode/cmos.json).
  Uses `SessionStart` without a numeric `version`, optional `session_id`, and nested
  `hookSpecificOutput.additionalContext`. Local hook support is preview. Enable
  `chat.useHooks`, trust the workspace, and leave `chat.useClaudeHooks` off when using
  this adapter. Inspect **Chat: Configure Hooks** and the **GitHub Copilot Chat Hooks**
  output channel. **Live runtime: UNVERIFIED.**
  [Local hook configuration](https://code.visualstudio.com/docs/agent-customization/hooks),
  [Local schemas](https://code.visualstudio.com/docs/agents/reference/hooks-reference)

VS Code can parse Copilot configuration, but its Local runtime sends different
payloads and consumes a different output envelope. Select the adapter for the actual
session target, and replace the CMOS entry when switching targets. Installing both
files would run both. Remove any duplicate CMOS hook registrations from imported
Claude settings or installed plugins. These adapters intentionally provide only the
start digest: close the CMOS session explicitly with the close-out command or MCP.

## MCP prompts and harnesses without hooks

CMOS exposes four MCP prompts from the same source files as its skills:
`cmos-start`, `cmos-close-out`, `cmos-plan`, and `cmos-build`. Select them through your
client's MCP prompt picker or slash-command menu when available. They are invoked by
the user or agent; exposing a prompt does not make it run automatically. Client
support varies, so no prompt-only client is described as having lifecycle hooks.

For Zed, Warp, goose, or any harness without this adapter support, run:

```sh
cmos-mcp init --no-hooks
```

Use the AGENTS.md output from that command. Its labelled hook-less block is at most
15 lines and comes from the same init source used for every project; do not maintain
a second copy of the procedure in a client-specific rules file. If the harness does
not load AGENTS.md automatically, include that file through its project instructions.
The fallback asks the agent to review the project record and capture unfinished work,
so delivery depends on the agent following the instructions. **Live runtimes: UNVERIFIED.**

## Duplicate execution and verification limits

Enable one CMOS hook source in each harness. Cross-source election requires a real,
verified harness-process lifetime; turn deduplication requires a stable turn ID.
Missing identity means no deduplication guarantee. Do not substitute a guessed PID,
hook process PID, timestamp, or prompt-text hash. Native filenames prevent Claude
Code from loading these adapters, but they do not prevent another harness from also
importing existing Claude hooks.

Repository fixture tests cover native config structure, shipped files, payload
normalization and output envelopes. A live verification must additionally show that
the selected harness discovers the configuration, executes the installed CLI, and
delivers the digest exactly once. None of the non-Claude rows above claims that
verification has happened.
