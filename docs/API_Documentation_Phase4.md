# Phase 4 API Documentation - Intelligence Layer

Complete API reference for Mission Protocol v2 Intelligence Layer tools.

---

## Tool: `update_token_optimization` (alias `optimize_tokens`)

Optimize mission content for token efficiency using model-aware compression.

### MCP Tool Definition

```json
{
  "name": "optimize_tokens",
  "description": "Optimize mission content for token efficiency. Applies model-aware compression using a 4-pass pipeline: sanitization, structural refactoring, linguistic simplification, and model-specific templating. Target reduction: 20-30% tokens while maintaining semantic integrity.",
  "inputSchema": {
    "type": "object",
    "required": ["missionFile", "targetModel"],
    "properties": {
      "missionFile": {
        "type": "string",
        "description": "Path to mission YAML file to optimize"
      },
      "targetModel": {
        "type": "string",
        "enum": ["claude", "gpt", "gemini"],
        "description": "Target AI model for optimization"
      },
      "compressionLevel": {
        "type": "string",
        "enum": ["conservative", "balanced", "aggressive"],
        "description": "Compression aggressiveness (default: balanced)",
        "default": "balanced"
      },
      "dryRun": {
        "type": "boolean",
        "description": "Preview changes without modifying file",
        "default": false
      },
      "preserveTags": {
        "type": "array",
        "items": { "type": "string" },
        "description": "YAML tags to preserve from compression"
      }
    }
  }
}
```

### TypeScript API

```typescript
import { handleOptimizeTokens } from './tools/optimize-tokens';

interface OptimizeTokensParams {
  missionFile: string;
  targetModel: 'claude' | 'gpt' | 'gemini';
  compressionLevel?: 'conservative' | 'balanced' | 'aggressive';
  dryRun?: boolean;
  preserveTags?: string[];
}

interface OptimizeTokensResult {
  success: boolean;
  optimizedContent?: string;
  stats?: {
    originalTokens: number;
    compressedTokens: number;
    reductionPercentage: number;
    compressionRatio: number;
    passesApplied: string[];
  };
  warnings?: string[];
  error?: string;
}

const result = await handleOptimizeTokens(params: OptimizeTokensParams): Promise<OptimizeTokensResult>
```

### Example Request

```json
{
  "missionFile": "missions/sprint-04/B4.1_token-optimization.yaml",
  "targetModel": "claude",
  "compressionLevel": "balanced",
  "dryRun": false
}
```

### Example Response

```json
{
  "success": true,
  "optimizedContent": "missionId: \"B4.1\"...",
  "stats": {
    "originalTokens": 1250,
    "compressedTokens": 975,
    "reductionPercentage": 22.0,
    "compressionRatio": 0.78,
    "passesApplied": ["sanitization", "structural", "linguistic", "model-specific"]
  },
  "warnings": []
}
```

### Compression Pipeline

1. **Sanitization Pass**: Remove comments, normalize whitespace
2. **Structural Pass**: Compact YAML structure, merge arrays
3. **Linguistic Pass**: Simplify language, remove redundancy
4. **Model-Specific Pass**: Apply model-optimized syntax (Claude, GPT, or Gemini)

### Error Handling

| Error                    | Cause           | Solution               |
| ------------------------ | --------------- | ---------------------- |
| `Mission file not found` | Invalid path    | Verify file path       |
| `Invalid YAML format`    | Malformed YAML  | Fix YAML syntax        |
| `Compression failed`     | Algorithm error | Try conservative level |

---

## Tool: `get_mission_quality_score` (alias `score_quality`)

Assess mission quality using three-dimensional framework: Clarity, Completeness, AI-Readiness.

### MCP Tool Definition

```json
{
  "name": "score_quality",
  "description": "Assess mission quality across three dimensions: Clarity (readability, ambiguity), Completeness (structural coverage, information density), AI-Readiness (specificity, syntax validity). Returns normalized 0-1 score with actionable improvement suggestions.",
  "inputSchema": {
    "type": "object",
    "required": ["missionFile"],
    "properties": {
      "missionFile": {
        "type": "string",
        "description": "Path to mission YAML file to assess"
      },
      "verbose": {
        "type": "boolean",
        "description": "Include detailed metrics breakdown",
        "default": false
      }
    }
  }
}
```

