// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m04 — which rules in force a prompt restates, by keyword overlap (the §10 restatement rate).
// ABOUTME: Ids only (c:N, l:N); the prompt's text is read here and never kept.

/**
 * THE RULE (published with the instrument, s93-m04). The rules in force are the project's active,
 * unexpired constraints and active evergreen learnings (the digest's "rules in force"). A prompt
 * restates one when the IDF-weighted cosine between their content terms is at least
 * {@link RESTATEMENT_THRESHOLD} and they share at least {@link RESTATEMENT_MIN_SHARED} terms.
 * Content terms: lowercased words of three or more characters, a fixed stopword list removed, a
 * light suffix stem; IDF is taken over the rules in force, so a word every rule uses weighs little.
 *
 * CALIBRATION (offline, the last 30 days of operator prompts in the three G1 projects, against
 * copies of their stores, each prompt matched only against the rules that existed when it was
 * typed): no prompt reached the threshold; the highest pair scored 0.21. Matched against today's
 * rules instead, one prompt scored 0.30 against the learning captured from it: the hook matches
 * the rules in force when the prompt arrives, so that cannot happen live.
 */

export const RESTATEMENT_THRESHOLD = 0.3;
export const RESTATEMENT_MIN_SHARED = 5;

const STOPWORDS = new Set(
  (
    'a about above after again against all also am an and any are as at be because been before ' +
    'being below between both but by can could did do does doing down during each few for from ' +
    'further had has have having he her here hers him his how i if in into is it its itself just ' +
    'let lets me more most my no nor not now of off on once only or other our ours out over own ' +
    'same she should so some such than that the their them then there these they this those ' +
    'through to too under until up very was we were what when where which while who whom why will ' +
    'with would you your yours yes ok okay sure please thanks great good fine like make want need ' +
    'get got go going one two use used using still even back well really much many way new next ' +
    'time thing things think know see look done work working right'
  ).split(' ')
);

function stem(word: string): string {
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (word.length > suffix.length + 3 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/** The content terms of a text, as the rule above defines them. */
export function contentTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []) {
    if (!STOPWORDS.has(word)) terms.add(stem(word));
  }
  return terms;
}

/** One rule in force: its typed id (`c:N` or `l:N`) and its text. */
export interface RuleInForce {
  readonly id: string;
  readonly content: string;
}

/** The typed ids of the rules in force the prompt restates, best match first. */
export function restatedRuleIds(prompt: string, rules: readonly RuleInForce[]): string[] {
  if (rules.length === 0) return [];
  const promptTerms = contentTerms(prompt);
  if (promptTerms.size === 0) return [];
  const ruleTerms = rules.map((rule) => ({ id: rule.id, terms: contentTerms(rule.content) }));
  const documentFrequency = new Map<string, number>();
  for (const { terms } of ruleTerms) {
    for (const term of terms) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const weight = (term: string): number => {
    const idf = Math.log((rules.length + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1;
    return idf * idf;
  };
  const norm = (terms: Set<string>): number =>
    Math.sqrt([...terms].reduce((sum, term) => sum + weight(term), 0));
  const promptNorm = norm(promptTerms);
  const hits: Array<{ id: string; score: number }> = [];
  for (const { id, terms } of ruleTerms) {
    const shared = [...terms].filter((term) => promptTerms.has(term));
    if (shared.length < RESTATEMENT_MIN_SHARED) continue;
    const score = shared.reduce((sum, term) => sum + weight(term), 0) / (promptNorm * norm(terms));
    if (score >= RESTATEMENT_THRESHOLD) hits.push({ id, score });
  }
  return hits.sort((a, b) => b.score - a.score).map((hit) => hit.id);
}
