/**
 * MCP Tool: score_quality
 * Assesses mission quality using the three-dimensional framework
 */

import { SecureYAMLLoader } from '../loaders/yaml-loader';
import { QualityScorer } from '../quality/quality-scorer';
import { QualityScore, MissionContent } from '../quality/types';
import * as path from 'path';

export interface ScoreQualityInput {
  missionFile: string;
  verbose?: boolean;
}

export interface ScoreQualityOutput {
  success: boolean;
  score?: QualityScore;
  summary?: string;
  error?: string;
}

/**
 * Score mission quality and provide actionable feedback
 */
export async function scoreQuality(input: ScoreQualityInput): Promise<ScoreQualityOutput> {
  try {
    // Load mission file
    const missionFile = path.resolve(input.missionFile);
    const baseDir = path.dirname(missionFile);

    const loader = new SecureYAMLLoader({
      baseDir,
      maxFileSize: 5 * 1024 * 1024, // 5MB
    });

    const mission = await loader.load<MissionContent>(path.basename(missionFile));

    // Create scorer with default configuration
    const scorer = new QualityScorer();

    // Score the mission
    const score = await scorer.score(mission, mission.missionId);

    // Generate summary
    const summary = formatQualitySummary(score, input.verbose);

    return {
      success: true,
      score,
      summary,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Format quality score as human-readable summary
 */
export function formatQualitySummary(score: QualityScore, verbose: boolean = false): string {
  const lines: string[] = [];

  // Header
  lines.push('=== Mission Quality Assessment ===\n');

  // Overall score
  const totalPercent = (score.total * 100).toFixed(1);
  const grade = getQualityGrade(score.total);
  lines.push(`Overall Quality Score: ${totalPercent}% (${grade})\n`);

  // Dimensional breakdown
  lines.push('Dimensional Scores:');
  lines.push(`  Clarity:      ${(score.dimensions.clarity.score * 100).toFixed(1)}%`);
  lines.push(`  Completeness: ${(score.dimensions.completeness.score * 100).toFixed(1)}%`);
  lines.push(`  AI-Readiness: ${(score.dimensions.aiReadiness.score * 100).toFixed(1)}%`);
  lines.push('');

  // Performance
  lines.push(`Processing Time: ${score.metadata.processingTimeMs}ms`);
  lines.push('');

  // Suggestions
  if (score.suggestions.length > 0) {
    lines.push('Improvement Suggestions:');

    const criticalSuggestions = score.suggestions.filter((s) => s.severity === 'critical');
    const importantSuggestions = score.suggestions.filter((s) => s.severity === 'important');
    const infoSuggestions = score.suggestions.filter((s) => s.severity === 'info');

    if (criticalSuggestions.length > 0) {
      lines.push('\n  CRITICAL:');
      criticalSuggestions.forEach((s, i) => {
        lines.push(`    ${i + 1}. ${s.message}`);
      });
    }

    if (importantSuggestions.length > 0) {
      lines.push('\n  IMPORTANT:');
      importantSuggestions.forEach((s, i) => {
        lines.push(`    ${i + 1}. ${s.message}`);
      });
    }

    if (verbose && infoSuggestions.length > 0) {
      lines.push('\n  INFO:');
      infoSuggestions.forEach((s, i) => {
        lines.push(`    ${i + 1}. ${s.message}`);
      });
    }
  } else {
    lines.push('No improvement suggestions - mission meets quality standards!');
  }

  // Verbose metrics breakdown
  if (verbose) {
    lines.push('\n=== Detailed Metrics ===\n');

    lines.push('Clarity Metrics:');
    score.dimensions.clarity.metrics.forEach((m) => {
      lines.push(
        `  ${m.name}: ${(m.normalizedScore * 100).toFixed(1)}% (raw: ${m.rawValue.toFixed(2)})`
      );
    });

    lines.push('\nCompleteness Metrics:');
    score.dimensions.completeness.metrics.forEach((m) => {
      lines.push(
        `  ${m.name}: ${(m.normalizedScore * 100).toFixed(1)}% (raw: ${m.rawValue.toFixed(2)})`
      );
    });

    lines.push('\nAI-Readiness Metrics:');
    score.dimensions.aiReadiness.metrics.forEach((m) => {
      lines.push(
        `  ${m.name}: ${(m.normalizedScore * 100).toFixed(1)}% (raw: ${m.rawValue.toFixed(2)})`
      );
    });
  }

  return lines.join('\n');
}

/**
 * Convert numerical score to letter grade
 */
export function getQualityGrade(score: number): string {
  if (score >= 0.9) return 'A (Excellent)';
  if (score >= 0.8) return 'B (Good)';
  if (score >= 0.7) return 'C (Acceptable)';
  if (score >= 0.6) return 'D (Needs Improvement)';
  return 'F (Poor)';
}

/**
 * MCP tool metadata for registration
 */
export const getMissionQualityScoreTool = {
  name: 'get_mission_quality_score',
  description:
    'Assess mission quality using three-dimensional framework (Clarity, Completeness, AI-Readiness)',
  inputSchema: {
    type: 'object',
    properties: {
      missionFile: {
        type: 'string',
        description: 'Path to the mission YAML file to assess',
      },
      verbose: {
        type: 'boolean',
        description: 'Include detailed metric breakdown in output',
        default: false,
      },
    },
    required: ['missionFile'],
    additionalProperties: false,
  },
  handler: scoreQuality,
} as const;

/**
 * Legacy alias maintained for one release cycle
 */
export const scoreQualityToolDeprecated = {
  ...getMissionQualityScoreTool,
  name: 'score_quality',
  description:
    '[DEPRECATED] Use get_mission_quality_score instead. Runs the same quality scoring pipeline.',
} as const;
