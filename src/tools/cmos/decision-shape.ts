// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — a measured, switched-off detector of decision-shaped statements in an agent's reply.
// ABOUTME: Nothing calls it at runtime in 3.3.0; turning it on would change the loop the G1 window freezes.

/**
 * WHY OFF (decision #1188; design doc s93 m06 fork 1). Q2 asked CMOS to notice a decision nobody
 * recorded. The 3.3.0 loop detects only the explicit `Would record:` line; detecting decision-shaped
 * prose is measured here, on a labelled sample of real transcripts, and stays off until the G1
 * read, because enabling it would change the loop that window measures.
 *
 * THE RULE, fixed before any message was labelled (the plan critic, N12). A message scores one
 * point for each PATTERN family below that matches it, and is flagged at {@link DECISION_SHAPE_THRESHOLD}
 * or more. Families: recommending one option; settling on one; preferring one over another; and
 * proposing to record. Precision and recall on the sample are published in
 * cmos/research/2026-10-s93-probes/m06-measurements.md with the sample's counting rule.
 */

export interface ShapePattern {
  readonly id: string;
  readonly label: string;
  readonly pattern: RegExp;
}

export const DECISION_SHAPE_PATTERNS: readonly ShapePattern[] = [
  {
    id: 'S1',
    label: 'recommends one option',
    pattern:
      /\b(?:i(?:'d| would)? recommend|my recommendation|recommendation:|i(?:'d| would) (?:go|lean|stick) with|i suggest(?: we)?|i propose|the (?:better|right|safest|simplest|cleanest) (?:choice|option|call|approach|fix) is)\b/i,
  },
  {
    id: 'S2',
    label: 'settles on one',
    pattern:
      /\b(?:decided to|decision:|(?:we|i)(?:'ll| will) (?:go with|use|adopt|keep|drop|switch to)|let'?s go with|going with|settled on|chose to|opted (?:for|to))\b/i,
  },
  {
    id: 'S3',
    label: 'prefers one over another',
    pattern:
      /\b(?:rather than|instead of|over the alternative|over option|option [a-c1-3] is|the tradeoff (?:is|favors))\b/i,
  },
  {
    id: 'S4',
    label: 'proposes to record',
    pattern:
      /\b(?:would record:|worth recording|record (?:this|that) as a decision|capture (?:this|that) decision)\b/i,
  },
];

/** Flagged at two families or more: one alone (a "rather than" in passing) was judged too weak. */
export const DECISION_SHAPE_THRESHOLD = 2;

export interface DecisionShape {
  readonly score: number;
  readonly patternIds: readonly string[];
  readonly flagged: boolean;
}

/** Score a message by the published families; pure, and called by nothing at runtime. */
export function decisionShape(text: string): DecisionShape {
  const patternIds = DECISION_SHAPE_PATTERNS.filter((family) => family.pattern.test(text)).map(
    (family) => family.id
  );
  return {
    score: patternIds.length,
    patternIds,
    flagged: patternIds.length >= DECISION_SHAPE_THRESHOLD,
  };
}