### TypeScript API

```typescript
import { scoreQuality } from './tools/score-quality';

interface ScoreQualityInput {
  missionFile: string;
  verbose?: boolean;
}

interface QualityScore {
  total: number; // 0-1 normalized score
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

interface DimensionScore {
  score: number; // 0-1 normalized
  weight: number;
  metrics: MetricResult[];
}

interface ImprovementSuggestion {
  severity: 'critical' | 'important' | 'info';
  category: string;
  message: string;
  metric: string;
  context?: Record<string, any>;
}

interface ScoreQualityOutput {
  success: boolean;
  score?: QualityScore;
  summary?: string;
  error?: string;
}

const result = await scoreQuality(input: ScoreQualityInput): Promise<ScoreQualityOutput>
```

### Example Request

```json
{
  "missionFile": "missions/current.yaml",
  "verbose": true
}
```

### Example Response

```json
{
  "success": true,
  "score": {
    "total": 0.824,
    "dimensions": {
      "clarity": {
        "score": 0.853,
        "weight": 0.35,
        "metrics": [
          {
            "name": "Flesch-Kincaid Grade Level",
            "rawValue": 12.5,
            "normalizedScore": 0.875,
            "weight": 0.25
          }
        ]
      },
      "completeness": {
        "score": 0.912,
        "weight": 0.35,
        "metrics": [...]
      },
      "aiReadiness": {
        "score": 0.887,
        "weight": 0.30,
        "metrics": [...]
      }
    },
    "suggestions": [
      {
        "severity": "important",
        "category": "Clarity",
        "message": "Success criteria could be more specific",
        "metric": "Instruction Specificity"
      }
    ],
    "metadata": {
      "assessedAt": "2025-10-05T12:00:00Z",
      "processingTimeMs": 12,
      "missionId": "B4.5"
    }
  }
}
```

### Quality Dimensions

**Clarity (35% weight)**

- Flesch-Kincaid Grade Level (readability)
- Lexical Density (vocabulary richness)
- Lexical Ambiguity (word-level clarity)
- Syntactic Ambiguity (sentence-level clarity)
- Referential Ambiguity (pronoun clarity)
- Mission Cyclomatic Complexity (logical complexity)

**Completeness (35% weight)**

- Structural Completeness (required fields present)
- Information Breadth (coverage of key aspects)
- Information Density (content richness)
- Semantic Coverage (topic completeness)

**AI-Readiness (30% weight)**

- Syntactic Validity (YAML correctness)
- Instruction Specificity (actionable detail)
- Linting Score (structural quality)

---

## Tool: `get_dependency_analysis` (alias `analyze_dependencies`)

Detect and analyze dependencies between missions in a directory or explicit set.

### MCP Tool Definition

```json
{
  "name": "analyze_dependencies",
  "description": "Analyze mission dependencies using explicit (YAML-declared) and implicit (semantic) detection. Validates execution order, detects circular dependencies, generates dependency graph. Returns topological sort for optimal execution sequence.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "missionDirectory": {
        "type": "string",
        "description": "Directory containing mission files to analyze"
      },
      "missionPaths": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Explicit list of mission file paths"
      },
      "outputFormat": {
        "type": "string",
        "enum": ["summary", "detailed", "mermaid"],
        "description": "Output format (default: summary)",
        "default": "summary"
      }
    }
  }
}
```

### TypeScript API

```typescript
import { executeAnalyzeDependenciesTool } from './tools/analyze-dependencies';

interface AnalyzeDependenciesParams {
  missionDirectory?: string;
  missionPaths?: string[];
  outputFormat?: 'summary' | 'detailed' | 'mermaid';
}

const summary: string = await executeAnalyzeDependenciesTool(params: AnalyzeDependenciesParams): Promise<string>
```

