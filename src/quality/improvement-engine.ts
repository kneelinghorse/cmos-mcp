/**
 * Actionable Improvement Engine
 * Maps metric scores to specific, context-aware recommendations
 */

import { ImprovementSuggestion, DimensionScore, MissionContent, MetricResult } from './types';

interface FeedbackRule {
  condition: (metricValue: number, details?: Record<string, unknown>) => boolean;
  severity: 'critical' | 'important' | 'info';
  category: string;
  messageTemplate: (
    metricValue: number,
    details?: Record<string, unknown>,
    context?: MissionContent
  ) => string;
}

export class ImprovementEngine {
  private rules: Map<string, FeedbackRule[]>;

  constructor() {
    this.rules = new Map();
    this.initializeRules();
  }

  /**
   * Generate improvement suggestions based on dimensional scores
   */
  generateSuggestions(
    clarityScore: DimensionScore,
    completenessScore: DimensionScore,
    aiReadinessScore: DimensionScore,
    mission: MissionContent
  ): ImprovementSuggestion[] {
    const suggestions: ImprovementSuggestion[] = [];

    // Process clarity metrics
    for (const metric of clarityScore.metrics) {
      suggestions.push(...this.evaluateMetric(metric.name, metric, mission));
    }

    // Process completeness metrics
    for (const metric of completenessScore.metrics) {
      suggestions.push(...this.evaluateMetric(metric.name, metric, mission));
    }

    // Process AI-readiness metrics
    for (const metric of aiReadinessScore.metrics) {
      suggestions.push(...this.evaluateMetric(metric.name, metric, mission));
    }

    // Sort by severity (critical first, then important, then info)
    const severityOrder = { critical: 0, important: 1, info: 2 };
    suggestions.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    return suggestions;
  }

  /**
   * Evaluate a single metric against its rules
   */
  private evaluateMetric(
    metricName: string,
    metric: MetricResult,
    mission: MissionContent
  ): ImprovementSuggestion[] {
    const suggestions: ImprovementSuggestion[] = [];
    const rules = this.rules.get(metricName) || [];

    for (const rule of rules) {
      if (rule.condition(metric.rawValue, metric.details)) {
        suggestions.push({
          severity: rule.severity,
          category: rule.category,
          message: rule.messageTemplate(metric.rawValue, metric.details, mission),
          metric: metricName,
          context: metric.details,
        });
      }
    }

    return suggestions;
  }

