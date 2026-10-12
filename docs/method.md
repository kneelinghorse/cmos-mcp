# The method

Reasonbook keeps a project's record. The method is how that record is kept: five lines, and three
levels of structure a project can grow into.

## Five lines

1. **One project, one record.** Each project keeps its own decisions, lessons, rules and next steps,
   in its own folder. Reading across projects is a view, never a shared store.
2. **Every session starts from the record.** Where hooks run (the Claude Code and Codex plugins), a
   digest of the record comes into each session on its own; elsewhere the agent starts with
   `rbook_review`.
3. **Decisions are deliberate.** Record one when someone will later ask why. Never edit a decision;
   record a new one that supersedes it.
4. **Nothing is forgotten silently.** Records expire, go stale or are superseded in the open. A
   sprint close keeps decisions and lessons active unless you ask it to archive them, and lists any
   next step it drops with the command that restores it.
5. **The record outlives the tool.** It is a SQLite file in the project, and the agents connected
   to its server all read the same record.

## Three levels

| Level       | What the project keeps                            | What Reasonbook does on its own, where hooks run                                                                                                                                                    |
| ----------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ledger**  | Decisions and lessons, with rules and constraints | A digest at session start; the past decisions related to each prompt; records the agent proposes wait as drafts for your approval, at most three at a time; sessions open and close by themselves   |
| **Planner** | Adds next steps, as tasks in cycles               | Also: the digest lists up to five open next steps and flags the ones going stale                                                                                                                    |
| **Builder** | Adds sprints and missions                         | Also: the digest names the current mission, starting a mission returns related past decisions, and a sprint close keeps the record active by default; a retrospective is there when you ask for one |

The levels share one record and one set of tools. A level changes what the digest shows and which
starter files the project gets.

## Moving up

Start at the level the project needs today, and move up when it needs more structure:

- in the project folder, `reasonbook init --level planner` (or `builder`);
- or ask the agent, which calls `rbook_project(action="update", projectType="managed")` for Planner
  or `projectType="build"` for Builder.

Moving up stores the new level, adds that level's files under `rbook/` without overwriting yours, and
updates the record line in `AGENTS.md` if Reasonbook wrote it. Nothing is converted or removed, and
moving down removes nothing either. The digest suggests the move: a Ledger with five or more open
next steps is told to consider Planner, and a Planner with ten or more open tasks to consider
Builder.

The [starter templates](../templates/) hold the `AGENTS.md` and `CLAUDE.md` each level starts with.
