# rbook/ — this project's record

This folder holds the project's record, kept by Reasonbook at the **Ledger** level: the decisions and
lessons worth carrying from one conversation to the next.

- `db/rbook.sqlite` is the record, and `db/schema.sql` describes its tables.
- `context/` holds the context the record started from.
- `tiers/general.md` tells an agent how to work at this level.
- `templates/` holds the templates the project's `AGENTS.md` and `CLAUDE.md` came from.

Agents keep the record through Reasonbook's tools, so these files need no editing by hand. When the
project needs a list of next steps as well, the Planner level adds one, and nothing recorded is
lost: `rbook_project(action="update", projectType="managed")`.
