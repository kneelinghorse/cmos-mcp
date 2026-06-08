/**
 * Compression Rules Unit Tests
 */

import { describe, test, expect } from '@jest/globals';
import {
  applySanitization,
  applyStructuralRefactoring,
  applyLinguisticSimplification,
  convertProseToList,
  convertPassiveToActive,
  extractPreservedSections,
  replaceWithPlaceholders,
  restorePreservedSections,
  getDefaultRuleset,
} from '../../src/intelligence/compression-rules';

describe('compression-rules', () => {
  describe('sanitization', () => {
    test('applies regex replacement rules', () => {
      const input =
        'It is important to note that in order to proceed, please provide a detailed explanation of X.';
      const rules = [
        {
          type: 'regex_replace' as const,
          pattern: /it is important to note that/gi,
          replacement: 'note:',
          enabled: true,
        },
        {
          type: 'regex_replace' as const,
          pattern: /in order to/gi,
          replacement: 'to',
          enabled: true,
        },
        {
          type: 'regex_replace' as const,
          pattern: /provide a detailed explanation of/gi,
          replacement: 'explain',
          enabled: true,
        },
      ];
      const out = applySanitization(input, rules);
      expect(out).toContain('note:');
      expect(out).toContain('to proceed');
      expect(out).toContain('explain X');
    });

    test('supports string-based pattern definitions', () => {
      const input = 'Reduce   excessive   whitespace.';
      const rules = [
        {
          type: 'regex_replace' as const,
          pattern: '\\s+',
          replacement: ' ',
          flags: 'g',
          enabled: true,
        },
      ];
      const out = applySanitization(input, rules);
      expect(out).toBe('Reduce excessive whitespace.');
    });

    test('skips disabled or patternless rules', () => {
      const input = 'Formatting should stay the same.';
      const rules = [
        {
          type: 'regex_replace' as const,
          pattern: /Formatting/,
          replacement: 'Changed',
          enabled: false,
        },
        { type: 'regex_replace' as const, enabled: true } as any,
      ];
      const out = applySanitization(input, rules);
      expect(out).toBe(input);
    });

    test('falls back to empty replacement when pattern matches and replacement omitted', () => {
      const input = 'Remove secret token ABC123.';
      const rules = [{ type: 'regex_replace' as const, pattern: /token\s+\w+/i, enabled: true }];
      const out = applySanitization(input, rules as any);
      expect(out).toBe('Remove secret .');
    });
  });

  describe('structural refactoring', () => {
    test('convert prose to list with ordinal delimiters', () => {
      const input = 'First, do A. Then, do B. Finally, do C.';
      const out = convertProseToList(input, ['First,', 'Then,', 'Finally,']);
      expect(out).toContain('\n- do A.');
      expect(out).toContain('\n- do B.');
      expect(out).toContain('\n- do C.');
    });

    test('applyStructuralRefactoring only converts when multiple items found', () => {
      const input = 'Step: Do A only.';
      const rules = [
        { type: 'convert_prose_to_list' as const, enabled: true, delimiters: ['First,', 'Then,'] },
      ];
      const out = applyStructuralRefactoring(input, rules);
      expect(out).toBe(input);
    });

    test('respects disabled structural rules even when delimiters present', () => {
      const input = '1. Prepare. 2. Execute.';
      const rules = [
        { type: 'convert_prose_to_list' as const, enabled: false, delimiters: ['1.', '2.'] },
      ];
      expect(applyStructuralRefactoring(input, rules)).toBe(input);
    });

    test('ignores unrelated rule types during structural refactoring', () => {
      const input = 'Content should remain unchanged.';
      const rules = [
        {
          type: 'regex_replace' as const,
          enabled: true,
          pattern: /unchanged/gi,
          replacement: 'modified',
        },
      ];
      expect(applyStructuralRefactoring(input, rules as any)).toBe(input);
    });
  });

  describe('linguistic simplification', () => {
    test('convert passive to active (heuristic)', () => {
      const input = 'Task should be completed by engineer.';
      const out = convertPassiveToActive(input);
      expect(out.toLowerCase()).toContain('engineer should completed task');
    });

    test('applyLinguisticSimplification runs regex and passive conversions', () => {
      const input = 'The system is able to run and has the ability to stop.';
      const rules = [
        {
          type: 'regex_replace' as const,
          pattern: /is able to/gi,
          replacement: 'can',
          enabled: true,
        },
        {
          type: 'regex_replace' as const,
          pattern: /has the ability to/gi,
          replacement: 'can',
          enabled: true,
        },
        { type: 'convert_passive_to_active' as const, enabled: true },
      ];
      const out = applyLinguisticSimplification(input, rules);
      expect(out).toContain('can run');
      expect(out).toContain('can stop');
    });

    test('ignores disabled linguistic rules', () => {
      const input = 'This work is able to continue.';
      const rules = [
        {
          type: 'regex_replace' as const,
          pattern: /is able to/gi,
          replacement: 'can',
          enabled: false,
        },
        { type: 'convert_passive_to_active' as const, enabled: false },
      ];
      expect(applyLinguisticSimplification(input, rules)).toBe(input);
    });

    test('builds regex from string definition and applies fallback replacement', () => {
      const input = 'The system will be tested by engineers.';
      const rules = [
        {
          type: 'regex_replace' as const,
          pattern: '(system)',
          flags: 'i',
          enabled: true,
          replacement: 'platform',
        },
        { type: 'convert_passive_to_active' as const, enabled: true },
      ];
      const out = applyLinguisticSimplification(input, rules);
      expect(out).toContain('engineers will tested platform');
    });
  });

  describe('preserve/restore', () => {
    test('extracts, replaces, and restores preserved sections', () => {
      const input = 'context: text\n<preserve>KEEP_ME</preserve>\nother: text';
      const patterns = [/<preserve>.*?<\/preserve>/gs];
      const preserved = extractPreservedSections(input, patterns);
      const withPlaceholders = replaceWithPlaceholders(input, preserved);
      expect(withPlaceholders).not.toContain('KEEP_ME');
      const restored = restorePreservedSections(withPlaceholders, preserved);
      expect(restored).toContain('KEEP_ME');
    });

    test('supports multiple preserve patterns with incremental placeholders', () => {
      const input = `
successCriteria:
  - Keep audits
constraintToRespect:
  - Maintain logs
custom: <preserve>INLINE</preserve>
`;
      const preserved = extractPreservedSections(input, [
        /successCriteria:[\s\S]*?(?=\n\w+:|$)/g,
        /constraintToRespect:[\s\S]*?(?=\n\w+:|$)/g,
        /<preserve>.*?<\/preserve>/gs,
      ]);
      expect(preserved.size).toBe(3);
      const placeholderText = replaceWithPlaceholders(input, preserved);
      const restored = restorePreservedSections(placeholderText, preserved);
      expect(restored).toContain('successCriteria:');
      expect(restored).toContain('Maintain logs');
      expect(restored).toContain('<preserve>INLINE</preserve>');
    });
  });

  describe('ruleset levels', () => {
    test('balanced level includes all three rule groups', () => {
      const ruleset = getDefaultRuleset('balanced');
      expect(ruleset.sanitizationRules.length).toBeGreaterThan(0);
      expect(ruleset.structuralRules.length).toBeGreaterThan(0);
      expect(ruleset.linguisticRules.length).toBeGreaterThan(0);
      expect(ruleset.preservePatterns.length).toBeGreaterThan(0);
    });

    test('conservative level limits to sanitization rules', () => {
      const ruleset = getDefaultRuleset('conservative');
      expect(ruleset.structuralRules).toHaveLength(0);
      expect(ruleset.linguisticRules).toHaveLength(0);
      expect(ruleset.sanitizationRules.every((r) => r.type === 'regex_replace')).toBe(true);
    });

    test('aggressive level retains linguistic rules and preserve patterns', () => {
      const ruleset = getDefaultRuleset('aggressive');
      expect(ruleset.linguisticRules.length).toBeGreaterThan(0);
      expect(ruleset.preservePatterns.length).toBeGreaterThan(0);
    });

    test('falls back to balanced configuration for unknown level', () => {
      const ruleset = getDefaultRuleset('unknown' as any);
      const balanced = getDefaultRuleset('balanced');
      expect(ruleset.linguisticRules.length).toBe(balanced.linguisticRules.length);
      expect(ruleset.structuralRules.length).toBe(balanced.structuralRules.length);
    });
  });
});
