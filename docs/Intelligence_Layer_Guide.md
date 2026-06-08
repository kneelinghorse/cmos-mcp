# Intelligence Layer User Guide

## Overview

The Intelligence Layer (Phase 4) adds AI-driven capabilities to Mission Protocol v2, enabling autonomous mission analysis, optimization, and quality management. This guide demonstrates how to use these features to improve mission quality and execution efficiency.

## Quick Start

The Intelligence Layer provides five key MCP tools:

1. **`update_token_optimization` (alias `optimize_tokens`)** - Reduce mission token usage while preserving semantics
2. **`get_dependency_analysis` (alias `analyze_dependencies`)** - Detect and visualize mission dependencies
3. **`create_mission_splits` (alias `split_mission`)** - Automatically split complex missions
4. **`get_split_suggestions` (alias `suggest_splits`)** - Get recommendations for mission splitting
5. **`get_mission_quality_score` (alias `score_quality`)** - Assess mission quality across three dimensions

### Example Workflow

```bash
# 1. Check quality of your mission
score_quality --missionFile=missions/current.yaml --verbose

# 2. Optimize tokens if needed
optimize_tokens --missionFile=missions/current.yaml --targetModel=claude --compressionLevel=balanced

# 3. Analyze dependencies across sprint
analyze_dependencies --missionDirectory=missions/sprint-04 --outputFormat=detailed

# 4. Get splitting suggestions for complex missions
suggest_splits --missionFile=missions/complex-feature.yaml --maxComplexity=10
```

---

## Tool 1: Quality Scoring (`get_mission_quality_score` (alias `score_quality`))

**Purpose**: Assess mission quality using a three-dimensional framework: Clarity, Completeness, and AI-Readiness.

### Basic Usage

```typescript
const result = await scoreQuality({
  missionFile: 'missions/sprint-04/B4.1_token-optimization.yaml',
  verbose: true,
});

console.log(result.summary);
```

### Output Example

```
=== Mission Quality Assessment ===

Overall Quality Score: 82.4% (B+ (Good))

Dimensional Scores:
  Clarity:      85.3%
  Completeness: 91.2%
  AI-Readiness: 88.7%

Processing Time: 15ms

Improvement Suggestions:

  IMPORTANT:
    1. Success criteria could be more specific. Add measurable targets.
    2. Consider adding performance benchmarks to validation protocol.

  INFO:
    1. Mission complexity is moderate (MCC: 10). Well-structured.
```

### Quality Score Interpretation

| Score Range | Grade | Meaning                                 |
| ----------- | ----- | --------------------------------------- |
| 90-100%     | A     | Excellent - Ready for execution         |
| 80-89%      | B     | Good - Minor improvements suggested     |
| 70-79%      | C     | Acceptable - Some revisions recommended |
| 60-69%      | D     | Fair - Significant improvements needed  |
| < 60%       | F     | Poor - Requires major revision          |

### Parameters

- `missionFile` (required): Path to mission YAML file
- `verbose` (optional): Show detailed metrics and suggestions

### Use Cases

**Before Starting a Mission**

```typescript
// Validate mission quality before execution
const quality = await scoreQuality({
  missionFile: 'missions/current.yaml',
  verbose: true,
});

if (quality.score!.total < 0.7) {
  console.log('⚠️  Mission quality below threshold. Review suggestions:');
  quality.score!.suggestions.forEach((s) => console.log(`  - ${s.message}`));
}
```

**During Mission Planning**

```typescript
// Compare quality across sprint missions
const missions = ['B4.1', 'B4.2', 'B4.3', 'B4.4', 'B4.5'];
for (const id of missions) {
  const result = await scoreQuality({
    missionFile: `missions/sprint-04/${id}_*.yaml`,
    verbose: false,
  });
  console.log(`${id}: ${(result.score!.total * 100).toFixed(1)}%`);
}
```

---

## Tool 2: Token Optimization (`update_token_optimization` (alias `optimize_tokens`))

**Purpose**: Reduce mission token count by 20-30% using model-aware compression while preserving semantic integrity.

### Basic Usage

```typescript
const result = await handleOptimizeTokens({
  missionFile: 'missions/verbose-mission.yaml',
  targetModel: 'claude',
  compressionLevel: 'balanced',
  dryRun: false,
});

console.log(`Tokens saved: ${result.stats!.originalTokens - result.stats!.compressedTokens}`);
console.log(`Reduction: ${result.stats!.reductionPercentage.toFixed(1)}%`);
```

### Compression Levels

**Conservative** (5-15% reduction)

- Minimal changes
- High semantic preservation
- Best for critical missions

**Balanced** (15-25% reduction) - **Recommended**

- Moderate compression
- Good semantic preservation
- Best for most missions

