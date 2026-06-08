import { promises as fs } from 'fs';
import * as path from 'path';
import { z } from 'zod';
import {
  DependencyAnalyzer,
  MissionRecord,
  isMissionRecord,
} from '../intelligence/dependency-analyzer';
import { GraphValidator } from '../intelligence/graph-validator';
import { DependencyInferrer, InferredDependency } from '../intelligence/dependency-inferrer';
import * as yaml from 'js-yaml';
import { ValidationError } from '../errors/validation-error';
import { IOError } from '../errors/io-error';
import { ErrorHandler } from '../errors/handler';
import { safeFilePath } from '../validation/common';
import { validateAndSanitize } from '../validation/middleware';
import { createFilePathSchema } from '../validation/schemas/file-path-schema';
import { MissionProtocolError } from '../errors/mission-error';
import { pathExists } from '../utils/fs';

/**
 * Arguments for analyze_dependencies MCP tool
 */
export interface AnalyzeDependenciesArgs {
  missionDirectory: string;
  includeInferred?: boolean;
  minConfidence?: number;
}

/**
 * Result from analyze_dependencies MCP tool
 */
export interface AnalyzeDependenciesResult {
  totalMissions: number;
  isValid: boolean;
  isDAG: boolean;
  hasCycles: boolean;
  cycles?: string[][];
  executionOrder?: string[];
  criticalPath?: string[];
  inferredDependencies?: Array<{
    from: string;
    to: string;
    confidence: number;
    reason: string;
  }>;
  errors: string[];
  warnings: string[];
  performanceMs: number;
}

/**
 * Analyze dependencies in a mission directory
 * MCP tool implementation for dependency analysis
 */
export async function analyzeDependencies(
  args: AnalyzeDependenciesArgs
): Promise<AnalyzeDependenciesResult> {
  const startTime = Date.now();

  try {
    const validated = await validateArgs(args);
    const missionDirectory = await safeFilePath(validated.missionDirectory, {
      allowRelative: true,
      maxLength: 4096,
    });
    const absoluteMissionDirectory = path.resolve(missionDirectory);

    if (!(await pathExists(absoluteMissionDirectory))) {
      throw new IOError(`Mission directory does not exist: ${missionDirectory}`, {
        code: 'IO_NOT_FOUND',
        context: { missionDirectory },
      });
    }

    // Find all mission files
    const missionFiles = await findMissionFiles(absoluteMissionDirectory);

    if (missionFiles.length === 0) {
      throw new ValidationError(`No mission files found in ${missionDirectory}`, {
        context: { missionDirectory },
      });
    }

    // Load mission data
    const missions = await loadMissionFiles(missionFiles);

    // Create analyzer and analyze dependencies
    const analyzer = new DependencyAnalyzer();
    const analysisResult = await analyzer.analyze(missions);

    // Validate graph
    const validator = new GraphValidator();
    const validationResult = validator.validate(analysisResult.graph);

    // Infer implicit dependencies if requested
    let inferredDependencies: InferredDependency[] | undefined;
    if (validated.includeInferred) {
      const inferrer = new DependencyInferrer();
      const allInferred: InferredDependency[] = [];

      for (const mission of missions) {
        const inferred = inferrer.inferDependencies(analysisResult.graph, mission);
        allInferred.push(...inferred);
      }

      // Filter by confidence
      const minConfidence = validated.minConfidence ?? 0.7;
      inferredDependencies = inferrer.filterByConfidence(allInferred, minConfidence);
    }

    const performanceMs = Date.now() - startTime;

    // Return result
    return {
      totalMissions: missionFiles.length,
      isValid: validationResult.isValid,
      isDAG: validationResult.isDAG,
      hasCycles: analysisResult.hasCycles,
      cycles: analysisResult.cycles,
      executionOrder: analysisResult.executionOrder,
      criticalPath: analysisResult.criticalPath,
      inferredDependencies: inferredDependencies?.map((dep) => ({
        from: dep.from,
        to: dep.to,
        confidence: dep.confidence,
        reason: dep.reason,
      })),
      errors: validationResult.errors,
      warnings: validationResult.warnings,
      performanceMs,
    };
  } catch (error: unknown) {
    const performanceMs = Date.now() - startTime;
    if (error instanceof MissionProtocolError) {
      return {
        totalMissions: 0,
        isValid: false,
        isDAG: false,
        hasCycles: false,
        errors: [error.message],
        warnings: [],
        performanceMs,
      };
    }
    const missionError = ErrorHandler.handle(
      error,
      'tools.get_dependency_analysis.execute',
      {
        module: 'tools/analyze-dependencies',
        data: {
          missionDirectory: args.missionDirectory,
          includeInferred: Boolean(args.includeInferred),
        },
      },
      {
        rethrow: false,
        userMessage: 'Dependency analysis failed.',
      }
    );
    const publicError = ErrorHandler.toPublicError(missionError);
    const errorMessage = publicError.correlationId
      ? `${publicError.message} (correlationId=${publicError.correlationId})`
      : publicError.message;
    return {
      totalMissions: 0,
      isValid: false,
      isDAG: false,
      hasCycles: false,
      errors: [errorMessage],
      warnings: [],
      performanceMs,
    };
  }
}

/**
 * Find all mission YAML files in a directory
 */
async function findMissionFiles(directory: string): Promise<string[]> {
  const missionFiles: string[] = [];

  async function traverse(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = await safeFilePath(path.join(dir, entry.name), {
        allowRelative: false,
      });

      if (entry.isDirectory()) {
        // Skip node_modules, .git, etc.
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          await traverse(fullPath);
        }
      } else if (entry.isFile()) {
        // Check if it's a YAML mission file
        if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
          missionFiles.push(fullPath);
        }
      }
    }
  }

  await traverse(directory);
  return missionFiles;
}

