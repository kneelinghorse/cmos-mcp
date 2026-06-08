# Pack Manifest Style Guide

Authoring mission pack manifests (`pack.yaml`) follows a tight baseline so the template registry stays predictable and easy to lint. These conventions are enforced by `npm run validate:packs`.

## Required Fields

- `name` – lower-case slug composed of letters, numbers, dots, or hyphens.
- `version` – semantic version string (e.g. `1.0.0`).
- `displayName` – concise human-facing title for UI surfaces.
- `description` – one-sentence summary of the mission (≤ 200 characters).
- `author` – owning team or role.
- `schema` – relative path to the pack schema (defaults to `schema.json`).

All fields are required, non-empty strings.

## Formatting Rules

- Declare fields in a single-line `key: "value"` form with double quotes and no inline comments.
- Escape embedded quotes using `\"` and avoid multi-line scalars.
- Keep descriptions focused and under 200 characters; trim trailing punctuation or redundant clauses if needed.
- Stick to ASCII characters unless the mission domain demands otherwise.

## Validation Workflow

1. Edit the manifest.
2. Run `npm run validate:packs` to lint registry, manifests, templates, and workflow samples.
3. Fix any reported style or validation violations before committing.

These rules ensure every pack serializes cleanly, generates predictable diffs, and surfaces consistent copy in downstream tools.
