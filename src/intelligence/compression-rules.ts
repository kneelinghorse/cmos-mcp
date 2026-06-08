/**
 * Compression Rules
 *
 * Implements the multi-pass compression pipeline from R4.1:
 * Pass 1: Sanitization (remove fillers and redundancy)
 * Pass 2: Structural Refactoring (prose to lists/structured data)
 * Pass 3: Linguistic Simplification (passive to active, sentence simplification)
 */

import { CompressionRule, CompressionRuleset, CompressionLevel } from './types';

/**
 * Default compression rules for sanitization pass
 */
export const sanitizationRules: CompressionRule[] = [
  // Remove conversational fillers
  {
    type: 'regex_replace',
    pattern: /could you (please )?(explain|generate|provide|create|write|implement)/gi,
    replacement: '$2',
    enabled: true,
  },
  {
    type: 'regex_replace',
    pattern: /I (was wondering|would like|need you to)/gi,
    replacement: '',
    enabled: true,
  },
  {
    type: 'regex_replace',
    pattern: /in order to/gi,
    replacement: 'to',
    enabled: true,
  },
  {
    type: 'regex_replace',
    pattern: /it would be great if you could/gi,
    replacement: '',
    enabled: true,
  },
  // Remove redundant phrases
  {
    type: 'regex_replace',
    pattern: /provide a detailed explanation of/gi,
    replacement: 'explain',
    enabled: true,
  },
  {
    type: 'regex_replace',
    pattern: /the purpose of this is to/gi,
    replacement: 'purpose:',
    enabled: true,
  },
  {
    type: 'regex_replace',
    pattern: /as you can see/gi,
    replacement: '',
    enabled: true,
  },
  {
    type: 'regex_replace',
    pattern: /it is important to note that/gi,
    replacement: 'note:',
    enabled: true,
  },
  // Normalize whitespace
  {
    type: 'regex_replace',
    pattern: /\s+/g,
    replacement: ' ',
    enabled: true,
  },
  {
    type: 'regex_replace',
    pattern: /\n{3,}/g,
    replacement: '\n\n',
    enabled: true,
  },
];

/**
 * Default structural refactoring rules
 */
export const structuralRules: CompressionRule[] = [
  {
    type: 'convert_prose_to_list',
    enabled: true,
    delimiters: ['First,', 'Then,', 'Next,', 'Finally,', 'Lastly,'],
  },
  {
    type: 'convert_prose_to_list',
    enabled: true,
    delimiters: ['1.', '2.', '3.', '4.', '5.'],
  },
];

/**
 * Default linguistic simplification rules
 */
export const linguisticRules: CompressionRule[] = [
  {
    type: 'convert_passive_to_active',
    enabled: true,
  },
  // Simplify verbose constructions
  {
    type: 'regex_replace',
    pattern: /is able to/gi,
    replacement: 'can',
    enabled: true,
  },
  {
    type: 'regex_replace',
    pattern: /has the ability to/gi,
    replacement: 'can',
    enabled: true,
  },
  {
    type: 'regex_replace',
    pattern: /at this point in time/gi,
    replacement: 'now',
    enabled: true,
  },
  {
    type: 'regex_replace',
    pattern: /due to the fact that/gi,
    replacement: 'because',
    enabled: true,
  },
];

/**
 * Preserve patterns - content matching these should not be compressed
 */
export const defaultPreservePatterns: RegExp[] = [
  /<preserve>.*?<\/preserve>/gs,
  /successCriteria:[\s\S]*?(?=\n\w+:|$)/g,
  /constraintToRespect:[\s\S]*?(?=\n\w+:|$)/g,
];

/**
 * Get default ruleset for a compression level
 */
export function getDefaultRuleset(level: CompressionLevel): CompressionRuleset {
  switch (level) {
    case 'conservative':
      return {
        sanitizationRules: sanitizationRules.filter((r) => r.type === 'regex_replace'),
        structuralRules: [],
        linguisticRules: [],
        preservePatterns: defaultPreservePatterns,
      };

    case 'balanced':
      return {
        sanitizationRules,
        structuralRules,
        linguisticRules: linguisticRules.slice(0, 2), // Only simple replacements
        preservePatterns: defaultPreservePatterns,
      };

    case 'aggressive':
      return {
        sanitizationRules,
        structuralRules,
        linguisticRules,
        preservePatterns: defaultPreservePatterns,
      };

    default:
      return getDefaultRuleset('balanced');
  }
}

