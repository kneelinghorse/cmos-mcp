// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Validates the three public class-sweep ledgers and their physical occurrence budgets.
// ABOUTME: Pins published predicates without loading private provenance or historical Git objects.
const step = (pattern, flags = '', op = 'include') => ({ op, pattern, flags });
const REQUIRED = {
  's92-m03': {
    readers: {
      unit: 'lines',
      count: 6,
      predicate: [step('FROM sessions'), step('status', 'i'), step('active', 'i')],
    },
  },
  's92-m09': {
    inserts: { unit: 'files', count: 9, predicate: [step('INSERT INTO context_snapshots')] },
  },
  's94-m11': {
    literal: {
      unit: 'lines',
      count: 38,
      predicate: [
        step('cmos-mcp [a-z]+'),
        step('project-root', '', 'exclude'),
        step('^\\s*(//|\\*|/\\*)', '', 'exclude'),
      ],
    },
    variable: { unit: 'lines', count: 1, predicate: [step('\\$\\{command\\} (init|ambient off)')] },
  },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function object(value, required, optional = []) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'expected object');
  assert(
    required.every((key) => Object.hasOwn(value, key)),
    `missing required fields: ${required.join(', ')}`
  );
  assert(
    Object.keys(value).every((key) => [...required, ...optional].includes(key)),
    'unknown schema key'
  );
}
function nonempty(value, label) {
  assert(typeof value === 'string' && value.trim().length > 0, `empty or invalid ${label}`);
}
function positive(value, label) {
  assert(Number.isSafeInteger(value) && value > 0, `invalid ${label}`);
}
function unique(values, label) {
  assert(new Set(values).size === values.length, `duplicate ${label}`);
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function safePath(file, prefix = 'src/') {
  nonempty(file, 'path');
  assert(
    file.startsWith(prefix) &&
      !file.includes('\\') &&
      ![...file].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) &&
      file.split('/').every((part) => part && part !== '.' && part !== '..'),
    `unsafe path: ${file}`
  );
  return file;
}

function compilePredicate(steps) {
  assert(Array.isArray(steps) && steps.length > 0, 'empty predicate');
  assert(
    steps.some((entry) => entry.op === 'include'),
    'predicate requires include'
  );
  return steps.map((entry) => {
    object(entry, ['op', 'pattern', 'flags']);
    assert(['include', 'exclude'].includes(entry.op), 'invalid predicate operation');
    nonempty(entry.pattern, 'regex pattern');
    assert(
      typeof entry.flags === 'string' &&
        /^[imsu]*$/.test(entry.flags) &&
        new Set(entry.flags).size === entry.flags.length,
      'unsupported or duplicate regex flags'
    );
    assert(!/\[:[^\]]*:\]/.test(entry.pattern), 'POSIX bracket class is not a JavaScript regex');
    let regex;
    try {
      regex = new RegExp(entry.pattern, entry.flags);
    } catch (error) {
      throw new Error(`malformed regex: ${error.message}`);
    }
    return { op: entry.op, regex };
  });
}
function matchesPredicate(text, compiled) {
  return compiled.every(({ op, regex }) => regex.test(text) === (op === 'include'));
}
const groupKey = (row) => JSON.stringify([row.file, row.text]);
const occurrenceKey = (row) => JSON.stringify([row.file, row.text, row.occurrence]);

function validateRow(row, historical) {
  object(
    row,
    ['id', 'file', 'line', 'text', 'occurrence', 'class', 'reason'],
    historical ? ['resolution'] : []
  );
  nonempty(row.id, 'record id');
  safePath(row.file);
  positive(row.line, 'diagnostic line');
  nonempty(row.text, 'source text');
  assert(
    row.text === row.text.trim() && !/[\r\n]/.test(row.text),
    'source text must be one trimmed physical line'
  );
  positive(row.occurrence, 'occurrence');
  nonempty(row.reason, 'classification reason');
  assert(
    (historical ? ['changed', 'left', 'outside'] : ['fixed', 'left', 'outside']).includes(
      row.class
    ),
    'unknown classification'
  );
}
function occurrences(rows, label) {
  unique(
    rows.map((r) => r.id),
    `${label} record id`
  );
  unique(rows.map(occurrenceKey), `${label} occurrence`);
  const groups = new Map();
  for (const row of rows) {
    const key = groupKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.occurrence);
  }
  for (const values of groups.values()) {
    values.sort((a, b) => a - b);
    assert(
      values.every((value, i) => value === i + 1),
      `${label} occurrence gap`
    );
  }
}

