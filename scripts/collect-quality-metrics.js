#!/usr/bin/env node

/**
 * Collect lightweight complexity metrics for the TypeScript codebase.
 * Outputs a JSON report and prints a concise summary for CI visibility.
 */

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

function readTsConfig(projectRoot) {
  const configPath = path.resolve(projectRoot, 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      ts.formatDiagnostic(configFile.error, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => projectRoot,
        getNewLine: () => ts.sys.newLine,
      })
    );
  }

  return ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    projectRoot,
    undefined,
    configPath
  );
}

function collectFileMetrics(sourceFile) {
  const text = sourceFile.getFullText();
  const lines = text.split(/\r?\n/);
  const logicalLines = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('//');
  }).length;

  let functions = 0;
  let classes = 0;
  let decisionPoints = 0;

  function walk(node) {
    switch (node.kind) {
      case ts.SyntaxKind.FunctionDeclaration:
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.ArrowFunction:
      case ts.SyntaxKind.MethodDeclaration:
      case ts.SyntaxKind.Constructor:
        functions += 1;
        break;
      case ts.SyntaxKind.ClassDeclaration:
        classes += 1;
        break;
      default:
        break;
    }

    if (
      node.kind === ts.SyntaxKind.IfStatement ||
      node.kind === ts.SyntaxKind.ConditionalExpression ||
      node.kind === ts.SyntaxKind.ForStatement ||
      node.kind === ts.SyntaxKind.ForInStatement ||
      node.kind === ts.SyntaxKind.ForOfStatement ||
      node.kind === ts.SyntaxKind.WhileStatement ||
      node.kind === ts.SyntaxKind.DoStatement ||
      node.kind === ts.SyntaxKind.CaseClause ||
      node.kind === ts.SyntaxKind.CatchClause ||
      (node.kind === ts.SyntaxKind.BinaryExpression &&
        (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          node.operatorToken.kind === ts.SyntaxKind.BarBarToken))
    ) {
      decisionPoints += 1;
    }

    ts.forEachChild(node, walk);
  }

  walk(sourceFile);

  const decisionsPerFunction = functions === 0 ? decisionPoints : decisionPoints / functions;

  return {
    logicalLines,
    functions,
    classes,
    decisionPoints,
    decisionsPerFunction: Number(decisionsPerFunction.toFixed(2)),
  };
}

function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const parsedConfig = readTsConfig(projectRoot);

  const program = ts.createProgram({
    rootNames: parsedConfig.fileNames,
    options: parsedConfig.options,
  });

  const metrics = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) {
      continue;
    }
    if (!sourceFile.fileName.startsWith(path.join(projectRoot, 'src'))) {
      continue;
    }

    const fileMetrics = collectFileMetrics(sourceFile);
    metrics.push({
      file: path.relative(projectRoot, sourceFile.fileName),
      ...fileMetrics,
    });
  }

  metrics.sort((a, b) => b.decisionPoints - a.decisionPoints);

  const totals = metrics.reduce(
    (acc, item) => {
      acc.files += 1;
      acc.logicalLines += item.logicalLines;
      acc.functions += item.functions;
      acc.classes += item.classes;
      acc.decisionPoints += item.decisionPoints;
      return acc;
    },
    { files: 0, logicalLines: 0, functions: 0, classes: 0, decisionPoints: 0 }
  );

  const summary = {
    filesAnalyzed: totals.files,
    totalLogicalLines: totals.logicalLines,
    totalFunctions: totals.functions,
    totalClasses: totals.classes,
    totalDecisionPoints: totals.decisionPoints,
    averageDecisionsPerFunction: totals.functions
      ? Number((totals.decisionPoints / totals.functions).toFixed(2))
      : 0,
    topComplexFiles: metrics.slice(0, 5),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    summary,
    files: metrics,
  };

  const outputDir = path.join(projectRoot, 'artifacts', 'quality-metrics');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'latest.json');
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  // Human-readable summary for CI logs
  console.log('=== Quality Metrics Summary ===');
  console.log(`Files analyzed: ${summary.filesAnalyzed}`);
  console.log(`Total logical LOC: ${summary.totalLogicalLines}`);
  console.log(`Total functions: ${summary.totalFunctions}`);
  console.log(`Total decision points: ${summary.totalDecisionPoints}`);
  console.log(`Avg decisions per function: ${summary.averageDecisionsPerFunction}`);

  if (summary.topComplexFiles.length > 0) {
    console.log('\nTop complex files:');
    summary.topComplexFiles.forEach((item, index) => {
      console.log(
        `  ${index + 1}. ${item.file} (decisions: ${item.decisionPoints}, ` +
          `functions: ${item.functions}, decisions/function: ${item.decisionsPerFunction})`
      );
    });
  }

  console.log(`\nDetailed report written to ${path.relative(projectRoot, outputPath)}`);
}

main();
