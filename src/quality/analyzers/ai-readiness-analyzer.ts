/**
 * AI-Readiness Dimension Analyzer
 * Implements: Syntactic Validity, Instruction Specificity, Structural Consistency
 */

import {
  DimensionScore,
  MetricResult,
  AIReadinessMetrics,
  MissionContent,
  DEFAULT_AI_READINESS_WEIGHTS,
} from '../types';

export class AIReadinessAnalyzer {
  private weights: Record<keyof AIReadinessMetrics, number>;

  // Weak phrases that indicate vagueness (from NASA requirements quality model)
  private readonly WEAK_PHRASES = [
    'adequate',
    'as appropriate',
    'timely',
    'significant',
    'possibly',
    'etc',
    'appropriate',
    'reasonable',
    'normal',
    'typical',
    'various',
    'suitable',
    'proper',
    'effective',
    'efficient',
    'robust',
    'good',
    'bad',
    'better',
    'worse',
    'fast',
    'slow',
    'easy',
    'hard',
    'simple',
    'complex',
    'flexible',
    'user-friendly',
    'as needed',
    'if necessary',
  ];

  constructor(customWeights?: Partial<Record<keyof AIReadinessMetrics, number>>) {
    this.weights = { ...DEFAULT_AI_READINESS_WEIGHTS, ...customWeights };
  }

  async analyze(mission: MissionContent): Promise<DimensionScore> {
    const metrics: AIReadinessMetrics = {
      syntacticValidity: this.checkSyntacticValidity(mission),
      instructionSpecificity: this.calculateInstructionSpecificity(mission),
      lintingScore: this.calculateLintingScore(mission),
    };

    const metricResults: MetricResult[] = [
      {
        name: 'Syntactic Validity',
        rawValue: metrics.syntacticValidity ? 1 : 0,
        normalizedScore: metrics.syntacticValidity ? 1 : 0,
        weight: this.weights.syntacticValidity,
        details: {
          isValid: metrics.syntacticValidity,
          note: metrics.syntacticValidity ? 'Valid structure' : 'Invalid structure detected',
        },
      },
      {
        name: 'Instruction Specificity',
        rawValue: metrics.instructionSpecificity,
        normalizedScore: metrics.instructionSpecificity,
        weight: this.weights.instructionSpecificity,
        details: this.getSpecificityDetails(mission),
      },
      {
        name: 'Linting Score',
        rawValue: metrics.lintingScore,
        normalizedScore: metrics.lintingScore,
        weight: this.weights.lintingScore,
        details: this.getLintingDetails(mission),
      },
    ];

    // If syntactic validity fails, entire dimension scores 0
    if (!metrics.syntacticValidity) {
      return {
        score: 0,
        weight: 0.2,
        metrics: metricResults,
      };
    }

    const score = metricResults.reduce(
      (sum, metric) => sum + metric.normalizedScore * metric.weight,
      0
    );

    return {
      score,
      weight: 0.2,
      metrics: metricResults,
    };
  }

  /**
   * Check syntactic validity
   * Hard gate: mission must be valid structure
   */
  private checkSyntacticValidity(mission: MissionContent): boolean {
    try {
      // Mission is already parsed, but check for basic structure
      if (typeof mission !== 'object' || mission === null) {
        return false;
      }

      // Check for basic required structure
      const hasBasicStructure =
        mission.objective !== undefined ||
        mission.context !== undefined ||
        mission.successCriteria !== undefined;

      return hasBasicStructure;
    } catch (_error) {
      return false;
    }
  }

  /**
   * Calculate instruction specificity
   * Based on prompt engineering best practices checklist
   */
  private calculateInstructionSpecificity(mission: MissionContent): number {
    const checks = [
      // 1. Explicit Goal
      {
        name: 'Explicit goal',
        test: () => this.hasExplicitGoal(mission.objective),
        weight: 0.25,
      },

      // 2. Defined Scope
      {
        name: 'Defined scope',
        test: () => this.hasDefinedScope(mission.context),
        weight: 0.2,
      },

      // 3. Format Specification
      {
        name: 'Format specification',
        test: () => this.hasFormatSpecification(mission),
        weight: 0.2,
      },

      // 4. Constraint Declaration
      {
        name: 'Constraint declaration',
        test: () => this.hasConstraints(mission),
        weight: 0.15,
      },

      // 5. Success Criteria Definition
      {
        name: 'Success criteria',
        test: () => this.hasWellDefinedSuccessCriteria(mission.successCriteria),
        weight: 0.2,
      },
    ];

    let score = 0;
    for (const check of checks) {
      if (check.test()) {
        score += check.weight;
      }
    }

    return score;
  }

  /**
   * Calculate linting score
   * Checks for structural consistency and best practices
   */
  private calculateLintingScore(mission: MissionContent): number {
    const violations: string[] = [];

    // Check for consistent data types
    if (mission.successCriteria && typeof mission.successCriteria === 'string') {
      // Prefer array over multi-line string
      if (mission.successCriteria.includes('\n')) {
        violations.push('successCriteria should be array, not multi-line string');
      }
    }

    if (mission.deliverables && typeof mission.deliverables === 'string') {
      if (mission.deliverables.includes('\n')) {
        violations.push('deliverables should be array, not multi-line string');
      }
    }

    // Check for vague language
    const fullText = JSON.stringify(mission).toLowerCase();
    const vaguePhrasesFound: string[] = [];

    for (const phrase of this.WEAK_PHRASES) {
      if (fullText.includes(phrase.toLowerCase())) {
        vaguePhrasesFound.push(phrase);
      }
    }

    if (vaguePhrasesFound.length > 0) {
      violations.push(`Contains ${vaguePhrasesFound.length} vague phrases`);
    }

    // Check for proper field naming
    if (mission.domainFields) {
      const fields = Object.keys(mission.domainFields);
      for (const field of fields) {
        // Check for camelCase convention
        if (!/^[a-z][a-zA-Z0-9]*$/.test(field) && field !== 'type') {
          violations.push(`Field '${field}' doesn't follow camelCase convention`);
        }
      }
    }

    // Check for empty fields
    const emptyFields = this.findEmptyFields(mission);
    if (emptyFields.length > 0) {
      violations.push(`${emptyFields.length} empty fields found`);
    }

    // Calculate score: 1 - (violations / total possible lines)
    const totalLines = JSON.stringify(mission, null, 2).split('\n').length;
    const score = Math.max(0, 1 - violations.length / totalLines);

    return score;
  }

