/**
 * Completeness Dimension Analyzer
 * Implements: Structural, Informational (Breadth & Density), and Semantic Coverage
 */

import {
  DimensionScore,
  MetricResult,
  CompletenessMetrics,
  MissionContent,
  DEFAULT_COMPLETENESS_WEIGHTS,
} from '../types';

export class CompletenessAnalyzer {
  private weights: Record<keyof CompletenessMetrics, number>;

  // Required fields based on mission schema
  private readonly REQUIRED_FIELDS = ['objective', 'context', 'successCriteria', 'deliverables'];
  private readonly RECOMMENDED_FIELDS = ['missionId', 'domainFields'];

  constructor(customWeights?: Partial<Record<keyof CompletenessMetrics, number>>) {
    this.weights = { ...DEFAULT_COMPLETENESS_WEIGHTS, ...customWeights };
  }

  async analyze(mission: MissionContent): Promise<DimensionScore> {
    const metrics: CompletenessMetrics = {
      structuralCompleteness: this.calculateStructuralCompleteness(mission),
      informationBreadth: this.calculateInformationBreadth(mission),
      informationDensity: this.calculateInformationDensity(mission),
      semanticCoverage: await this.calculateSemanticCoverage(mission),
    };

    const metricResults: MetricResult[] = [
      {
        name: 'Structural Completeness',
        rawValue: metrics.structuralCompleteness,
        normalizedScore: metrics.structuralCompleteness,
        weight: this.weights.structuralCompleteness,
        details: this.getStructuralDetails(mission),
      },
      {
        name: 'Information Breadth',
        rawValue: metrics.informationBreadth,
        normalizedScore: metrics.informationBreadth,
        weight: this.weights.informationBreadth,
        details: this.getBreadthDetails(mission),
      },
      {
        name: 'Information Density',
        rawValue: metrics.informationDensity,
        normalizedScore: metrics.informationDensity,
        weight: this.weights.informationDensity,
        details: this.getDensityDetails(mission),
      },
      {
        name: 'Semantic Coverage',
        rawValue: metrics.semanticCoverage,
        normalizedScore: metrics.semanticCoverage,
        weight: this.weights.semanticCoverage,
        details: { note: 'Simplified heuristic-based scoring' },
      },
    ];

    const score = metricResults.reduce(
      (sum, metric) => sum + metric.normalizedScore * metric.weight,
      0
    );

    return {
      score,
      weight: 0.35,
      metrics: metricResults,
    };
  }

  /**
   * Calculate structural completeness (schema adherence)
   * Percentage of required fields that are present and non-empty
   */
  private calculateStructuralCompleteness(mission: MissionContent): number {
    let presentCount = 0;
    const totalRequired = this.REQUIRED_FIELDS.length;

    for (const field of this.REQUIRED_FIELDS) {
      const value = mission[field];
      if (value !== undefined && value !== null) {
        // Check for non-empty content
        if (typeof value === 'string' && value.trim().length > 0) {
          presentCount++;
        } else if (Array.isArray(value) && value.length > 0) {
          presentCount++;
        } else if (typeof value === 'object') {
          presentCount++;
        }
      }
    }

    return presentCount / totalRequired;
  }

  /**
   * Calculate information breadth
   * Checks for presence of diverse information types
   */
  private calculateInformationBreadth(mission: MissionContent): number {
    const checks = [
      // Core mission elements
      { name: 'Has objective', test: () => this.hasNonEmpty(mission.objective) },
      { name: 'Has context', test: () => this.hasNonEmpty(mission.context) },
      { name: 'Has success criteria', test: () => this.hasArrayOrString(mission.successCriteria) },
      { name: 'Has deliverables', test: () => this.hasArrayOrString(mission.deliverables) },

      // Domain-specific elements
      { name: 'Has domain type', test: () => mission.domainFields?.type !== undefined },
      { name: 'Has mission ID', test: () => this.hasNonEmpty(mission.missionId) },

      // Rich content indicators
      {
        name: 'Multiple success criteria',
        test: () => this.getArrayLength(mission.successCriteria) >= 3,
      },
      { name: 'Multiple deliverables', test: () => this.getArrayLength(mission.deliverables) >= 2 },

      // Domain-specific breadth (varies by type)
      { name: 'Has domain fields', test: () => this.hasDomainFields(mission) },
      { name: 'Has research content', test: () => this.hasResearchContent(mission) },
    ];

    const passedCount = checks.filter((check) => check.test()).length;
    return passedCount / checks.length;
  }

  /**
   * Calculate information density
   * Ensures key fields contain sufficient detail
   */
  private calculateInformationDensity(mission: MissionContent): number {
    const densityChecks = [
      // Objective should be substantive (>10 words)
      {
        name: 'Objective density',
        test: () => this.wordCount(mission.objective) >= 10,
        weight: 0.3,
      },

      // Context should be detailed (>25 words)
      {
        name: 'Context density',
        test: () => this.wordCount(mission.context) >= 25,
        weight: 0.3,
      },

      // Success criteria should have multiple items with detail
      {
        name: 'Success criteria density',
        test: () => {
          const count = this.getArrayLength(mission.successCriteria);
          const totalWords = this.wordCount(
            Array.isArray(mission.successCriteria)
              ? mission.successCriteria.join(' ')
              : mission.successCriteria
          );
          return count >= 3 && totalWords >= 30;
        },
        weight: 0.2,
      },

      // Deliverables should be specific
      {
        name: 'Deliverables density',
        test: () => {
          const count = this.getArrayLength(mission.deliverables);
          return count >= 2;
        },
        weight: 0.2,
      },
    ];

    let score = 0;
    for (const check of densityChecks) {
      if (check.test()) {
        score += check.weight;
      }
    }

    return score;
  }

