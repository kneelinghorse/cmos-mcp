/**
 * Quality Scoring System Types
 * Based on R4.4_Mission_Quality_metrics research
 */

export interface QualityScore {
  total: number;
  dimensions: {
    clarity: DimensionScore;
    completeness: DimensionScore;
    aiReadiness: DimensionScore;
  };
  benchmark?: number;
  maintainabilityIndex?: number;
  suggestions: ImprovementSuggestion[];
  metadata: {
    assessedAt: string;
    processingTimeMs: number;
    missionId?: string;
  };
}

export interface DimensionScore {
  score: number;
  weight: number;
  metrics: MetricResult[];
}

export interface MetricResult {
  name: string;
  rawValue: number;
  normalizedScore: number;
  weight: number;
  details?: Record<string, unknown>;
}

export interface ImprovementSuggestion {
  severity: 'critical' | 'important' | 'info';
  category: string;
  message: string;
  metric: string;
  context?: Record<string, unknown>;
  location?: {
    field?: string;
    line?: number;
    sentence?: string;
  };
}

export interface ClarityMetrics {
  fleschKincaidGradeLevel: number;
  lexicalDensity: number;
  lexicalAmbiguity: number;
  syntacticAmbiguity: number;
  referentialAmbiguity: number;
  missionCyclomaticComplexity: number;
}

export interface CompletenessMetrics {
  structuralCompleteness: number;
  informationBreadth: number;
  informationDensity: number;
  semanticCoverage: number;
}

export interface AIReadinessMetrics {
  syntacticValidity: boolean;
  instructionSpecificity: number;
  lintingScore: number;
}

export interface WeightsConfig {
  clarity: number;
  completeness: number;
  aiReadiness: number;
  benchmark: number;
}

export interface QualityScorerConfig {
  weights?: Partial<WeightsConfig>;
  metricWeights?: {
    clarity?: Partial<Record<keyof ClarityMetrics, number>>;
    completeness?: Partial<Record<keyof CompletenessMetrics, number>>;
    aiReadiness?: Partial<Record<keyof AIReadinessMetrics, number>>;
  };
  performanceTargetMs?: number;
}

export interface MissionContent {
  objective?: string;
  context?: string;
  successCriteria?: string[] | string;
  deliverables?: string[] | string;
  domainFields?: Record<string, unknown>;
  missionId?: string;
  [key: string]: unknown;
}

export const DEFAULT_WEIGHTS: WeightsConfig = {
  clarity: 0.35,
  completeness: 0.35,
  aiReadiness: 0.2,
  benchmark: 0.1,
};

export const DEFAULT_CLARITY_WEIGHTS: Record<keyof ClarityMetrics, number> = {
  fleschKincaidGradeLevel: 0.15,
  lexicalDensity: 0.15,
  lexicalAmbiguity: 0.2,
  syntacticAmbiguity: 0.2,
  referentialAmbiguity: 0.1,
  missionCyclomaticComplexity: 0.2,
};

export const DEFAULT_COMPLETENESS_WEIGHTS: Record<keyof CompletenessMetrics, number> = {
  structuralCompleteness: 0.4,
  informationBreadth: 0.25,
  informationDensity: 0.15,
  semanticCoverage: 0.2,
};

export const DEFAULT_AI_READINESS_WEIGHTS: Record<keyof AIReadinessMetrics, number> = {
  syntacticValidity: 0.5,
  instructionSpecificity: 0.5,
  lintingScore: 0.0, // Added as extension, not in original framework
};