### Example Request (Directory)

```json
{
  "missionDirectory": "missions/sprint-04",
  "outputFormat": "detailed"
}
```

### Example Request (Explicit Paths)

```json
{
  "missionPaths": [
    "missions/sprint-04/B4.1_token-optimization.yaml",
    "missions/sprint-04/B4.2_mission-splitting.yaml",
    "missions/sprint-04/B4.3_dependency-detection.yaml"
  ],
  "outputFormat": "summary"
}
```

### Example Response (Summary)

```
=== Dependency Analysis Report ===

Total Missions: 5
Analysis Time: 32ms
Valid: Yes
Is DAG: Yes
Has Cycles: No

Execution Order (Topological Sort):
  1. B4.1 (Token Optimization)
  2. B4.3 (Dependency Detection)
  3. B4.4 (Quality Scoring)
  4. B4.2 (Mission Splitting)
  5. B4.5 (Integration & Documentation)
```

### Example Response (Mermaid)

```
graph TD
  B4_1[B4.1: Token Optimization]
  B4_2[B4.2: Mission Splitting]
  B4_3[B4.3: Dependency Detection]
  B4_4[B4.4: Quality Scoring]
  B4_5[B4.5: Integration & Documentation]

  B4_1 --> B4_2
  B4_1 --> B4_5
  B4_2 --> B4_5
  B4_3 --> B4_5
  B4_4 --> B4_5
```

### Dependency Detection Methods

1. **Explicit Dependencies**: Declared in `dependencies` field
2. **Semantic Dependencies**: Inferred from context and deliverables
3. **File-based Dependencies**: Detected through deliverable paths

---

## Tool: `create_mission_splits` (alias `split_mission`)

Automatically split complex mission into multiple sub-missions using semantic analysis.

### MCP Tool Definition

```json
{
  "name": "split_mission",
  "description": "Autonomously split oversized mission into coherent sub-missions using hybrid semantic-structural decomposition. Analyzes complexity, identifies natural boundaries, generates individual sub-mission files with proper dependencies.",
  "inputSchema": {
    "type": "object",
    "required": ["missionFile", "outputDir", "numSubmissions"],
    "properties": {
      "missionFile": {
        "type": "string",
        "description": "Path to mission YAML file to split"
      },
      "outputDir": {
        "type": "string",
        "description": "Directory for generated sub-mission files"
      },
      "numSubmissions": {
        "type": "number",
        "description": "Number of sub-missions to create",
        "minimum": 2,
        "maximum": 10
      },
      "splitStrategy": {
        "type": "string",
        "enum": ["semantic", "balanced", "sequential"],
        "description": "Splitting strategy (default: semantic)",
        "default": "semantic"
      },
      "model": {
        "type": "string",
        "enum": ["claude", "gpt", "gemini"],
        "description": "Target model for token optimization"
      }
    }
  }
}
```

### TypeScript API

```typescript
import { executeSplitMissionTool } from './tools/split-mission';

interface SplitMissionParams {
  missionFile: string;
  outputDir: string;
  numSubmissions: number;
  splitStrategy?: 'semantic' | 'balanced' | 'sequential';
  model?: 'claude' | 'gpt' | 'gemini';
}

interface SplitMissionResult {
  success: boolean;
  submissionCount?: number;
  submissionPaths?: string[];
  executionPlan?: string;
  errors?: string[];
}

const result = await executeSplitMissionTool(params: SplitMissionParams): Promise<SplitMissionResult>
```

### Example Request

```json
{
  "missionFile": "missions/complex-auth.yaml",
  "outputDir": "missions/sprint-05",
  "numSubmissions": 3,
  "splitStrategy": "semantic"
}
```

### Example Response

```json
{
  "success": true,
  "submissionCount": 3,
  "submissionPaths": [
    "missions/sprint-05/complex-auth_submission_1.yaml",
    "missions/sprint-05/complex-auth_submission_2.yaml",
    "missions/sprint-05/complex-auth_submission_3.yaml"
  ],
  "executionPlan": "Execute in sequence: submission_1 (OAuth setup) → submission_2 (Session management) → submission_3 (Security audit)"
}
```

