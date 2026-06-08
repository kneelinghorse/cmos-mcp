import { describe, expect, it } from '@jest/globals';
import {
  sanitizeContentField,
  sanitizeFields,
  sanitizeStringArray,
  mergeSanitizedFields,
} from '../../src/intelligence/content-sanitizer';

describe('sanitizeContentField', () => {
  it('passes clean text through untouched', () => {
    const input = 'A perfectly reasonable decision about architecture.';
    const result = sanitizeContentField(input);
    expect(result).toEqual({ cleaned: input, wasModified: false });
  });

  it('strips the </content> artifact and everything after it', () => {
    const input =
      'The real decision text we want to keep.</content>\n<parameter name="missionId">s55-m01';
    const result = sanitizeContentField(input);
    expect(result.wasModified).toBe(true);
    expect(result.cleaned).toBe('The real decision text we want to keep.');
    expect(result.reason).toContain('XML marshalling artifact');
  });

  it('strips a mid-string <parameter name="…"> artifact', () => {
    const input =
      'We chose option B.\n<parameter name="missionId">s55-m01</parameter>\ntrailing noise';
    const result = sanitizeContentField(input);
    expect(result.wasModified).toBe(true);
    expect(result.cleaned).toBe('We chose option B.');
  });

  it('strips to the first artifact occurrence when multiple are present', () => {
    const input =
      'Keep this part.</content>strip from here<parameter name="x">more trailing</parameter>';
    const result = sanitizeContentField(input);
    expect(result.cleaned).toBe('Keep this part.');
  });

  it('preserves XML-looking tokens inside a triple-backtick code fence', () => {
    const input =
      'Here is a React snippet we reviewed:\n```tsx\n<content>hello</content>\n```\nand we decided to use it.';
    const result = sanitizeContentField(input);
    expect(result.wasModified).toBe(false);
    expect(result.cleaned).toBe(input);
  });

  it('still strips artifacts that appear AFTER a closing code fence', () => {
    const input =
      'Context: ```tsx\n<content>x</content>\n```\nResolution.</content>\n<parameter name="missionId">y';
    const result = sanitizeContentField(input);
    expect(result.wasModified).toBe(true);
    expect(result.cleaned).toContain('Resolution.');
    expect(result.cleaned).toContain('```tsx');
    expect(result.cleaned).not.toContain('<parameter name="missionId">y');
  });

  it('handles <invoke> and <function_calls> harness tags as well', () => {
    const input = 'Decision captured.<function_calls>...noise...</function_calls>';
    const result = sanitizeContentField(input);
    expect(result.wasModified).toBe(true);
    expect(result.cleaned).toBe('Decision captured.');
  });

  it('trims trailing whitespace left behind after the strip', () => {
    const input = 'Decision text   \n\n</content>extra';
    const result = sanitizeContentField(input);
    expect(result.cleaned).toBe('Decision text');
  });

  it('returns input unchanged when empty or not a string', () => {
    expect(sanitizeContentField('')).toEqual({ cleaned: '', wasModified: false });
    // @ts-expect-error testing defensive non-string path
    expect(sanitizeContentField(null).wasModified).toBe(false);
    // @ts-expect-error testing defensive non-string path
    expect(sanitizeContentField(undefined).wasModified).toBe(false);
  });

  it('does not over-match on XML-like tags that are not in the tracked set', () => {
    const input = 'We reviewed <br/> and <div>ok</div> and kept them.';
    const result = sanitizeContentField(input);
    expect(result.wasModified).toBe(false);
    expect(result.cleaned).toBe(input);
  });
});