**Aggressive** (25-40% reduction)

- Maximum compression
- May use model-specific syntax
- Best for context-constrained scenarios

### Parameters

- `missionFile` (required): Path to mission YAML file
- `targetModel` (required): `claude`, `gpt`, or `gemini`
- `compressionLevel` (optional): `conservative`, `balanced`, or `aggressive`
- `dryRun` (optional): Preview changes without modifying file
- `preserveTags` (optional): YAML tags to preserve from compression

### Example: Dry Run Preview

```typescript
// Preview optimization without modifying file
const preview = await handleOptimizeTokens({
  missionFile: 'missions/important-mission.yaml',
  targetModel: 'claude',
  compressionLevel: 'balanced',
  dryRun: true,
});

console.log('Before:', preview.stats!.originalTokens, 'tokens');
console.log('After:', preview.stats!.compressedTokens, 'tokens');
console.log('Savings:', preview.stats!.reductionPercentage.toFixed(1), '%');
console.log('\nPasses applied:', preview.stats!.passesApplied.join(', '));

if (preview.warnings && preview.warnings.length > 0) {
  console.log('\n⚠️  Warnings:');
  preview.warnings.forEach((w) => console.log(`  - ${w}`));
}
```

### Use Cases

**Before Long Context Sessions**

```typescript
// Optimize mission to fit within context window
const mission = await handleOptimizeTokens({
  missionFile: 'missions/large-refactor.yaml',
  targetModel: 'claude',
  compressionLevel: 'aggressive',
  dryRun: false,
});

// Verify it fits within budget
if (mission.stats!.compressedTokens < 50000) {
  console.log('✓ Mission fits in context window');
}
```

**Batch Optimization**

```typescript
// Optimize all missions in a sprint
const sprintMissions = ['B4.1', 'B4.2', 'B4.3', 'B4.4', 'B4.5'];
for (const id of sprintMissions) {
  const path = `missions/sprint-04/${id}_*.yaml`;
  await handleOptimizeTokens({
    missionFile: path,
    targetModel: 'claude',
    compressionLevel: 'balanced',
    dryRun: false,
  });
  console.log(`✓ Optimized ${id}`);
}
```

---

## Tool 3: Dependency Analysis (`get_dependency_analysis` (alias `analyze_dependencies`))

**Purpose**: Detect implicit and explicit dependencies between missions, validate execution order, and identify circular dependencies.

### Basic Usage

```typescript
const analysis = await executeAnalyzeDependenciesTool({
  missionDirectory: 'missions/sprint-04',
  outputFormat: 'detailed',
});

console.log(analysis);
```

### Output Example

```
=== Dependency Analysis Report ===

Total Missions: 5
Analysis Time: 45ms
Valid: Yes
Is DAG: Yes
Has Cycles: No

Mission Dependencies:

  B4.1 (Token Optimization)
    └─> No dependencies

  B4.2 (Mission Splitting)
    └─> Depends on: B4.1
    └─> Semantic: Uses token optimization results

  B4.3 (Dependency Detection)
    └─> No explicit dependencies
    └─> Semantic: Independent subsystem

  B4.4 (Quality Scoring)
    └─> No explicit dependencies
    └─> Semantic: Independent subsystem

  B4.5 (Integration & Docs)
    └─> Depends on: B4.1, B4.2, B4.3, B4.4
    └─> Reason: Integration requires all components

Execution Order (Topological Sort):
  1. B4.1 (Token Optimization)
  2. B4.3 (Dependency Detection)
  3. B4.4 (Quality Scoring)
  4. B4.2 (Mission Splitting)
  5. B4.5 (Integration & Docs)
```

### Parameters

- `missionDirectory` (optional): Directory containing mission files
- `missionPaths` (optional): Explicit list of mission file paths
- `outputFormat` (optional): `summary`, `detailed`, or `mermaid`

### Use Cases

**Sprint Planning**

```typescript
// Analyze dependencies before sprint starts
const analysis = await executeAnalyzeDependenciesTool({
  missionDirectory: 'missions/sprint-05',
  outputFormat: 'detailed',
});

// Check for circular dependencies
if (analysis.includes('Has Cycles: Yes')) {
  console.error('❌ Circular dependencies detected! Review mission order.');
}
```

**Visualize Dependency Graph**

```typescript
// Generate Mermaid diagram
const graph = await executeAnalyzeDependenciesTool({
  missionDirectory: 'missions/sprint-04',
  outputFormat: 'mermaid',
});

console.log(graph);
// Copy output to Mermaid live editor or docs
```

**Validate Execution Order**

