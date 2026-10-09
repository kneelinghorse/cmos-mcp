// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Scan local harness rules with the same published prompting patterns as the hook.
// ABOUTME: Exempt only an exact generated CMOS pointer; disclose unreadable or untraversed rule sources.

import * as fs from 'fs';
import * as path from 'path';
import { matchPrompt } from './prompt-patterns';
import { cmosRulesLine, PROJECT_LEVELS } from './rules-files';

export const RULE_SCAN_SCOPE =
  'AGENTS.md and CLAUDE.md at every depth, .cursorrules, .claude/rules Markdown, .cursor/rules Markdown/MDC, and .github instruction Markdown. Excludes .git and node_modules; symlinked directories are disclosed but not traversed. Imported external files and other harness-specific filenames require review.';
const POINTERS = new Set(
  PROJECT_LEVELS.flatMap((level) => [
    cmosRulesLine(level, { hooks: false }),
    ...(['on', 'off', 'digest-off'] as const).map((ambient) =>
      cmosRulesLine(level, { hooks: true, ambient })
    ),
  ])
);

export interface RulesStatistics {
  files: number;
  matchingFiles: number;
  matchingLines: number;
  hits: Array<{ path: string; patternIds: string[] }>;
  warnings: string[];
}

/** Scan file contents read-only. File paths stay in the human report, never the exported counts. */
export function rulesStatistics(root: string): RulesStatistics {
  const result: RulesStatistics = {
    files: 0,
    matchingFiles: 0,
    matchingLines: 0,
    hits: [],
    warnings: [],
  };
  const isRules = (relative: string): boolean => {
    const name = path.basename(relative).toLowerCase();
    return (
      name === 'agents.md' ||
      name === 'claude.md' ||
      name === '.cursorrules' ||
      /(?:^|\/)\.claude\/rules\/.*\.md$/i.test(relative) ||
      /(?:^|\/)\.cursor\/rules\/.*\.(?:md|mdc)$/i.test(relative) ||
      /(?:^|\/)\.github\/(?:copilot-instructions\.md|instructions\/.*\.instructions\.md)$/i.test(
        relative
      )
    );
  };
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      result.warnings.push(`Rules directory unreadable: ${dir}`);
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const file = path.join(dir, entry.name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (entry.isSymbolicLink()) {
        try {
          if (fs.statSync(file).isDirectory()) {
            result.warnings.push(`Symlinked rules directory not traversed: ${file}`);
            continue;
          }
        } catch {
          result.warnings.push(`Unreadable symlink in rules scan: ${file}`);
          continue;
        }
      }
      if (!isRules(relative)) continue;
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
          throw new Error('Not a bounded regular rules file');
        result.files++;
        let pointerRemoved = false;
        const lines = fs
          .readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .map((line) => {
            if (!pointerRemoved && POINTERS.has(line)) {
              pointerRemoved = true;
              return '';
            }
            return line;
          });
        const patterns = matchPrompt(lines.join('\n')).procedurePatternIds;
        if (patterns.length) {
          result.matchingFiles++;
          result.matchingLines += lines.filter(
            (line) => matchPrompt(line).procedurePatternIds.length > 0
          ).length;
          result.hits.push({ path: file, patternIds: [...patterns] });
        }
      } catch {
        result.warnings.push(`Rules file unreadable or too large: ${file}`);
      }
    }
  };
  walk(root);
  return result;
}