describe('Sprint 65 m04: inline backtick span carve-out + unclosed-fence guardrail', () => {
  // The original Sprint 56 m02 sanitizer only carved out triple-backtick fences.
  // Agent prose that quoted XML tokens as data (e.g. `<content>`) still got
  // truncated — even s65-m04's own mission spec got truncated three times
  // during planning (decision #691). Sprint 65 m04 adds inline-backtick-span
  // detection and explicitly tests the unclosed-fence guardrail.

  // (a) — bare angle-bracketed tag outside any fence → sanitizer fires
  it('(a) sanitizer fires on a bare angle-bracketed content-tag outside any fence', () => {
    const input = 'Decision text.</content>\n<parameter name="missionId">noise';
    const result = sanitizeContentField(input);
    expect(result.wasModified).toBe(true);
    expect(result.cleaned).toBe('Decision text.');
  });

  // (b) — same tag pattern inside a triple-backtick fence → preserved
  // (Already covered by the original suite — re-asserted here for completeness.)
  it('(b) sanitizer skips on the tag pattern inside a triple-backtick fence', () => {
    const input =
      'Reviewing snippet:\n```tsx\n<parameter name="x">val</parameter>\n```\nlooks fine.';
    const result = sanitizeContentField(input);
    expect(result.wasModified).toBe(false);
    expect(result.cleaned).toBe(input);
  });

  // (c) — tag pattern inside an inline backtick span → preserved (the new case)
  it('(c) sanitizer skips on the tag pattern inside an inline backtick span', () => {
    const input = 'The sanitizer detects `<parameter name="x">` and `</content>` as artifacts.';
    const result = sanitizeContentField(input);
    expect(result.wasModified).toBe(false);
    expect(result.cleaned).toBe(input);
  });

  // (d) — UNCLOSED triple-backtick fence → still sanitizes
  it('(d) sanitizer fires on the tag pattern inside an UNCLOSED triple-backtick fence', () => {
    // Opening ``` with no closing ``` — must not be treated as a code fence.
    const input = 'Intro\n```tsx\n<content>data</content>\nno closing fence';
    const result = sanitizeContentField(input);
    expect(result.wasModified).toBe(true);
    // Preserves text up to the first artifact, including the unclosed fence marker.
    expect(result.cleaned).toContain('```tsx');
    expect(result.cleaned).not.toContain('<content>data</content>');
  });

  // (e) — multi-fragment mix: one fenced, one bare → only the bare one is stripped
  it('(e) multi-fragment payload — protects fenced occurrences, sanitizes bare ones', () => {
    const input =
      'Quoted in prose: `<content>safe</content>`\n```tsx\n<parameter name="y">also safe</parameter>\n```\nBut here it is bare: <function_calls>NOT safe</function_calls>';
    const result = sanitizeContentField(input);
    expect(result.wasModified).toBe(true);
    // Both protected fragments survive in the cleaned output.
    expect(result.cleaned).toContain('`<content>safe</content>`');
    expect(result.cleaned).toContain('<parameter name="y">also safe</parameter>');
    // The bare artifact (and everything after) is stripped.
    expect(result.cleaned).not.toContain('NOT safe');
    expect(result.cleaned).not.toContain('<function_calls>');
  });

  // Extra coverage: dangling/unclosed inline backtick must NOT be treated as a span.
  it('dangling unclosed inline backtick still triggers sanitization on a following bare tag', () => {
    // The lone backtick at the start has no closing partner on the same line.
    const input = 'a lone ` backtick, then bare: </content>noise';
    const result = sanitizeContentField(input);
    expect(result.wasModified).toBe(true);
    expect(result.cleaned).toContain('a lone ` backtick');
    expect(result.cleaned).not.toContain('noise');
  });

  // Sanity: triple-fence detection still takes precedence over inline-span detection
  // when the fence contains backticks of its own (no double-counting).
  it('inline-span detection does not over-match into a triple-fence interior', () => {
    const input = 'Sample:\n```ts\nconst s = `nested template`;\n<content>x</content>\n```\nafter.';
    const result = sanitizeContentField(input);
    expect(result.wasModified).toBe(false);
    expect(result.cleaned).toBe(input);
  });
});

describe('sanitizeFields', () => {
  it('returns input unchanged when no field was modified', () => {
    const obj = { content: 'fine', summary: 'also fine', missionId: 's56-m02' };
    const result = sanitizeFields(obj, ['content', 'summary']);
    expect(result.sanitized).toBe(obj);
    expect(result.sanitizedFields).toHaveLength(0);
  });

  it('sanitizes only the named string fields', () => {
    const obj = {
      content: 'legit.</content>noise',
      summary: 'fine',
      missionId: 's56-m02',
    };
    const result = sanitizeFields(obj, ['content', 'summary']);
    expect(result.sanitized).not.toBe(obj);
    expect(result.sanitized.content).toBe('legit.');
    expect(result.sanitized.summary).toBe('fine');
    expect(result.sanitized.missionId).toBe('s56-m02');
    expect(result.sanitizedFields).toEqual([expect.objectContaining({ field: 'content' })]);
  });

  it('ignores non-string field values', () => {
    const obj = { content: 'ok', count: 3, tags: ['a', 'b'] };
    const result = sanitizeFields(obj, ['content', 'count', 'tags'] as const);
    expect(result.sanitizedFields).toHaveLength(0);
    expect(result.sanitized).toBe(obj);
  });
});

describe('sanitizeStringArray', () => {
  it('returns undefined untouched', () => {
    const result = sanitizeStringArray('decisions', undefined);
    expect(result.cleaned).toBeUndefined();
    expect(result.sanitizedFields).toHaveLength(0);
  });

  it('sanitizes only the dirty entries and labels them by index', () => {
    const values = ['clean A', 'dirty one.</content>noise', 'clean C'];
    const result = sanitizeStringArray('decisions', values);
    expect(result.cleaned).toEqual(['clean A', 'dirty one.', 'clean C']);
    expect(result.sanitizedFields).toEqual([expect.objectContaining({ field: 'decisions[1]' })]);
  });

  it('returns the original array reference when nothing was modified', () => {
    const values = ['a', 'b', 'c'];
    const result = sanitizeStringArray('nextSteps', values);
    expect(result.cleaned).toBe(values);
    expect(result.sanitizedFields).toHaveLength(0);
  });
});

describe('mergeSanitizedFields', () => {
  it('concatenates groups and dedupes by field (first wins)', () => {
    const a = [{ field: 'content', reason: 'first' }];
    const b = [
      { field: 'content', reason: 'dup' },
      { field: 'summary', reason: 'second' },
    ];
    const merged = mergeSanitizedFields(a, b);
    expect(merged).toEqual([
      { field: 'content', reason: 'first' },
      { field: 'summary', reason: 'second' },
    ]);
  });

  it('is order-stable and handles empty inputs', () => {
    expect(mergeSanitizedFields()).toEqual([]);
    expect(mergeSanitizedFields([], [])).toEqual([]);
  });
});
