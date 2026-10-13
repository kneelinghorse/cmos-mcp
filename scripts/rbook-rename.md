# Reasonbook source rename

The default command previews the rename. It never changes source files without `--apply`.
The policy in `rbook-rename-protected.json` is the single list used by the transformation and
residual checker. Every protection and reviewed replacement has a reason and an occurrence
count. Whole-file modes count files; span modes count regex matches. The commands below run
from the repository root.

Before capturing, finish the compatibility mission and stage newly created implementation,
policy and fixture files. The inventory is `git ls-files --stage -z`: unstaged edits of tracked
files are included, while untracked files are outside the inventory. This script does not stage
files or commit. It reports excluded binary, invalid UTF-8 and nonregular files.

```sh
node scripts/rbook-rename.js --capture-counts
npx prettier --write scripts/rbook-rename-protected.json
node scripts/rbook-rename.js --report /tmp/rbook-rename-preview.json
```

A nonzero preview exit is expected while there are unresolved command/host tokens, manual
transition changes, lost protections or malformed proposed names. The report contains path,
line, reason and before/after hashes, without copying source text. Inspect the exact source
lines and proposed diff; add only reviewed span replacements/protections to the policy, or
make the required manual changes. Recapture after intentional policy or input changes.
`capturedAgainst` records the actual HEAD; the original pre-edit universe remains separate
private research evidence.

The generic pass distinguishes Reasonbook prose, `rbook` identifiers and `reasonbook` install
names. Current module references and declared symbol identifiers inside compatibility fixtures
follow renamed exports, while strings, setting keys and stored property keys retain their
old fixture values. Ledger current witnesses, residuals and universe fields follow renamed
paths; predicates and historical fields remain unchanged. Active private procedure text changes,
and this repository's current record paths use `rbook/` after its offline migration.

After the preview has no blocking issues and its review list has been inspected:

```sh
node scripts/rbook-rename.js --apply --expect-head "$(git rev-parse HEAD)" --expect-input "$(node -p "require('/tmp/rbook-rename-preview.json').inputHash")" --report /tmp/rbook-rename-applied.json
```

The required input hash binds every input path, mode and content hash plus the policy to the
reviewed preview. Any intervening source/policy edit requires another preview and review.
Application rechecks source hashes and path safety, refuses existing destinations, writes
replacement content atomically and rolls back completed writes if a later write fails. It
moves files on disk; stage the resulting tracked renames with the normal mission workflow
before checking the Git inventory again. Do not run other writers during application.

```sh
node scripts/rbook-rename.js --check --report /tmp/rbook-rename-after.json
node scripts/rbook-rename.js --check --public-only --report /tmp/rbook-rename-public-after.json
npx jest tests/docs/rbook-rename.test.ts --runInBand --coverage=false
```

The public-only mode uses separately captured public counts and the mirror's private path
exclusions, so it also runs in a mirror checkout without private records. Full-tree application
always checks full counts. If the mirror exclusions change, update `publicExcludes` in the
policy too. Neither check substitutes for compiler, unit, built-server, installation or media
verification; computed names and natural-language meaning still need review. The checker also
reports transition wording and short-name product prose for inspection, even when the literal
old-name and malformed-output predicates return zero.