---

## Tool: `get_split_suggestions` (alias `suggest_splits`)

Get recommendations for whether and how to split a complex mission.

### MCP Tool Definition

```json
{
  "name": "suggest_splits",
  "description": "Analyze mission complexity and suggest optimal split strategy. Returns recommendations with rationale, proposed number of splits, and complexity metrics.",
  "inputSchema": {
    "type": "object",
    "required": ["missionFile"],
    "properties": {
      "missionFile": {
        "type": "string",
        "description": "Path to mission YAML file to analyze"
      },
      "maxComplexity": {
        "type": "number",
        "description": "Maximum acceptable complexity (default: 10)",
        "default": 10
      },
      "minSubmissionSize": {
        "type": "number",
        "description": "Minimum sub-missions to suggest (default: 2)",
        "default": 2
      }
    }
  }
}
```

### TypeScript API

```typescript
import { executeSuggestSplitsTool } from './tools/split-mission';

interface SuggestSplitsParams {
  missionFile: string;
  maxComplexity?: number;
  minSubmissionSize?: number;
}

interface SuggestSplitsResult {
  success: boolean;
  shouldSplit: boolean;
  complexity?: number;
  suggestions?: Array<{
    reason: string;
    proposedSplits: number;
    strategy: string;
  }>;
  error?: string;
}

const result = await executeSuggestSplitsTool(params: SuggestSplitsParams): Promise<SuggestSplitsResult>
```

### Example Request

```json
{
  "missionFile": "missions/large-refactor.yaml",
  "maxComplexity": 10
}
```

### Example Response

```json
{
  "success": true,
  "shouldSplit": true,
  "complexity": 15,
  "suggestions": [
    {
      "reason": "Mission complexity (15) exceeds threshold (10)",
      "proposedSplits": 3,
      "strategy": "semantic"
    }
  ]
}
```

---

## Common Patterns

### Sequential Quality → Optimize → Score

```typescript
// 1. Score initial quality
const initialQuality = await scoreQuality({
  missionFile: 'mission.yaml',
  verbose: true,
});

// 2. Optimize if quality is acceptable
if (initialQuality.score!.total > 0.7) {
  await handleOptimizeTokens({
    missionFile: 'mission.yaml',
    targetModel: 'claude',
    compressionLevel: 'balanced',
    dryRun: false,
  });

  // 3. Re-score after optimization
  const finalQuality = await scoreQuality({
    missionFile: 'mission.yaml',
    verbose: false,
  });

  console.log(`Quality delta: ${finalQuality.score!.total - initialQuality.score!.total}`);
}
```

### Dependency-Aware Sprint Execution

```typescript
// 1. Analyze dependencies
const analysis = await executeAnalyzeDependenciesTool({
  missionDirectory: 'missions/sprint-04',
  outputFormat: 'summary',
});

// 2. Extract execution order
const executionOrder = parseTopologicalSort(analysis);

// 3. Execute in order
for (const missionId of executionOrder) {
  console.log(`Executing ${missionId}...`);
  // Execute mission
}
```

### Complexity-Based Splitting

```typescript
// 1. Check if split needed
const suggestions = await executeSuggestSplitsTool({
  missionFile: 'mission.yaml',
  maxComplexity: 10,
});

// 2. Split if recommended
if (suggestions.shouldSplit) {
  const split = await executeSplitMissionTool({
    missionFile: 'mission.yaml',
    outputDir: 'missions/sprint',
    numSubmissions: suggestions.suggestions![0].proposedSplits,
    splitStrategy: 'semantic',
  });

  console.log(`Split into ${split.submissionCount} missions`);
}
```

---

## Performance Characteristics