```typescript
// Get optimal execution sequence
const analysis = await executeAnalyzeDependenciesTool({
  missionPaths: [
    'missions/sprint-04/B4.1_token-optimization.yaml',
    'missions/sprint-04/B4.2_mission-splitting.yaml',
    'missions/sprint-04/B4.3_dependency-detection.yaml',
    'missions/sprint-04/B4.4_quality-scoring.yaml',
    'missions/sprint-04/B4.5_integration.yaml',
  ],
  outputFormat: 'summary',
});

// Execution order is in topological sort section
```

---

## Tool 4: Mission Splitting (`create_mission_splits` (alias `split_mission`), `get_split_suggestions` (alias `suggest_splits`))

**Purpose**: Automatically decompose complex missions into manageable sub-missions using semantic analysis.

### Step 1: Get Split Suggestions

```typescript
const suggestions = await executeSuggestSplitsTool({
  missionFile: 'missions/complex-feature.yaml',
  maxComplexity: 10,
  minSubmissionSize: 2,
});

if (suggestions.shouldSplit) {
  console.log(`Recommendation: Split into ${suggestions.suggestions[0].proposedSplits} missions`);
  console.log(`Reason: ${suggestions.suggestions[0].reason}`);
}
```

### Step 2: Execute Split

```typescript
const result = await executeSplitMissionTool({
  missionFile: 'missions/complex-feature.yaml',
  outputDir: 'missions/sprint-05',
  numSubmissions: 3,
  splitStrategy: 'semantic',
});

console.log(`Created ${result.submissionCount} sub-missions:`);
result.submissionPaths!.forEach((path, i) => {
  console.log(`  ${i + 1}. ${path}`);
});
```

### Split Strategies

**Semantic** (Recommended)

- Splits based on functional cohesion
- Preserves related deliverables together
- Best for feature-oriented missions

**Balanced**

- Even distribution of complexity
- Best for large refactoring missions

**Sequential**

- Splits into ordered sequence
- Best for multi-step workflows

### Parameters

**`get_split_suggestions` (alias `suggest_splits`):**

- `missionFile` (required): Path to mission to analyze
- `maxComplexity` (optional): Complexity threshold (default: 10)
- `minSubmissionSize` (optional): Minimum sub-missions (default: 2)

**`create_mission_splits` (alias `split_mission`):**

- `missionFile` (required): Path to mission to split
- `outputDir` (required): Directory for sub-missions
- `numSubmissions` (required): Number of sub-missions to create
- `splitStrategy` (optional): `semantic`, `balanced`, or `sequential`

### Use Cases

**Large Feature Development**

```typescript
// Mission: "Implement complete authentication system"
// Too complex for single session

const suggestions = await executeSuggestSplitsTool({
  missionFile: 'missions/auth-system.yaml',
  maxComplexity: 8,
});

if (suggestions.shouldSplit) {
  const split = await executeSplitMissionTool({
    missionFile: 'missions/auth-system.yaml',
    outputDir: 'missions/sprint-06',
    numSubmissions: suggestions.suggestions[0].proposedSplits,
    splitStrategy: 'semantic',
  });

  // Now you have: B6.1 (OAuth), B6.2 (Sessions), B6.3 (Middleware)
}
```

**Complexity Management**

```typescript
import { promises as fs } from 'fs';

// Check all missions in backlog for complexity
const backlog = await fs.readdir('missions/backlog');

for (const file of backlog) {
  const suggestions = await executeSuggestSplitsTool({
    missionFile: `missions/backlog/${file}`,
    maxComplexity: 10,
  });

  if (suggestions.shouldSplit) {
    console.log(`⚠️  ${file} should be split (complexity too high)`);
  }
}
```

---

## Complete Workflow Example

Here's how to use the Intelligence Layer for a complete sprint:

```typescript
// ============================================
// Sprint 5 Planning with Intelligence Layer
// ============================================

// Step 1: Analyze sprint dependencies
const depAnalysis = await executeAnalyzeDependenciesTool({
  missionDirectory: 'missions/sprint-05',
  outputFormat: 'detailed',
});

console.log('📊 Dependency Analysis:');
console.log(depAnalysis);

// Step 2: Check quality of all missions
console.log('\n🎯 Quality Assessment:');
const missionFiles = ['B5.1', 'B5.2', 'B5.3', 'B5.4'];
for (const id of missionFiles) {
  const quality = await scoreQuality({
    missionFile: `missions/sprint-05/${id}_*.yaml`,
    verbose: false,
  });

  const grade = quality.score!.total >= 0.8 ? '✓' : '⚠';
  console.log(`${grade} ${id}: ${(quality.score!.total * 100).toFixed(1)}%`);
}

// Step 3: Check for complex missions that need splitting
console.log('\n🔍 Complexity Analysis:');
for (const id of missionFiles) {
  const suggestions = await executeSuggestSplitsTool({
    missionFile: `missions/sprint-05/${id}_*.yaml`,
    maxComplexity: 10,
  });

  if (suggestions.shouldSplit) {
    console.log(
      `⚠️  ${id} should be split into ${suggestions.suggestions[0].proposedSplits} missions`
    );
  }
}

// Step 4: Optimize tokens for context efficiency
console.log('\n⚡ Token Optimization:');
for (const id of missionFiles) {
  const optimization = await handleOptimizeTokens({
    missionFile: `missions/sprint-05/${id}_*.yaml`,
    targetModel: 'claude',
    compressionLevel: 'balanced',
    dryRun: false,
  });

  console.log(`✓ ${id}: Saved ${optimization.stats!.reductionPercentage.toFixed(1)}% tokens`);
}

console.log('\n✅ Sprint 5 analysis complete! Ready for execution.');
```