  /**
   * Calculate semantic coverage
   * Simplified heuristic: checks for topic alignment with mission type
   */
  private async calculateSemanticCoverage(mission: MissionContent): Promise<number> {
    // In full implementation, this would use topic modeling or embeddings
    // For now, using heuristic-based scoring

    const missionTypeValue = mission.domainFields?.type;
    const missionType = typeof missionTypeValue === 'string' ? missionTypeValue : '';
    const fullText = this.extractFullText(mission);
    const words = fullText.toLowerCase();

    // Define expected topic keywords for different mission types
    const topicKeywords = this.getExpectedTopics(missionType);

    if (topicKeywords.length === 0) {
      // Unknown type, give benefit of doubt
      return 0.7;
    }

    // Check how many expected topics are covered
    const coveredTopics = topicKeywords.filter((keyword) => words.includes(keyword.toLowerCase()));

    const coverage = coveredTopics.length / topicKeywords.length;

    // Also check for depth: are topics mentioned multiple times?
    const depth = this.calculateTopicDepth(words, coveredTopics);

    // Combine coverage and depth
    return coverage * 0.7 + depth * 0.3;
  }

  // Helper methods

  private hasNonEmpty(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    return true;
  }

  private hasArrayOrString(value: unknown): boolean {
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    return false;
  }

  private getArrayLength(value: unknown): number {
    if (Array.isArray(value)) return value.length;
    if (typeof value === 'string' && value.trim().length > 0) return 1;
    return 0;
  }

  private wordCount(value: unknown): number {
    if (!value) return 0;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.split(/\s+/).filter((w) => w.length > 0).length;
  }

  private hasDomainFields(mission: MissionContent): boolean {
    return mission.domainFields !== undefined && Object.keys(mission.domainFields).length > 1; // More than just 'type'
  }

  private hasResearchContent(mission: MissionContent): boolean {
    const df = mission.domainFields;
    if (!df) return false;

    return !!(
      df.researchQuestions ||
      df.keyFindings ||
      df.evidenceCollection ||
      df.buildImplications
    );
  }

  private extractFullText(mission: MissionContent): string {
    const parts: string[] = [];

    if (mission.objective) parts.push(mission.objective);
    if (mission.context) parts.push(mission.context);

    if (mission.successCriteria) {
      parts.push(
        Array.isArray(mission.successCriteria)
          ? mission.successCriteria.join(' ')
          : mission.successCriteria
      );
    }

    if (mission.deliverables) {
      parts.push(
        Array.isArray(mission.deliverables) ? mission.deliverables.join(' ') : mission.deliverables
      );
    }

    if (mission.domainFields) {
      parts.push(JSON.stringify(mission.domainFields));
    }

    return parts.join(' ');
  }

  private getExpectedTopics(missionType: string): string[] {
    const typeMap: Record<string, string[]> = {
      'Build.TechnicalResearch.v1': [
        'research',
        'analysis',
        'findings',
        'evidence',
        'standards',
        'metrics',
        'framework',
        'methodology',
        'evaluation',
      ],
      'Build.Implementation.v1': [
        'implement',
        'build',
        'develop',
        'code',
        'test',
        'integration',
        'functionality',
        'performance',
        'deliverable',
      ],
      'Build.Documentation.v1': [
        'document',
        'specification',
        'guide',
        'instructions',
        'overview',
        'reference',
        'examples',
        'usage',
      ],
    };

    return typeMap[missionType] || [];
  }

  private calculateTopicDepth(text: string, topics: string[]): number {
    if (topics.length === 0) return 0;

    let totalMentions = 0;
    for (const topic of topics) {
      const regex = new RegExp(topic, 'gi');
      const matches = text.match(regex);
      totalMentions += matches ? matches.length : 0;
    }

    // Normalize: depth score based on average mentions per topic
    const avgMentions = totalMentions / topics.length;

    // Scale: 1 mention = 0.3, 2 = 0.6, 3+ = 1.0
    if (avgMentions >= 3) return 1.0;
    if (avgMentions >= 2) return 0.6;
    if (avgMentions >= 1) return 0.3;
    return 0;
  }

  private getStructuralDetails(mission: MissionContent): Record<string, unknown> {
    const missing: string[] = [];
    const present: string[] = [];

    for (const field of this.REQUIRED_FIELDS) {
      if (!this.hasNonEmpty(mission[field])) {
        missing.push(field);
      } else {
        present.push(field);
      }
    }

    return { present, missing, total: this.REQUIRED_FIELDS.length };
  }

  private getBreadthDetails(mission: MissionContent): Record<string, unknown> {
    return {
      hasSuccessCriteria: this.getArrayLength(mission.successCriteria),
      hasDeliverables: this.getArrayLength(mission.deliverables),
      hasDomainFields: this.hasDomainFields(mission),
      hasResearchContent: this.hasResearchContent(mission),
    };
  }

  private getDensityDetails(mission: MissionContent): Record<string, unknown> {
    return {
      objectiveWords: this.wordCount(mission.objective),
      contextWords: this.wordCount(mission.context),
      successCriteriaCount: this.getArrayLength(mission.successCriteria),
      deliverablesCount: this.getArrayLength(mission.deliverables),
    };
  }
}
