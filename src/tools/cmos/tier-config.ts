/**
 * Tier Config Loader
 *
 * Reads and parses tier configuration files from cmos/tiers/{tierName}.md.
 * Returns structured frontmatter + prose body for injection into onboard payload.
 *
 * @module tools/cmos/tier-config
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

export interface TierConfig {
  tier: string;
  label: string;
  description: string;
  toolsUse: string[];
  toolsSkip: string[];
  vocabulary: Record<string, string | null>;
  sessionTypes: string[];
  onboardFieldsShow: string[];
  onboardFieldsHide: string[];
  guide: string;
}

/**
 * Load a tier config from cmos/tiers/{tierName}.md.
 *
 * Parses YAML frontmatter for structured fields and returns the prose body as guide.
 * Falls back to build.md if the requested tier file doesn't exist.
 *
 * @param tierName - 'general', 'managed', or 'build'
 * @param serverRoot - Root directory of the server (defaults to __dirname/../../..)
 * @returns Parsed tier config or null if even fallback fails
 */
export function loadTierConfig(tierName: string, serverRoot?: string): TierConfig | null {
  const root = serverRoot ?? path.resolve(__dirname, '../../..');
  const tiersDir = path.join(root, 'cmos', 'tiers');

  let filePath = path.join(tiersDir, `${tierName}.md`);

  // Fall back to build.md if requested file doesn't exist
  if (!fs.existsSync(filePath)) {
    filePath = path.join(tiersDir, 'build.md');
    if (!fs.existsSync(filePath)) {
      return null;
    }
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return parseTierFile(content);
  } catch {
    return null;
  }
}

/**
 * Parse a tier config file with YAML frontmatter.
 */
function parseTierFile(content: string): TierConfig {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!frontmatterMatch) {
    return {
      tier: 'build',
      label: 'Build',
      description: '',
      toolsUse: [],
      toolsSkip: [],
      vocabulary: {},
      sessionTypes: [],
      onboardFieldsShow: [],
      onboardFieldsHide: [],
      guide: content.trim(),
    };
  }

  const yamlStr = frontmatterMatch[1];
  const prose = frontmatterMatch[2].trim();
  const fm = parseYaml(yamlStr) as Record<string, unknown>;

  // Normalize vocabulary: YAML null (~) stays null, strings pass through
  const rawVocab = (fm.vocabulary ?? {}) as Record<string, unknown>;
  const vocabulary: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(rawVocab)) {
    vocabulary[key] = value == null ? null : String(value);
  }

  return {
    tier: String(fm.tier ?? 'build'),
    label: String(fm.label ?? 'Build'),
    description: String(fm.description ?? ''),
    toolsUse: toStringArray(fm.tools_use),
    toolsSkip: toStringArray(fm.tools_skip),
    vocabulary,
    sessionTypes: toStringArray(fm.session_types),
    onboardFieldsShow: toStringArray(fm.onboard_fields_show),
    onboardFieldsHide: toStringArray(fm.onboard_fields_hide),
    guide: prose,
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String);
}
