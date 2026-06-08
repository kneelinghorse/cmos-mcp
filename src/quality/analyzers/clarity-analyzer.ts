/**
 * Clarity Dimension Analyzer
 * Implements metrics: Flesch-Kincaid, Lexical Density, Ambiguity Detection, MCC
 */

import {
  DimensionScore,
  MetricResult,
  ClarityMetrics,
  MissionContent,
  DEFAULT_CLARITY_WEIGHTS,
} from '../types';

export class ClarityAnalyzer {
  private weights: Record<keyof ClarityMetrics, number>;

  constructor(customWeights?: Partial<Record<keyof ClarityMetrics, number>>) {
    this.weights = { ...DEFAULT_CLARITY_WEIGHTS, ...customWeights };
  }

  async analyze(mission: MissionContent): Promise<DimensionScore> {
    const text = this.extractTextContent(mission);

    // Calculate all clarity metrics
    const metrics: ClarityMetrics = {
      fleschKincaidGradeLevel: this.calculateFleschKincaid(text),
      lexicalDensity: this.calculateLexicalDensity(text),
      lexicalAmbiguity: this.detectLexicalAmbiguity(text),
      syntacticAmbiguity: this.detectSyntacticAmbiguity(text),
      referentialAmbiguity: this.detectReferentialAmbiguity(text),
      missionCyclomaticComplexity: this.calculateMCC(mission),
    };

    // Normalize and create metric results
    const metricResults: MetricResult[] = [
      {
        name: 'Flesch-Kincaid Grade Level',
        rawValue: metrics.fleschKincaidGradeLevel,
        normalizedScore: this.normalizeFleschKincaid(metrics.fleschKincaidGradeLevel),
        weight: this.weights.fleschKincaidGradeLevel,
        details: {
          target: '10-12',
          interpretation: this.interpretFKGL(metrics.fleschKincaidGradeLevel),
        },
      },
      {
        name: 'Lexical Density',
        rawValue: metrics.lexicalDensity,
        normalizedScore: this.normalizeLexicalDensity(metrics.lexicalDensity),
        weight: this.weights.lexicalDensity,
        details: { target: '>50%', percentage: `${metrics.lexicalDensity.toFixed(1)}%` },
      },
      {
        name: 'Lexical Ambiguity',
        rawValue: metrics.lexicalAmbiguity,
        normalizedScore: metrics.lexicalAmbiguity,
        weight: this.weights.lexicalAmbiguity,
        details: {
          ambiguousWordCount: Math.round((1 - metrics.lexicalAmbiguity) * text.split(/\s+/).length),
        },
      },
      {
        name: 'Syntactic Ambiguity',
        rawValue: metrics.syntacticAmbiguity,
        normalizedScore: metrics.syntacticAmbiguity,
        weight: this.weights.syntacticAmbiguity,
      },
      {
        name: 'Referential Ambiguity',
        rawValue: metrics.referentialAmbiguity,
        normalizedScore: metrics.referentialAmbiguity,
        weight: this.weights.referentialAmbiguity,
      },
      {
        name: 'Mission Cyclomatic Complexity',
        rawValue: metrics.missionCyclomaticComplexity,
        normalizedScore: this.normalizeMCC(metrics.missionCyclomaticComplexity),
        weight: this.weights.missionCyclomaticComplexity,
        details: {
          riskLevel: this.getMCCRiskLevel(metrics.missionCyclomaticComplexity),
          decisionPoints: metrics.missionCyclomaticComplexity - 1,
        },
      },
    ];

    // Calculate weighted dimension score
    const score = metricResults.reduce(
      (sum, metric) => sum + metric.normalizedScore * metric.weight,
      0
    );

    return {
      score,
      weight: 0.35, // Default clarity dimension weight
      metrics: metricResults,
    };
  }

  /**
   * Calculate Flesch-Kincaid Grade Level
   * FKGL = 0.39 * (total words / total sentences) + 11.8 * (total syllables / total words) - 15.59
   */
  private calculateFleschKincaid(text: string): number {
    const sentences = this.countSentences(text);
    const words = this.countWords(text);
    const syllables = this.countSyllables(text);

    if (words === 0 || sentences === 0) return 0;

    const avgWordsPerSentence = words / sentences;
    const avgSyllablesPerWord = syllables / words;

    return 0.39 * avgWordsPerSentence + 11.8 * avgSyllablesPerWord - 15.59;
  }