  /**
   * Initialize all feedback rules
   */
  private initializeRules(): void {
    const getNumberDetail = (
      detail: Record<string, unknown> | undefined,
      key: string
    ): number | undefined => {
      const value = detail?.[key];
      return typeof value === 'number' ? value : undefined;
    };

    const getStringDetail = (
      detail: Record<string, unknown> | undefined,
      key: string
    ): string | undefined => {
      const value = detail?.[key];
      return typeof value === 'string' ? value : undefined;
    };

    const getBooleanDetail = (
      detail: Record<string, unknown> | undefined,
      key: string
    ): boolean | undefined => {
      const value = detail?.[key];
      return typeof value === 'boolean' ? value : undefined;
    };

    const getStringArrayDetail = (
      detail: Record<string, unknown> | undefined,
      key: string
    ): string[] => {
      const value = detail?.[key];
      if (!Array.isArray(value)) {
        return [];
      }
      return value.filter((item): item is string => typeof item === 'string');
    };

    // Syntactic Validity (Critical)
    this.addRule('Syntactic Validity', {
      condition: (value) => value === 0,
      severity: 'critical',
      category: 'Structure',
      messageTemplate: () =>
        'The mission structure is invalid. Ensure all required fields are present and properly formatted.',
    });

    // Structural Completeness
    this.addRule('Structural Completeness', {
      condition: (value) => value < 1,
      severity: 'critical',
      category: 'Completeness',
      messageTemplate: (value, details) => {
        const missing = getStringArrayDetail(details, 'missing');
        return `Mission is missing required fields: ${missing.join(', ')}. All required fields must be present.`;
      },
    });

    // Mission Cyclomatic Complexity
    this.addRule('Mission Cyclomatic Complexity', {
      condition: (value) => value > 20,
      severity: 'important',
      category: 'Clarity',
      messageTemplate: (value, details) => {
        const riskLevel = getStringDetail(details, 'riskLevel') ?? 'unknown';
        const decisionPoints = getNumberDetail(details, 'decisionPoints');
        const decisionPointsText = decisionPoints !== undefined ? decisionPoints : 'unknown';

        return (
          `This mission's logical complexity is very high (MCC: ${value}, Risk: ${riskLevel}). ` +
          `Consider refactoring into multiple, smaller missions to reduce the number of decision points (${decisionPointsText}).`
        );
      },
    });

    this.addRule('Mission Cyclomatic Complexity', {
      condition: (value) => value > 10 && value <= 20,
      severity: 'info',
      category: 'Clarity',
      messageTemplate: (value, _details) =>
        `Mission complexity is moderate (MCC: ${value}). Consider simplifying conditional logic if possible.`,
    });

    // Flesch-Kincaid Grade Level
    this.addRule('Flesch-Kincaid Grade Level', {
      condition: (value) => value > 15,
      severity: 'info',
      category: 'Clarity',
      messageTemplate: (value, _details) =>
        `Text readability is low (Grade Level: ${value.toFixed(1)}). Consider simplifying sentence structure and word choice.`,
    });

    this.addRule('Flesch-Kincaid Grade Level', {
      condition: (value) => value < 10,
      severity: 'info',
      category: 'Clarity',
      messageTemplate: (value) =>
        `Text may be overly simplified for technical content (Grade Level: ${value.toFixed(1)}). Ensure sufficient technical detail.`,
    });

    // Lexical Density
    this.addRule('Lexical Density', {
      condition: (value) => value < 50,
      severity: 'info',
      category: 'Clarity',
      messageTemplate: (value, details) => {
        const percentage = getStringDetail(details, 'percentage') ?? 'N/A';
        return `Information density is low (${percentage}). Consider reducing filler words and increasing content-bearing terms.`;
      },
    });

    // Referential Ambiguity
    this.addRule('Referential Ambiguity', {
      condition: (value) => value < 0.8,
      severity: 'important',
      category: 'Clarity',
      messageTemplate: (value) =>
        `Mission contains pronouns with unclear antecedents (Score: ${(value * 100).toFixed(0)}%). ` +
        `Replace ambiguous pronouns (it, they, this) with specific nouns for clarity.`,
    });

    // Lexical Ambiguity
    this.addRule('Lexical Ambiguity', {
      condition: (value, details) => (getNumberDetail(details, 'ambiguousWordCount') ?? 0) > 5,
      severity: 'info',
      category: 'Clarity',
      messageTemplate: (value, details) => {
        const ambiguousWordCount = getNumberDetail(details, 'ambiguousWordCount');
        const countText = ambiguousWordCount !== undefined ? ambiguousWordCount : 'several';
        return (
          `Mission contains ${countText} potentially ambiguous words. ` +
          `Review context-dependent terms for clarity.`
        );
      },
    });

    // Information Density
    this.addRule('Information Density', {
      condition: (value) => value < 0.7,
      severity: 'important',
      category: 'Completeness',
      messageTemplate: (value, details) => {
        const issues: string[] = [];
        const objectiveWords = getNumberDetail(details, 'objectiveWords');
        const contextWords = getNumberDetail(details, 'contextWords');
        const successCriteriaCount = getNumberDetail(details, 'successCriteriaCount');
        if ((objectiveWords ?? 0) < 10) issues.push('objective is too brief');
        if ((contextWords ?? 0) < 25) issues.push('context lacks detail');
        if ((successCriteriaCount ?? 0) < 3) issues.push('insufficient success criteria');

        return `Mission lacks sufficient detail: ${issues.join(', ')}. Add more specific information.`;
      },
    });

    // Information Breadth
    this.addRule('Information Breadth', {
      condition: (value) => value < 0.6,
      severity: 'important',
      category: 'Completeness',
      messageTemplate: (value, _details) =>
        `Mission lacks diverse information types (Score: ${(value * 100).toFixed(0)}%). ` +
        `Consider adding more context, examples, or domain-specific details.`,
    });

    // Semantic Coverage
    this.addRule('Semantic Coverage', {
      condition: (value) => value < 0.7,
      severity: 'info',
      category: 'Completeness',
      messageTemplate: (value) =>
        `Mission content may not fully align with its stated objective (Coverage: ${(value * 100).toFixed(0)}%). ` +
        `Ensure all relevant topics are addressed.`,
    });

    // Instruction Specificity
    this.addRule('Instruction Specificity', {
      condition: (value, details) => !getBooleanDetail(details, 'hasExplicitGoal'),
      severity: 'important',
      category: 'AI-Readiness',
      messageTemplate: () =>
        `The objective should contain a clear, action-oriented goal starting with "To [verb]..." ` +
        `and be at least 10 words.`,
    });

    this.addRule('Instruction Specificity', {
      condition: (value, details) => !getBooleanDetail(details, 'hasFormatSpec'),
      severity: 'info',
      category: 'AI-Readiness',
      messageTemplate: () =>
        `Mission does not specify a desired output format. Consider adding phrases like ` +
        `"Present output as JSON" or "Summarize in bullet points" for more predictable results.`,
    });

    this.addRule('Instruction Specificity', {
      condition: (value, details) => !getBooleanDetail(details, 'hasConstraints'),
      severity: 'info',
      category: 'AI-Readiness',
      messageTemplate: () =>
        `Mission lacks explicit constraints. Consider adding "must/must not" statements ` +
        `or defining what is out-of-scope.`,
    });

    this.addRule('Instruction Specificity', {
      condition: (value, details) => !getBooleanDetail(details, 'hasSuccessCriteria'),
      severity: 'important',
      category: 'AI-Readiness',
      messageTemplate: () =>
        `Success criteria are not well-defined. Include at least 3 specific, measurable criteria ` +
        `with at least 5 words each.`,
    });

    // Linting Score
    this.addRule('Linting Score', {
      condition: (value, details) => (getNumberDetail(details, 'vaguePhrasesCount') ?? 0) > 5,
      severity: 'info',
      category: 'AI-Readiness',
      messageTemplate: (value, details) => {
        const vagueCount = getNumberDetail(details, 'vaguePhrasesCount') ?? 0;
        const phrases = getStringArrayDetail(details, 'vaguePhrasesFound');
        const phrasesText = phrases.length > 0 ? phrases.join(', ') : 'n/a';
        return (
          `Mission contains ${vagueCount} vague phrases ` +
          `(e.g., ${phrasesText}). Replace with specific, measurable terms.`
        );
      },
    });

    this.addRule('Linting Score', {
      condition: (value, details) => (getNumberDetail(details, 'emptyFieldsCount') ?? 0) > 0,
      severity: 'info',
      category: 'Structure',
      messageTemplate: (value, details) => {
        const emptyFieldsCount = getNumberDetail(details, 'emptyFieldsCount') ?? 0;
        return `Mission has ${emptyFieldsCount} empty fields. Remove unused fields or populate with content.`;
      },
    });
  }

  /**
   * Add a feedback rule for a specific metric
   */
  private addRule(metricName: string, rule: FeedbackRule): void {
    if (!this.rules.has(metricName)) {
      this.rules.set(metricName, []);
    }
    this.rules.get(metricName)!.push(rule);
  }

  /**
   * Get all rules for a metric (for testing/debugging)
   */
  getRulesForMetric(metricName: string): FeedbackRule[] {
    return this.rules.get(metricName) || [];
  }
}
