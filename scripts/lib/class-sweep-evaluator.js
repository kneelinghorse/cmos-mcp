// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Consumes one classification per matching physical source line and checks required repairs.
// ABOUTME: Historical disappearance is informational; residual defects and lost current witnesses fail.
const { matchesPredicate, groupKey, occurrenceKey } = require('./class-sweep-schema');

function sourceOccurrences(sources) {
  const rows = [];
  for (const { file, lines } of sources) {
    const counts = new Map();
    lines.forEach((raw, index) => {
      const text = raw.trim();
      const occurrence = (counts.get(text) ?? 0) + 1;
      counts.set(text, occurrence);
      rows.push({ file, line: index + 1, raw, text, occurrence });
    });
  }
  return rows;
}

function evaluateSweeps(artifacts, sources) {
  const rows = sourceOccurrences(sources);
  const present = new Map(rows.map((row) => [occurrenceKey(row), row]));
  const counts = new Map();
  for (const row of rows) counts.set(groupKey(row), (counts.get(groupKey(row)) ?? 0) + 1);
  const issues = [];
  const sweeps = [];
  for (const artifact of artifacts) {
    for (const arm of artifact.arms) {
      const label = `${artifact.mission}/${arm.id}`;
      const hits = rows.filter((row) => matchesPredicate(row.raw, arm.compiledPredicate));
      const tokens = new Set(
        [...arm.historical.matches.filter((row) => row.class !== 'changed'), ...arm.witnesses].map(
          occurrenceKey
        )
      );
      for (const hit of hits) {
        if (!tokens.delete(occurrenceKey(hit)))
          issues.push(`${label}: unclassified ${hit.file}:${hit.line}: ${hit.text}`);
      }
      const witnessCounts = new Map();
      for (const witness of arm.witnesses) {
        const key = groupKey(witness);
        witnessCounts.set(key, (witnessCounts.get(key) ?? 0) + 1);
        if (!present.has(occurrenceKey(witness)))
          issues.push(`${label}: missing required witness ${witness.id} (${witness.file})`);
      }
      for (const [key, count] of witnessCounts) {
        if ((counts.get(key) ?? 0) !== count)
          issues.push(`${label}: witness multiplicity changed for ${key}`);
      }
      for (const row of rows) {
        if (matchesPredicate(row.raw, arm.compiledResidual))
          issues.push(`${label}: residual defect ${row.file}:${row.line}: ${row.text}`);
      }
      sweeps.push({
        mission: artifact.mission,
        arm: arm.id,
        unit: arm.unit,
        historicalCount: arm.historical.count,
        currentCount: arm.unit === 'files' ? new Set(hits.map((r) => r.file)).size : hits.length,
        currentMatchingLines: hits.length,
        vanishedHistorical: arm.historical.matches
          .filter((row) => !present.has(occurrenceKey(row)))
          .map((row) => row.id),
      });
    }
  }
  return { ok: issues.length === 0, sweeps, issues };
}

module.exports = { evaluateSweeps };