/**
 * Apply sanitization rules to text
 */
export function applySanitization(text: string, rules: CompressionRule[]): string {
  let result = text;

  for (const rule of rules) {
    if (!rule.enabled || rule.type !== 'regex_replace') continue;
    if (!rule.pattern) continue;

    const pattern =
      rule.pattern instanceof RegExp
        ? rule.pattern
        : new RegExp(rule.pattern, rule.flags || undefined);
    result = result.replace(pattern, rule.replacement || '');
  }

  return result;
}

/**
 * Convert prose to list format
 */
export function convertProseToList(text: string, delimiters: string[]): string {
  // Check if text contains sequential delimiters
  let delimiterCount = 0;
  for (const delimiter of delimiters) {
    if (text.includes(delimiter)) {
      delimiterCount++;
    }
  }

  // Only convert if we have multiple sequential items
  if (delimiterCount < 2) {
    return text;
  }

  // Split by delimiters and create a list
  let result = text;
  for (const delimiter of delimiters) {
    // Create list item format
    const delimiterRegex = new RegExp(
      `\\s*${delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`,
      'gi'
    );
    result = result.replace(delimiterRegex, '\n- ');
  }

  return result;
}

/**
 * Convert passive voice to active (simplified heuristic)
 */
export function convertPassiveToActive(text: string): string {
  // Simple pattern matching for common passive constructions
  const passivePatterns = [
    { pattern: /(\w+) should be (\w+ed) by (\w+)/gi, replacement: '$3 should $2 $1' },
    { pattern: /(\w+) will be (\w+ed) by (\w+)/gi, replacement: '$3 will $2 $1' },
    { pattern: /(\w+) is (\w+ed) by (\w+)/gi, replacement: '$3 $2s $1' },
  ];

  let result = text;
  for (const { pattern, replacement } of passivePatterns) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

/**
 * Apply structural refactoring rules
 */
export function applyStructuralRefactoring(text: string, rules: CompressionRule[]): string {
  let result = text;

  for (const rule of rules) {
    if (!rule.enabled) continue;

    if (rule.type === 'convert_prose_to_list' && rule.delimiters) {
      result = convertProseToList(result, rule.delimiters);
    }
  }

  return result;
}

/**
 * Apply linguistic simplification rules
 */
export function applyLinguisticSimplification(text: string, rules: CompressionRule[]): string {
  let result = text;

  for (const rule of rules) {
    if (!rule.enabled) continue;

    if (rule.type === 'regex_replace' && rule.pattern) {
      const pattern =
        rule.pattern instanceof RegExp
          ? rule.pattern
          : new RegExp(rule.pattern, rule.flags || undefined);
      result = result.replace(pattern, rule.replacement || '');
    } else if (rule.type === 'convert_passive_to_active') {
      result = convertPassiveToActive(result);
    }
  }

  return result;
}

/**
 * Extract preserved sections from text
 */
export function extractPreservedSections(text: string, patterns: RegExp[]): Map<string, string> {
  const preserved = new Map<string, string>();
  let index = 0;

  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const placeholder = `__PRESERVED_${index}__`;
      preserved.set(placeholder, match[0]);
      index++;
    }
  }

  return preserved;
}

/**
 * Replace preserved sections with placeholders
 */
export function replaceWithPlaceholders(text: string, preserved: Map<string, string>): string {
  let result = text;

  for (const [placeholder, content] of preserved.entries()) {
    result = result.replace(content, placeholder);
  }

  return result;
}

/**
 * Restore preserved sections from placeholders
 */
export function restorePreservedSections(text: string, preserved: Map<string, string>): string {
  let result = text;

  for (const [placeholder, content] of preserved.entries()) {
    result = result.replace(placeholder, content);
  }

  return result;
}