| Operation                                                | Time Complexity | Space Complexity | Typical Latency |
| -------------------------------------------------------- | --------------- | ---------------- | --------------- |
| `get_mission_quality_score` (alias `score_quality`)      | O(n)            | O(n)             | 5-15ms          |
| `update_token_optimization` (alias `optimize_tokens`)    | O(n)            | O(n)             | 20-50ms         |
| `get_dependency_analysis` (alias `analyze_dependencies`) | O(n² + e)       | O(n + e)         | 10-40ms         |
| `create_mission_splits` (alias `split_mission`)          | O(n·m)          | O(n·m)           | 30-80ms         |
| `get_split_suggestions` (alias `suggest_splits`)         | O(n)            | O(n)             | 15-35ms         |

Where:

- n = mission content size (tokens)
- e = number of dependency edges
- m = number of sub-missions

---

## Error Codes

| Code                  | Message                      | Resolution                       |
| --------------------- | ---------------------------- | -------------------------------- |
| `MISSION_NOT_FOUND`   | Mission file not found       | Verify file path                 |
| `INVALID_YAML`        | Invalid YAML format          | Check YAML syntax                |
| `CIRCULAR_DEPENDENCY` | Circular dependency detected | Restructure mission dependencies |
| `COMPLEXITY_TOO_LOW`  | Mission too simple to split  | Execute as single mission        |
| `OPTIMIZATION_FAILED` | Token optimization failed    | Try conservative compression     |

---

## TypeScript Type Definitions

```typescript
// Shared types across all tools
type SupportedModel = 'claude' | 'gpt' | 'gemini';
type CompressionLevel = 'conservative' | 'balanced' | 'aggressive';
type OutputFormat = 'summary' | 'detailed' | 'mermaid';
type SplitStrategy = 'semantic' | 'balanced' | 'sequential';

// Quality scoring types
interface QualityMetrics {
  clarity: ClarityMetrics;
  completeness: CompletenessMetrics;
  aiReadiness: AIReadinessMetrics;
}

interface ClarityMetrics {
  fleschKincaidGrade: number;
  lexicalDensity: number;
  lexicalAmbiguity: number;
  syntacticAmbiguity: number;
  referentialAmbiguity: number;
  missionComplexity: number;
}

interface CompletenessMetrics {
  structuralCompleteness: number;
  informationBreadth: number;
  informationDensity: number;
  semanticCoverage: number;
}

interface AIReadinessMetrics {
  syntacticValidity: number;
  instructionSpecificity: number;
  lintingScore: number;
}

// Dependency analysis types
interface DependencyGraph {
  nodes: Map<string, MissionNode>;
  edges: Map<string, string[]>;
  isDAG: boolean;
  hasCycles: boolean;
}

interface MissionNode {
  id: string;
  name: string;
  dependencies: string[];
  dependents: string[];
}
```

---

## Testing

All Intelligence Layer tools include comprehensive test suites:

```bash
# Run Phase 4 integration tests
npm test -- tests/integration/phase4-intelligence-flow.test.ts

# Run individual tool tests
npm test -- tests/tools/score-quality.test.ts
npm test -- tests/tools/optimize-tokens.test.ts
npm test -- tests/tools/analyze-dependencies.test.ts
npm test -- tests/tools/split-mission.test.ts

# Run intelligence layer unit tests
npm test -- tests/intelligence/
npm test -- tests/quality/
```

---

## Version History

### v2.0 (Phase 4) - Intelligence Layer

- Added `get_mission_quality_score` (alias `score_quality`) tool with 3D quality framework
- Added `update_token_optimization` (alias `optimize_tokens`) tool with 4-pass compression
- Added `get_dependency_analysis` (alias `analyze_dependencies`) tool with semantic detection
- Added `create_mission_splits` (alias `split_mission`) and `get_split_suggestions` (alias `suggest_splits`) tools
- Performance benchmarks: <100ms quality scoring, <200ms optimization

### v1.5 (Phase 3) - Extension System

- Template extraction, import/export
- Pack combination
- Version management

### v1.0 (Phases 1-2) - Foundation

- MCP server infrastructure
- Domain pack system
- Mission creation and validation

---

_Phase 4 API Documentation - Mission Protocol v2.0_
_Generated with [Claude Code](https://claude.com/claude-code)_