function validateArm(arm, specification) {
  object(arm, ['id', 'unit', 'predicate', 'historical', 'witnesses', 'residual']);
  assert(specification, `unknown required arm: ${arm.id}`);
  assert(
    arm.unit === specification.unit && same(arm.predicate, specification.predicate),
    `required predicate or unit changed: ${arm.id}`
  );
  const predicate = compilePredicate(arm.predicate);
  const residual = compilePredicate(arm.residual);
  object(arm.historical, ['count', 'matches']);
  const history = arm.historical.matches;
  assert(Array.isArray(history), 'historical matches must be an array');
  assert(Array.isArray(arm.witnesses), 'witnesses must be an array');
  history.forEach((row) => validateRow(row, true));
  arm.witnesses.forEach((row) => validateRow(row, false));
  occurrences(history, 'historical');
  occurrences(arm.witnesses, 'witness');
  assert(
    history.every((row) => matchesPredicate(row.text, predicate)),
    'historical record does not match predicate'
  );
  const count = arm.unit === 'files' ? new Set(history.map((r) => r.file)).size : history.length;
  assert(
    count === arm.historical.count &&
      count === specification.count &&
      history.length === specification.count,
    `inconsistent historical count: ${arm.id}`
  );
  const witnesses = new Map(arm.witnesses.map((row) => [row.id, row]));
  const referenced = new Set();
  for (const row of history) {
    if (row.class !== 'changed') {
      assert(!Object.hasOwn(row, 'resolution'), 'unchanged historical record has a resolution');
      continue;
    }
    const resolution = row.resolution;
    if (resolution?.removed === true) {
      object(resolution, ['removed', 'reason']);
      nonempty(resolution.reason, 'removal reason');
    } else {
      object(resolution, ['witnessIds']);
      assert(
        Array.isArray(resolution.witnessIds) && resolution.witnessIds.length > 0,
        'missing replacement witness'
      );
      unique(resolution.witnessIds, 'witness reference');
      for (const id of resolution.witnessIds) {
        assert(witnesses.get(id)?.class === 'fixed', `missing fixed witness reference: ${id}`);
        referenced.add(id);
      }
    }
  }
  assert(
    arm.witnesses.every((w) => w.class !== 'fixed' || referenced.has(w.id)),
    'unreferenced fixed witness'
  );
  const tokens = [...history.filter((r) => r.class !== 'changed'), ...arm.witnesses];
  unique(tokens.map(occurrenceKey), 'overlapping current classification');
  return { ...arm, compiledPredicate: predicate, compiledResidual: residual };
}

function validateArtifacts(artifacts) {
  assert(Array.isArray(artifacts), 'artifacts must be an array');
  unique(
    artifacts.map((a) => a?.mission),
    'mission artifact'
  );
  assert(
    same(artifacts.map((a) => a?.mission).sort(), Object.keys(REQUIRED).sort()),
    'missing or unknown required artifact'
  );
  return [...artifacts]
    .sort((a, b) => a.mission.localeCompare(b.mission))
    .map((artifact) => {
      object(artifact, [
        'schemaVersion',
        'mission',
        'defectClass',
        'scopeSentence',
        'falseNegativeProfile',
        'universe',
        'recordedAt',
        'arms',
      ]);
      assert(
        artifact.schemaVersion === 1 && artifact.universe === 'tracked-src-utf8-lines',
        'unknown schema or universe'
      );
      nonempty(artifact.defectClass, 'defect class');
      nonempty(artifact.scopeSentence, 'scope sentence');
      assert(
        Array.isArray(artifact.falseNegativeProfile) && artifact.falseNegativeProfile.length > 0,
        'missing false-negative profile'
      );
      artifact.falseNegativeProfile.forEach((s) => nonempty(s, 'scope complement'));
      object(artifact.recordedAt, ['sha']);
      assert(/^[a-f0-9]{40}$/.test(artifact.recordedAt.sha), 'invalid recorded SHA');
      assert(Array.isArray(artifact.arms), 'missing required arms');
      const required = REQUIRED[artifact.mission];
      unique(
        artifact.arms.map((a) => a.id),
        'arm'
      );
      assert(
        same(artifact.arms.map((a) => a.id).sort(), Object.keys(required).sort()),
        'missing or unknown required arm'
      );
      return {
        ...artifact,
        arms: [...artifact.arms]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((a) => validateArm(a, required[a.id])),
      };
    });
}

module.exports = {
  REQUIRED,
  validateArtifacts,
  compilePredicate,
  matchesPredicate,
  safePath,
  groupKey,
  occurrenceKey,
};
