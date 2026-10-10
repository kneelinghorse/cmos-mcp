# Public class-sweep ledgers

Run `node scripts/class-sweeps.js` (or add `--json` for its report). The same
gate runs in `tests/docs/class-sweeps.test.ts` under the normal Jest/CI suite.
It reads tracked **working-tree** source, not a staged-commit snapshot. There is
no additional Git hook and no mutation, database access, build or network call.

## What is checked

The required artifacts are `s92-m03.json`, `s92-m09.json` and `s94-m11.json`.
Their four arms are `readers`, `inserts`, `literal` and `variable`. The validator
pins these names, original ordered predicates, count units and historical source
totals; arbitrary artifacts cannot substitute for required coverage.

| Arm              | Historical counting rule                                                                                                 | Historical count |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| s92-m03/readers  | Physical lines containing case-sensitive `FROM sessions`, then case-insensitive `status`, then case-insensitive `active` | 6                |
| s92-m09/inserts  | Distinct files containing `INSERT INTO context_snapshots`; nine physical matching lines                                  | 9 files          |
| s94-m11/literal  | Physical lines matching `cmos-mcp [a-z]+`, excluding `project-root` and source-comment prefixes                          | 38               |
| s94-m11/variable | Physical lines matching `${command} init` or `${command} ambient off`; two remedies on one line still count once         | 1                |

The m11 source partition is deliberately separate from the original private
whole-tree sweep (201 literal and 2 variable lines). Public artifacts contain
only source text from `src/`; private planning/store prose is never copied here.
Recorded SHAs are provenance labels. The gate does **not** fetch or dereference
them, so an unrelated shallow public history works identically.

The current universe comes from `git ls-files -z --stage -- src/`, across all
extensions. Every ordinary tracked file is read from the working tree with fatal
I/O errors. Unmerged entries, unsafe paths, indexed or actual symlinks, nonregular
files and paths escaping the repository fail. NUL-containing binary files and
invalid UTF-8 are excluded and individually reported. Untracked source, files
outside `src/`, and these artifacts' own evidence strings are outside scope.

## JSON version 1

Each artifact has exactly these fields:

- `schemaVersion`: `1`.
- `mission`, `defectClass`, `scopeSentence`, `falseNegativeProfile` (nonempty
  strings, with the last field an array of nonempty complement statements).
- `universe`: `tracked-src-utf8-lines`.
- `recordedAt`: `{ "sha": "<40 lowercase hexadecimal characters>" }`.
- `arms`: the required arms for this mission, each containing `id`, `unit`,
  `predicate`, `historical`, `witnesses` and `residual`.

`predicate` and `residual` are nonempty ordered arrays of
`{ "op": "include|exclude", "pattern": "<JavaScript regex>", "flags": "" }`.
Every step sees the original physical line, never a `path:line:text` rendering.
Flags may contain each of `i`, `m`, `s`, `u` once; `""` means case-sensitive.
Empty/malformed patterns, POSIX named bracket classes (including negated forms),
unsupported flags and stateful `g`/`y` fail. POSIX-like named-class tokens are
conservatively reserved even where a caller might intend literal text.

`historical` contains `count` and `matches`. Every matched physical line has:

```json
{
  "id": "historical-1",
  "file": "src/example.ts",
  "line": 42,
  "text": "trimmed historical source line",
  "occurrence": 1,
  "class": "changed",
  "reason": "Why this site belonged to the defect class.",
  "resolution": { "witnessIds": ["current-1"] }
}
```

Classes are `changed`, `left` or `outside`. Only `changed` has `resolution`: a
nonempty list of fixed witness IDs, or `{ "removed": true, "reason": "..." }`.
Each historical text must satisfy its original predicate. Arithmetic counts
physical rows for line units and distinct paths for file units; it never counts
regex occurrences. The original physical row totals are pinned as well.

`witnesses` contains records with the same `id`, `file`, `line`, `text`,
`occurrence` and `reason` fields; its classes are `fixed`, `left` or `outside`,
with no `resolution`. Fixed witnesses must be referenced by changed historical
records. New current diagnostic sites are explicit `outside` witnesses, leaving
historical totals intact. Every current witness is required, even when the old
predicate no longer matches its replacement text.

Identity is normalized path + trimmed single-line text + one-based occurrence
among identical lines in that file. Line numbers are diagnostic hints, so harmless
insertions do not invalidate a witness. Occurrence groups have no gaps; duplicate
IDs or occurrence claims fail. Every current predicate hit consumes exactly one
historical `left`/`outside` occurrence or current witness. Overlapping claims fail;
multiple historical references to one fixed witness create only one token.
Witness text multiplicity must match the declared witness budget. An extra
identical matching line therefore fails even when a file-unit count stays fixed.

Missing required current witnesses and residual hits fail. The residual predicate
runs across the entire current source universe, including files absent from the
historical ledger. Explicit removal grants no permission to reintroduce the old
defect. Vanished historical occurrences are reported separately, without failure.

## Limits and independent protection

The gate checks historical ledger consistency, present textual classifications,
required replacement syntax and declared residual predicates. It does not prove
whole-tree compliance, pre-edit chronology, semantic classifications, runtime
dataflow, or compliance with any other sweep. Predicates that miss alternate
spellings, multiline constructs or generated code retain those complements.

The session arm recognizes caller-resolution/explicit-scope syntax;
`implicit-sessions.test.ts` independently retains its multiline SQL ownership
fence. Snapshot witnesses recognize the `storage.columns` INSERT form and name
each site's policy kind. `snapshot-diet.test.ts` retains its broader recursive
untracked-file census plus policy/value and behavioral checks. Remedy witnesses
recognize `formatCliRemedy` calls; existing CLI remedy, hook and init tests verify
actual project resolution and shell behavior. The new ledger gate replaces none
of these protections.

The three standalone script modules export `validateArtifacts(raw)`,
`evaluateSweeps(validated, sources)`, `loadSweepInputs(root)` and
`runClassSweeps(root)`. Source entries are `{ file, lines: string[] }`. Validation
and loading throw on malformed input; `runClassSweeps` converts failures into an
`ok: false` report with named `issues`. Successful loading includes tracked/text
file counts and encoding exclusions; each arm reports historical count, current
unit count, matching physical lines and vanished historical IDs. CLI failures exit
nonzero. The public fixture and mutation tests use temporary Git repositories,
without private evidence or historical objects.
