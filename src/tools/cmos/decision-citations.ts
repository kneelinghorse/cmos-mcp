// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Reads explicit local typed references without guessing the namespace of a bare number.
// ABOUTME: Shared by first-prompt decision edges and digest rule counts; bounded ranges preserve order.

type Prefix = 'd' | 'l' | 'c' | 'n';
const TYPES: Readonly<Record<string, Prefix>> = {
  decision: 'd',
  decisions: 'd',
  ruling: 'd',
  rulings: 'd',
  learning: 'l',
  learnings: 'l',
  lesson: 'l',
  lessons: 'l',
  constraint: 'c',
  constraints: 'c',
  invariant: 'c',
  invariants: 'c',
  'next-step': 'n',
  'next-steps': 'n',
  next_step: 'n',
  next_steps: 'n',
  nextstep: 'n',
  nextsteps: 'n',
};
const FILLER = new Set(
  (
    'the a an of per from in by see to and or with its their our my this that these those ' +
    'active archived superseded open pending all both earlier prior previous original older new same as at on cf via under ' +
    'into also two three four five six seven eight nine ten which whose existing standing ratified captured recorded live old own prior-sprint'
  ).split(' ')
);
const CONNECTIVES = new Set(
  (
    'keep keeps kept follow follows following use uses using apply applies applying implement implements implemented ' +
    'per see cite cites cited citing reference references referenced supersede supersedes superseding correct corrects ' +
    'correcting reaffirm reaffirms revisit revisits adopt adopts adopting supports support supported preserves preserve ' +
    'retain retains retained restates restate establishes establish established'
  ).split(' ')
);
const FOREIGN = new Set([
  'foreign',
  'sibling',
  'upstream',
  'external',
  'project',
  'store',
  'repository',
]);
const TOKEN = /[A-Za-z][A-Za-z0-9_'-]*|\d+|[.;!?()\n—]|--/g;
const CITATION = /\b([dlcn]):([1-9]\d*)\b|(?<![A-Za-z0-9_])#([1-9]\d*)\b(?:\s*[-–]\s*#?(\d+)\b)?/gi;
const CHAIN = /^(?:\([^)#]{0,14}\))?[\s,;/&+]*(?:and|or|plus)?[\s,;/&+]*$/i;
const normalize = (word: string): string => word.toLowerCase().replace(/'s$/, '').replace(/-$/, '');

const MODIFIERS = new Set(
  'active archived superseded open pending earlier prior previous original older new same existing standing ratified captured recorded live old own prior-sprint'.split(
    ' '
  )
);

function qualified(tokens: RegExpMatchArray[], before: number): boolean {
  for (let i = before - 1; i >= 0; i--) {
    const raw = tokens[i][0];
    if (raw === '(') {
      const label = tokens[i - 1]?.[0] ?? '';
      const word = normalize(label);
      const localWork = /^(?:sprint-?\d+|s\d+(?:-m\d+|-review)?|m\d+)$/i.test(word);
      return (
        FOREIGN.has(word) ||
        (!localWork &&
          !FILLER.has(word) &&
          !CONNECTIVES.has(word) &&
          /^[A-Z][A-Za-z0-9-]+$/.test(label))
      );
    }
    if (!/^[A-Za-z]/.test(raw)) return false;
    const word = normalize(raw);
    if (MODIFIERS.has(word)) continue;
    return !FILLER.has(word) && !CONNECTIVES.has(word);
  }
  return false;
}

function explicitType(text: string, start: number): Prefix | null {
  const window = text.slice(Math.max(0, start - 80), start);
  const tokens = [...window.matchAll(TOKEN)];
  let fillers = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const raw = tokens[i][0];
    const word = normalize(raw);
    if (raw === '(') continue;
    if (/^[.;!?)\n—]|^--$/.test(raw)) return null;
    if (FOREIGN.has(word)) return null;
    if (TYPES[word]) {
      // A named qualifier before the type is not a local namespace. Ordinary connective words
      // are published above; e.g. "this decision" is local, "Stage1 decision" is not.
      return qualified(tokens, i) ? null : TYPES[word];
    }
    if ((FILLER.has(word) || /^\d+$/.test(word)) && ++fillers <= 4) continue;
    return null;
  }
  return null;
}

/** Explicit d/l/c/n references only, unique in appearance order. No bare #N fallback. */
export function typedCitations(text: string): string[] {
  // Examples in code, URI fragments and linked external labels do not establish local edges.
  const barrier = (match: string): string => '.'.repeat(match.length);
  const visible = text
    .replace(
      /⟪untrusted\b[\s\S]*?(?:⟪\/untrusted⟫|$)|\[UNTRUSTED DATA[\s\S]*?(?:\[END UNTRUSTED DATA\]|$)/gi,
      barrier
    )
    .replace(
      /```[\s\S]*?```|`[^`\n]*`|\[[^\]\n]*\]\([^\n)]*\)|\b[a-z][a-z0-9+.-]*:\/\/\S+/gi,
      barrier
    );
  const result = new Set<string>();
  let previousEnd = -1;
  let previousType: Prefix | null = null;
  for (const match of visible.matchAll(CITATION)) {
    const start = match.index!;
    const end = start + match[0].length;
    const typed = match[1]?.toLowerCase() as Prefix | undefined;
    const prefixTokens = [...visible.slice(Math.max(0, start - 80), start).matchAll(TOKEN)];
    const foreign =
      typed &&
      (/[\w:/.-]/.test(visible[start - 1] ?? '') || qualified(prefixTokens, prefixTokens.length));
    const malformed =
      /[\w]/.test(visible[end] ?? '') ||
      /^\.\d/.test(visible.slice(end)) ||
      (typed !== undefined && /^\s*[-–]\s*#?\d/.test(visible.slice(end)));
    const continuation = previousEnd >= 0 && CHAIN.test(visible.slice(previousEnd, start));
    const prefix: Prefix | null =
      foreign || malformed
        ? null
        : (typed ?? (continuation ? previousType : explicitType(visible, start)));
    previousEnd = end;
    previousType = prefix;
    if (!prefix) continue;
    const first = Number(match[2] ?? match[3]);
    const last = match[4] === undefined ? first : Number(match[4]);
    if (
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(last) ||
      first <= 0 ||
      last < first ||
      last - first > 12
    ) {
      previousType = null;
      continue;
    }
    for (let id = first; id <= last; id++) result.add(`${prefix}:${id}`);
  }
  return [...result];
}

/** Decision-only projection; the caller separately proves local origin, existence and time. */
export function decisionCitations(text: string): number[] {
  return typedCitations(text)
    .filter((id) => id.startsWith('d:'))
    .map((id) => Number(id.slice(2)));
}