---

## Performance Benchmarks

The Intelligence Layer is optimized for speed:

| Tool                                                     | Typical Performance | Maximum Latency |
| -------------------------------------------------------- | ------------------- | --------------- |
| `get_mission_quality_score` (alias `score_quality`)      | 5-15ms              | <100ms          |
| `update_token_optimization` (alias `optimize_tokens`)    | 20-50ms             | <200ms          |
| `get_dependency_analysis` (alias `analyze_dependencies`) | 10-40ms             | <150ms          |
| `get_split_suggestions` (alias `suggest_splits`)         | 15-35ms             | <120ms          |
| `create_mission_splits` (alias `split_mission`)          | 30-80ms             | <250ms          |

All benchmarks tested with missions of 200-1000 tokens on standard hardware.

---

## Best Practices

### 1. Quality-First Approach

Always check quality before execution:

```typescript
const quality = await scoreQuality({ missionFile: 'missions/current.yaml', verbose: true });
if (quality.score!.total < 0.75) {
  // Review and improve mission based on suggestions
}
```

### 2. Optimize Early

Optimize missions during planning, not during execution:

```typescript
// During sprint planning
for (const mission of sprintMissions) {
  await handleOptimizeTokens({
    missionFile: mission,
    targetModel: 'claude',
    compressionLevel: 'balanced',
    dryRun: false,
  });
}
```

### 3. Validate Dependencies

Always analyze dependencies before starting a sprint:

```typescript
const analysis = await executeAnalyzeDependenciesTool({
  missionDirectory: 'missions/current-sprint',
  outputFormat: 'detailed',
});

// Check for circular dependencies or missing prerequisites
```

### 4. Split Proactively

Check complexity during mission creation:

```typescript
const suggestions = await executeSuggestSplitsTool({
  missionFile: newMission,
  maxComplexity: 10,
});

if (suggestions.shouldSplit) {
  // Split before adding to sprint
}
```

---

## Troubleshooting

### Quality Score Lower Than Expected

**Cause**: Mission may lack specificity or have structural issues.

**Solution**:

```typescript
const quality = await scoreQuality({ missionFile: mission, verbose: true });
quality.score!.suggestions.forEach((s) => {
  if (s.severity === 'critical' || s.severity === 'important') {
    console.log(`Fix: ${s.message}`);
  }
});
```

### Token Optimization Increases Size

**Cause**: Model-specific transpilers may add syntax for better parsing.

**Solution**: Use `conservative` compression level or disable model-specific transpilers:

```typescript
await handleOptimizeTokens({
  missionFile: mission,
  targetModel: 'claude',
  compressionLevel: 'conservative', // Less aggressive
  dryRun: false,
});
```

### Circular Dependencies Detected

**Cause**: Missions have mutual dependencies.

**Solution**:

```typescript
const analysis = await executeAnalyzeDependenciesTool({
  missionDirectory: 'missions/sprint',
  outputFormat: 'detailed',
});

// Review dependency chain and restructure missions
```

---

## Integration with MCP

All Intelligence Layer tools are available as MCP tools in Claude Desktop:

```json
{
  "mcpServers": {
    "mission-protocol": {
      "command": "node",
      "args": ["/path/to/mission-protocol/app/dist/index.js"]
    }
  }
}
```

Then use in Claude:

```
Can you score the quality of missions/current.yaml?
Can you optimize missions/sprint-04/*.yaml for tokens?
Can you analyze dependencies in missions/sprint-04?
```

---

## Next Steps

- Read [API Documentation](API_Documentation_Phase4.md) for complete API reference
- Review [Research Foundations](../missions/research/) for implementation details
- See [Phase 3 Guide](Extension_System_Guide.md) for template management
- Check [Mission Backlog](../missions/backlog.yaml) for project status

---

_Intelligence Layer - Mission Protocol v2.0_
_Generated with [Claude Code](https://claude.com/claude-code)_