/**
 * Load mission files and parse YAML
 */
async function loadMissionFiles(filePaths: string[]): Promise<MissionRecord[]> {
  const missions: MissionRecord[] = [];

  for (const filePath of filePaths) {
    try {
      const sanitizedPath = await safeFilePath(filePath, { allowRelative: false });
      const content = await fs.readFile(sanitizedPath, 'utf-8');
      const missionData = yaml.load(content);

      if (!isMissionRecord(missionData)) {
        ErrorHandler.handle(
          new ValidationError('Mission file is missing required identifiers', {
            context: { filePath: sanitizedPath },
            severity: 'warning',
          }),
          'tools.get_dependency_analysis.load_mission_file.invalid',
          {
            module: 'tools/analyze-dependencies',
            data: { filePath: sanitizedPath },
          },
          {
            severity: 'warning',
            rethrow: false,
            userMessage: `Mission file ${path.basename(filePath)} is missing required missionId`,
          }
        );
        continue;
      }

      missions.push({ ...missionData, filePath: sanitizedPath });
    } catch (error) {
      ErrorHandler.handle(
        error,
        'tools.get_dependency_analysis.load_mission_file',
        {
          module: 'tools/analyze-dependencies',
          data: { filePath },
        },
        {
          severity: 'warning',
          rethrow: false,
          userMessage: `Failed to load mission file ${path.basename(filePath)}`,
        }
      );
    }
  }

  return missions;
}

/**
 * Format analysis result as readable text
 */
export function formatAnalysisResult(result: AnalyzeDependenciesResult): string {
  const lines: string[] = [];

  lines.push('=== Dependency Analysis Report ===\n');
  lines.push(`Total Missions: ${result.totalMissions}`);
  lines.push(`Analysis Time: ${result.performanceMs}ms`);
  lines.push(`Valid: ${result.isValid ? 'Yes' : 'No'}`);
  lines.push(`Is DAG: ${result.isDAG ? 'Yes' : 'No'}`);
  lines.push(`Has Cycles: ${result.hasCycles ? 'Yes' : 'No'}\n`);

  if (result.errors.length > 0) {
    lines.push('Errors:');
    result.errors.forEach((err) => lines.push(`  - ${err}`));
    lines.push('');
  }

  if (result.warnings.length > 0) {
    lines.push('Warnings:');
    result.warnings.forEach((warn) => lines.push(`  - ${warn}`));
    lines.push('');
  }

  if (result.cycles && result.cycles.length > 0) {
    lines.push('Circular Dependencies Detected:');
    result.cycles.forEach((cycle, i) => {
      lines.push(`  ${i + 1}. ${cycle.join(' -> ')}`);
    });
    lines.push('');
  }

  if (result.executionOrder) {
    lines.push('Execution Order:');
    result.executionOrder.forEach((mission, i) => {
      lines.push(`  ${i + 1}. ${mission}`);
    });
    lines.push('');
  }

  if (result.criticalPath && result.criticalPath.length > 0) {
    lines.push('Critical Path:');
    lines.push(`  ${result.criticalPath.join(' -> ')}`);
    lines.push('');
  }

  if (result.inferredDependencies && result.inferredDependencies.length > 0) {
    lines.push('Inferred Dependencies:');
    result.inferredDependencies.forEach((dep) => {
      lines.push(`  ${dep.from} -> ${dep.to} (confidence: ${(dep.confidence * 100).toFixed(0)}%)`);
      lines.push(`    Reason: ${dep.reason}`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * MCP Tool Definition for dependency analysis
 */
export const getDependencyAnalysisToolDefinition = {
  name: 'get_dependency_analysis',
  description:
    'Analyze mission YAML files to construct a dependency graph, validate DAG properties, detect cycles, and compute execution order. Optionally infer implicit dependencies.',
  inputSchema: {
    type: 'object',
    properties: {
      missionDirectory: { type: 'string', description: 'Directory containing mission YAML files' },
      includeInferred: { type: 'boolean', description: 'Include NLP-based inferred dependencies' },
      minConfidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Minimum confidence for inferred dependencies',
      },
    },
    required: ['missionDirectory'],
    additionalProperties: false,
  },
} as const;

/**
 * Legacy alias maintained for one release cycle
 */
export const analyzeDependenciesToolDefinitionDeprecated = {
  ...getDependencyAnalysisToolDefinition,
  name: 'analyze_dependencies',
  description:
    '[DEPRECATED] Use get_dependency_analysis instead. Returns the same dependency graph report.',
} as const;

/**
 * Wrap execution for MCP server usage
 */
export async function executeAnalyzeDependenciesTool(
  params: AnalyzeDependenciesArgs
): Promise<string> {
  const result = await analyzeDependencies({
    missionDirectory: params.missionDirectory,
    includeInferred: params.includeInferred,
    minConfidence: params.minConfidence,
  });
  return formatAnalysisResult(result);
}

const AnalyzeDependenciesArgsSchema = z
  .object({
    missionDirectory: createFilePathSchema({ allowRelative: true }),
    includeInferred: z.boolean().optional(),
    minConfidence: z.number().min(0).max(1).optional(),
  })
  .strict();

type ValidatedAnalyzeDependenciesArgs = z.infer<typeof AnalyzeDependenciesArgsSchema>;

async function validateArgs(
  args: AnalyzeDependenciesArgs
): Promise<ValidatedAnalyzeDependenciesArgs> {
  return validateAndSanitize(args, AnalyzeDependenciesArgsSchema);
}
