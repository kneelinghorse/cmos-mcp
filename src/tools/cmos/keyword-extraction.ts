// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Canonical pure keyword extraction shared by retrieval and the lightweight prompt hook.
// ABOUTME: Keeps token ordering and stop words consistent without loading retriever dependencies.

const MIN_KEYWORD_LENGTH = 3;

/**
 * Extract meaningful keywords from decision text: whole lower-cased tokens, stop words removed.
 */
export function extractKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= MIN_KEYWORD_LENGTH);

  const unique = [...new Set(tokens)].filter((t) => !STOP_WORDS.has(t));
  return unique;
}

/**
 * Common English stop words to filter from keyword extraction.
 */
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'but',
  'not',
  'you',
  'all',
  'can',
  'had',
  'her',
  'was',
  'one',
  'our',
  'out',
  'has',
  'have',
  'been',
  'will',
  'from',
  'they',
  'each',
  'make',
  'like',
  'been',
  'this',
  'that',
  'with',
  'into',
  'then',
  'than',
  'them',
  'these',
  'some',
  'would',
  'other',
  'about',
  'which',
  'when',
  'what',
  'there',
  'their',
  'said',
  'use',
  'used',
  'using',
  'should',
  'also',
  'does',
  'did',
  'just',
  'more',
  'most',
  'very',
  'after',
  'before',
  'between',
  'could',
  'still',
  'over',
  'such',
  'only',
  'where',
  'while',
  'being',
  'same',
  'both',
  'way',
]);