  // Helper methods for instruction specificity

  private hasExplicitGoal(objective: unknown): boolean {
    if (!objective || typeof objective !== 'string') return false;

    const text = objective.toLowerCase();

    // Should contain action verbs
    const actionVerbs = [
      'implement',
      'create',
      'build',
      'develop',
      'research',
      'define',
      'analyze',
      'design',
      'test',
      'document',
    ];

    const hasActionVerb = actionVerbs.some((verb) => text.includes(verb));

    // Should be substantive (>10 words)
    const wordCount = objective.split(/\s+/).length;

    // Should start with "To" or contain action verb
    const isWellFormed = text.startsWith('to ') || hasActionVerb;

    return isWellFormed && wordCount >= 10;
  }

  private hasDefinedScope(context: unknown): boolean {
    if (!context || typeof context !== 'string') return false;

    const text = context.toLowerCase();

    // Look for scope indicators
    const scopeIndicators = [
      'in-scope',
      'out-of-scope',
      'scope',
      'boundary',
      'boundaries',
      'includes',
      'excludes',
      'focuses on',
      'limited to',
      'specifically',
    ];

    const hasScopeIndicator = scopeIndicators.some((indicator) => text.includes(indicator));

    // Context should be detailed (>25 words)
    const wordCount = context.split(/\s+/).length;

    return hasScopeIndicator || wordCount >= 25;
  }

  private hasFormatSpecification(mission: MissionContent): boolean {
    const fullText = JSON.stringify(mission).toLowerCase();

    // Look for format specifications
    const formatIndicators = [
      'format',
      'json',
      'yaml',
      'table',
      'list',
      'bullet',
      'markdown',
      'structured',
      'template',
      'schema',
    ];

    return formatIndicators.some((indicator) => fullText.includes(indicator));
  }

  private hasConstraints(mission: MissionContent): boolean {
    const fullText = JSON.stringify(mission).toLowerCase();

    // Look for negative constraints
    const constraintIndicators = [
      'do not',
      "don't",
      'avoid',
      'exclude',
      'without',
      'must not',
      'should not',
      'cannot',
      'never',
    ];

    const hasNegativeConstraints = constraintIndicators.some((indicator) =>
      fullText.includes(indicator)
    );

    // Or positive constraints
    const positiveConstraints = [
      'must',
      'required',
      'shall',
      'only',
      'specifically',
      'constraint',
      'limitation',
      'restriction',
    ];

    const hasPositiveConstraints = positiveConstraints.some((indicator) =>
      fullText.includes(indicator)
    );

    // Check domainFields for constraints
    const hasConstraintsField = mission.domainFields?.constraintToRespect !== undefined;

    return hasNegativeConstraints || hasPositiveConstraints || hasConstraintsField;
  }

  private hasWellDefinedSuccessCriteria(successCriteria: unknown): boolean {
    if (!successCriteria) return false;

    if (Array.isArray(successCriteria)) {
      // Should have at least 3 criteria
      if (successCriteria.length < 3) return false;

      // Each criterion should be specific (>5 words)
      const allSpecific = successCriteria.every(
        (criterion) => typeof criterion === 'string' && criterion.split(/\s+/).length >= 5
      );

      return allSpecific;
    }

    if (typeof successCriteria === 'string') {
      // If string, should be detailed
      return successCriteria.split(/\s+/).length >= 30;
    }

    return false;
  }

  // Helper methods for linting

  private findEmptyFields(obj: Record<string, unknown>, path: string = ''): string[] {
    const empty: string[] = [];

    for (const key in obj) {
      const value = obj[key];
      const currentPath = path ? `${path}.${key}` : key;

      if (value === null || value === undefined || value === '') {
        empty.push(currentPath);
      } else if (Array.isArray(value) && value.length === 0) {
        empty.push(currentPath);
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        empty.push(...this.findEmptyFields(value as Record<string, unknown>, currentPath));
      }
    }

    return empty;
  }

  private getSpecificityDetails(mission: MissionContent): Record<string, unknown> {
    return {
      hasExplicitGoal: this.hasExplicitGoal(mission.objective),
      hasDefinedScope: this.hasDefinedScope(mission.context),
      hasFormatSpec: this.hasFormatSpecification(mission),
      hasConstraints: this.hasConstraints(mission),
      hasSuccessCriteria: this.hasWellDefinedSuccessCriteria(mission.successCriteria),
    };
  }

  private getLintingDetails(mission: MissionContent): Record<string, unknown> {
    const fullText = JSON.stringify(mission).toLowerCase();
    const vaguePhrasesFound = this.WEAK_PHRASES.filter((phrase) =>
      fullText.includes(phrase.toLowerCase())
    );

    return {
      vaguePhrasesCount: vaguePhrasesFound.length,
      vaguePhrasesFound: vaguePhrasesFound.slice(0, 5), // First 5
      emptyFieldsCount: this.findEmptyFields(mission).length,
    };
  }
}
