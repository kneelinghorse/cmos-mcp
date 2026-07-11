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
import { resolveSeedPath } from './cmos-project-init';

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
 * Load a tier config for {tierName}.
 *
 * Parses YAML frontmatter for structured fields and returns the prose body as guide.
 *
 * Resolution order (s83-m05):
 *   1. `<root>/cmos/tiers/{tierName}.md`  (the store's own copied tier files)
 *   2. `<root>/cmos/tiers/build.md`       (the store's build fallback)
 *   3. `<cmos-seed>/tiers/{tierName}.md`  (bundled seed — ships with the package)
 *   4. `<cmos-seed>/tiers/build.md`       (bundled build fallback)
 *   5. null
 *
 * The bundled `cmos-seed/tiers` fallback is what makes tier config work for a
 * plain npm consumer: on auto-discovery the caller feeds the resolved store root,
 * but a store that was never seeded with `cmos/tiers` (or a bare package install,
 * where `cmos/` is not in package.json `files`) would previously resolve to null
 * and silently drop tier framing. The seed bundle is always present, so a tier
 * config is always available.
 *
 * @param tierName - 'general', 'managed', or 'build'
 * @param serverRoot - Resolved store root (defaults to __dirname/../../..)
 * @returns Parsed tier config or null if even the bundled fallback is missing
 */
export function loadTierConfig(tierName: string, serverRoot?: string): TierConfig | null {
  const root = serverRoot ?? path.resolve(__dirname, '../../..');

  const searchDirs = [path.join(root, 'cmos', 'tiers')];
  const seedRoot = resolveSeedPath();
  if (seedRoot) {
    searchDirs.push(path.join(seedRoot, 'tiers'));
  }

  const filePath = findTierFile(tierName, searchDirs);
  if (!filePath) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return parseTierFile(content);
  } catch {
    return null;
  }
}

/**
 * Find the tier markdown file across the ordered search dirs.
 *
 * Two passes so the EXACT requested tier always wins over a build.md fallback,
 * regardless of which dir holds it: pass 1 returns the first existing
 * `{tierName}.md` across all dirs (store copy first, then bundled seed); only if
 * no dir has the exact tier does pass 2 return the first `build.md`. A single
 * per-dir loop would let a partially-seeded store's build.md shadow the bundled
 * seed's exact tier — so a `managed`/`general` project could silently render
 * `build` vocabulary (s83-m05 review finding).
 */
function findTierFile(tierName: string, searchDirs: string[]): string | null {
  for (const dir of searchDirs) {
    const exact = path.join(dir, `${tierName}.md`);
    if (fs.existsSync(exact)) {
      return exact;
    }
  }
  for (const dir of searchDirs) {
    const fallback = path.join(dir, 'build.md');
    if (fs.existsSync(fallback)) {
      return fallback;
    }
  }
  return null;
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