  /**
   * Calculate Lexical Density
   * LD = (Number of lexical items / Total words) * 100
   */
  private calculateLexicalDensity(text: string): number {
    const words = text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0);
    if (words.length === 0) return 0;

    // Function words (articles, prepositions, pronouns, conjunctions)
    const functionWords = new Set([
      'the',
      'a',
      'an',
      'and',
      'or',
      'but',
      'in',
      'on',
      'at',
      'to',
      'for',
      'of',
      'with',
      'from',
      'by',
      'as',
      'is',
      'was',
      'are',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'should',
      'could',
      'may',
      'might',
      'can',
      'must',
      'shall',
      'this',
      'that',
      'these',
      'those',
      'i',
      'you',
      'he',
      'she',
      'it',
      'we',
      'they',
      'them',
      'their',
      'my',
      'your',
      'his',
      'her',
      'its',
      'our',
      'who',
      'what',
      'where',
      'when',
      'why',
      'how',
      'if',
      'than',
    ]);

    const lexicalItems = words.filter((word) => !functionWords.has(word.toLowerCase()));
    return (lexicalItems.length / words.length) * 100;
  }

  /**
   * Detect lexical ambiguity (words with multiple meanings)
   * Simplified heuristic-based approach
   */
  private detectLexicalAmbiguity(text: string): number {
    const words = text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0);
    if (words.length === 0) return 1;

    // Common ambiguous words in technical contexts
    const ambiguousWords = new Set([
      'bank',
      'record',
      'table',
      'field',
      'file',
      'run',
      'execute',
      'process',
      'service',
      'object',
      'class',
      'type',
      'value',
      'set',
      'get',
      'check',
      'test',
      'case',
      'base',
      'model',
      'view',
      'state',
    ]);

    const ambiguousCount = words.filter((w) => ambiguousWords.has(w)).length;
    return 1 - ambiguousCount / words.length;
  }

  /**
   * Detect syntactic ambiguity
   * Simplified heuristic: Check for potentially ambiguous sentence structures
   */
  private detectSyntacticAmbiguity(text: string): number {
    const sentences = this.getSentences(text);
    if (sentences.length === 0) return 1;

    let ambiguousCount = 0;
    for (const sentence of sentences) {
      // Patterns that often lead to syntactic ambiguity
      const patterns = [
        /\b(saw|watched|heard)\s+\w+\s+(duck|bear|fish|fly)\b/i, // "saw her duck"
        /\b\w+\s+and\s+\w+\s+(or|and)\s+\w+\b/, // Multiple conjunctions
        /\b(more|less)\s+\w+\s+(than|or)\b/, // Comparative ambiguity
        /\b(without|with)\s+\w+\s+(and|or)\b/, // Prepositional phrase attachment
      ];

      if (patterns.some((pattern) => pattern.test(sentence))) {
        ambiguousCount++;
      }
    }

    return 1 - ambiguousCount / sentences.length;
  }

  /**
   * Detect referential ambiguity (unclear pronoun references)
   */
  private detectReferentialAmbiguity(text: string): number {
    const pronouns = ['it', 'they', 'them', 'this', 'that', 'these', 'those', 'which'];
    const sentences = this.getSentences(text);

    let unresolvedCount = 0;
    let totalPronouns = 0;

    for (const sentence of sentences) {
      const words = sentence.toLowerCase().split(/\s+/);
      for (let i = 0; i < words.length; i++) {
        if (pronouns.includes(words[i])) {
          totalPronouns++;
          // Simple heuristic: pronoun at sentence start is more likely unresolved
          if (i < 2) {
            unresolvedCount++;
          }
          // Pronoun without clear antecedent in previous words
          else if (i > 0 && this.hasNoNearbyNoun(words.slice(Math.max(0, i - 5), i))) {
            unresolvedCount++;
          }
        }
      }
    }

    if (totalPronouns === 0) return 1;
    return 1 - unresolvedCount / totalPronouns;
  }

  /**
   * Calculate Mission Cyclomatic Complexity
   * MCC = Number of Decision Points + 1
   */
  private calculateMCC(mission: MissionContent): number {
    const text = JSON.stringify(mission, null, 2).toLowerCase();

    let decisionPoints = 0;

    // Conditional keywords
    const conditionalKeywords = [
      /\bif\b/g,
      /\bwhen\b/g,
      /\bunless\b/g,
      /\botherwise\b/g,
      /\balternatively\b/g,
      /\bin case of\b/g,
      /\bdepending on\b/g,
      /\bshould\b/g,
      /\bmay\b/g,
      /\bcan\b/g,
      /\bmight\b/g,
    ];

    // Logical operators
    const logicalOperators = [/\band\b/g, /\bor\b/g];

    // Implicit loops
    const loopPatterns = [/\bfor each\b/g, /\brepeat for\b/g, /\ball\b/g];

    // Count decision points
    [...conditionalKeywords, ...logicalOperators, ...loopPatterns].forEach((pattern) => {
      const matches = text.match(pattern);
      if (matches) decisionPoints += matches.length;
    });

    // Check for optional fields in structure
    if (mission.domainFields) {
      // Optional sections add complexity
      const optionalSections = ['assumptions', 'blockers', 'nextMission'];
      optionalSections.forEach((section) => {
        if (section in mission.domainFields!) decisionPoints++;
      });
    }

    return decisionPoints + 1;
  }

  // Helper methods

  private extractTextContent(mission: MissionContent): string {
    const textParts: string[] = [];

    if (mission.objective) textParts.push(mission.objective);
    if (mission.context) textParts.push(mission.context);
    if (mission.successCriteria) {
      textParts.push(
        Array.isArray(mission.successCriteria)
          ? mission.successCriteria.join(' ')
          : mission.successCriteria
      );
    }
    if (mission.deliverables) {
      textParts.push(
        Array.isArray(mission.deliverables) ? mission.deliverables.join(' ') : mission.deliverables
      );
    }

    return textParts.join(' ');
  }

  private countSentences(text: string): number {
    return text.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;
  }

  private countWords(text: string): number {
    return text.split(/\s+/).filter((w) => w.length > 0).length;
  }

  private countSyllables(text: string): number {
    const words = text.toLowerCase().split(/\s+/);
    let syllables = 0;

    for (const word of words) {
      syllables += this.countWordSyllables(word);
    }

    return syllables;
  }

  private countWordSyllables(word: string): number {
    word = word.replace(/[^a-z]/gi, '');
    if (word.length <= 3) return 1;

    const vowels = word.match(/[aeiouy]+/gi);
    let count = vowels ? vowels.length : 1;

    // Adjust for silent e
    if (word.endsWith('e')) count--;

    return Math.max(1, count);
  }

  private getSentences(text: string): string[] {
    return text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  }

  private hasNoNearbyNoun(words: string[]): boolean {
    const nounsIndicators = ['the', 'a', 'an', 'this', 'that'];
    return !words.some((w) => nounsIndicators.includes(w.toLowerCase()));
  }

  // Normalization functions

  private normalizeFleschKincaid(fkgl: number): number {
    // Target: 10-12, penalize > 15
    if (fkgl < 10) return 0.8;
    if (fkgl <= 12) return 1.0;
    if (fkgl <= 15) return 0.7;
    return Math.max(0, 1 - (fkgl - 15) * 0.1);
  }

  private normalizeLexicalDensity(density: number): number {
    // Target: > 50%
    if (density >= 50) return 1.0;
    return density / 50;
  }

  private normalizeMCC(mcc: number): number {
    // MCC 1-10: 1.0-0.5, MCC > 20: 0.0
    if (mcc <= 10) return 1.0 - (mcc - 1) * 0.05;
    if (mcc <= 20) return 0.5 - (mcc - 10) * 0.05;
    return 0;
  }

  private interpretFKGL(fkgl: number): string {
    if (fkgl < 10) return 'Too simple for technical content';
    if (fkgl <= 12) return 'Optimal for technical documentation';
    if (fkgl <= 15) return 'Acceptable complexity';
    return 'Overly complex';
  }

  private getMCCRiskLevel(mcc: number): string {
    if (mcc <= 10) return 'Low';
    if (mcc <= 20) return 'Moderate';
    if (mcc <= 50) return 'High';
    return 'Very High';
  }
}
