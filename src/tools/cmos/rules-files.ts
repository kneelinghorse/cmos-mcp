// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m12 — the rules files init writes: one AGENTS.md (universal rules, learned practices, one CMOS
// ABOUTME: line naming the level and any opt-out) and a CLAUDE.md that imports it. Both init paths use this.

/**
 * ONE INIT, ONE OUTPUT (design doc cmos/planning/s93-the-loop-runs-itself-build.md, m12 fork 1).
 * `cmos_project(action="init")` and `cmos-mcp init` write the same AGENTS.md from
 * cmos-seed/templates/AGENTS.md. CMOS procedure stays out of it: the method arrives through the
 * server instructions, the hooks and the tier guides, and the file carries exactly one CMOS line,
 * which names the level and how to turn the hooks off. Only `cmos-mcp init --no-hooks`, for a
 * harness without hooks, appends the labelled hook-less block (templates/AGENTS-no-hooks.md).
 *
 * The CLAUDE.md init writes imports the agents file (`@AGENTS.md`): with a CLAUDE.md present,
 * Claude Code loads AGENTS.md only through that import (probe, 2026-10-08), and the import loads
 * it once. It names no tool prefix, which depends on what each user calls the server.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The agents file's name at a project root: uppercase, the cross-agent convention. */
export const AGENTS_FILE_NAME = 'AGENTS.md';

/**
 * s92-m06: the agents file already at a project root, in whatever case it was written, or null.
 * It reads a directory listing, so a case-sensitive and a case-insensitive filesystem give the same
 * answer, and it looks only at the project root, never at the CMOS layout beneath it.
 */
export function findAgentsFile(projectRoot: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(projectRoot);
  } catch {
    return null;
  }
  return names.find((name) => name.toLowerCase() === AGENTS_FILE_NAME.toLowerCase()) ?? null;
}

/** The three levels of record a project keeps (decision #1185), as the init question offers them. */
export type ProjectLevel = 'ledger' | 'planner' | 'builder';

export const PROJECT_LEVELS: readonly ProjectLevel[] = ['ledger', 'planner', 'builder'];

/** The tier each level is stored as (metadata.project_type; the tier guides in cmos-seed/tiers). */
export const LEVEL_TIERS: Readonly<Record<ProjectLevel, 'general' | 'managed' | 'build'>> = {
  ledger: 'general',
  planner: 'managed',
  builder: 'build',
};

/** A stored tier's level; an unknown tier reads as Builder, as onboard reads a missing one. */
export function levelOfTier(tier: string | null | undefined): ProjectLevel {
  if (tier === 'general') return 'ledger';
  if (tier === 'managed') return 'planner';
  return 'builder';
}

/**
 * The one question init asks, in prose. No answer means Ledger, unless the folder's agents file
 * already names a level in its CMOS line, which init keeps. The init skill (s93-m02) asks it;
 * `cmos-mcp init --level` takes the answer.
 */
export const LEVEL_QUESTION =
  'Should CMOS keep just the decisions and lessons for this project, also a list of next steps, or ' +
  'full sprints and missions?';

const LEVEL_NAMES: Readonly<Record<ProjectLevel, string>> = {
  ledger: 'Ledger',
  planner: 'Planner',
  builder: 'Builder',
};

const LEVEL_KEEPS: Readonly<Record<ProjectLevel, string>> = {
  ledger: 'decisions and lessons',
  planner: 'decisions, lessons and next steps, as tasks in cycles',
  builder: 'decisions, lessons, sprints and missions',
};

/** A level's name as the CMOS line and the init question say it. */
export function levelName(level: ProjectLevel): string {
  return LEVEL_NAMES[level];
}

/** How present the hooks are; the CMOS line names any opt-out (#1183). */
export type RulesAmbient = 'on' | 'off' | 'digest-off';

/** The metadata key a project's ambient setting is stored under (`cmos-mcp ambient`). */
export const AMBIENT_METADATA_KEY = 'ambient';

/** A stored ambient setting as the CMOS line reads it; anything else is on. */
export function asRulesAmbient(value: string | null | undefined): RulesAmbient {
  const v = value?.trim().toLowerCase();
  return v === 'off' || v === 'digest-off' ? v : 'on';
}

/** Every rendering of the CMOS line starts with this, so a refresh can find and replace it. */
export const CMOS_LINE_PREFIX = "CMOS keeps this project's record at the ";

/** The one CMOS line: the level, what it keeps, and how the hooks are, or how to turn them off. */
export function cmosRulesLine(
  level: ProjectLevel,
  options: { readonly hooks: boolean; readonly ambient?: RulesAmbient } = { hooks: true }
): string {
  const head = `${CMOS_LINE_PREFIX}**${LEVEL_NAMES[level]}** level: ${LEVEL_KEEPS[level]}.`;
  if (!options.hooks) {
    return `${head} This harness runs no CMOS hooks, so the CMOS block at the end of this file stands in for them.`;
  }
  switch (options.ambient ?? 'on') {
    case 'off':
      return `${head} Its hooks are off here; \`cmos-mcp ambient on\` turns them back on.`;
    case 'digest-off':
      return `${head} Its hooks run here without the session digest; \`cmos-mcp ambient on\` restores it.`;
    default:
      return `${head} Its tools and hooks say when to use it; \`cmos-mcp ambient off\` turns the hooks off here.`;
  }
}

/**
 * The AGENTS.md init writes: the template with its CMOS line rendered for this project, and the
 * hook-less block appended when the harness has no hooks. Throws when the template has no CMOS
 * line, so a template edit that drops it fails loudly instead of shipping a file without one.
 */
export function renderAgentsMd(
  template: string,
  options: {
    readonly level: ProjectLevel;
    readonly hooks: boolean;
    readonly ambient?: RulesAmbient;
    readonly noHooksBlock?: string;
  }
): string {
  const lines = template.split('\n');
  const at = lines.findIndex((line) => line.startsWith(CMOS_LINE_PREFIX));
  if (at === -1) throw new Error('The AGENTS.md template has no CMOS line to render.');
  lines[at] = cmosRulesLine(options.level, { hooks: options.hooks, ambient: options.ambient });
  const rendered = lines.join('\n');
  if (options.hooks) return rendered;
  if (!options.noHooksBlock) throw new Error('A hook-less AGENTS.md needs the hook-less block.');
  return `${rendered.trimEnd()}\n\n${options.noHooksBlock.trim()}\n`;
}

/** The CLAUDE.md init writes, importing the agents file under the name it has at the root. */
export function renderClaudeMd(template: string, agentsFileName: string): string {
  return template.split('AGENTS.md').join(agentsFileName);
}

interface CmosLineState {
  readonly level: ProjectLevel;
  readonly hooks: boolean;
  readonly ambient: RulesAmbient;
}

/** Every line CMOS can render, mapped to what it says: the only lines a refresh rewrites. */
const RENDERED_LINES: ReadonlyMap<string, CmosLineState> = new Map(
  PROJECT_LEVELS.flatMap(
    (level): Array<[string, CmosLineState]> => [
      ...(['on', 'off', 'digest-off'] as const).map((ambient): [string, CmosLineState] => [
        cmosRulesLine(level, { hooks: true, ambient }),
        { level, hooks: true, ambient },
      ]),
      [cmosRulesLine(level, { hooks: false }), { level, hooks: false, ambient: 'on' }],
    ]
  )
);

/** What a project's agents file's CMOS line says, read back from the line itself. */
export interface CmosLineReading {
  /** The agents file's name at the project root. */
  readonly name: string;
  /** Whether the line is exactly one of CMOS's renderings (otherwise it was edited by hand). */
  readonly rendered: boolean;
  /** The level the line names in bold, or null when an edit removed it. */
  readonly level: ProjectLevel | null;
  readonly hooks: boolean;
  readonly ambient: RulesAmbient;
}

/** The line's state as read from its words: a hand-edited line keeps the phrases it was rendered with. */
function stateOfText(text: string): Omit<CmosLineReading, 'name' | 'rendered'> {
  const named = /\*\*(Ledger|Planner|Builder)\*\* level/.exec(text);
  return {
    level: named ? (PROJECT_LEVELS.find((key) => LEVEL_NAMES[key] === named[1]) ?? null) : null,
    hooks: !text.includes('runs no CMOS hooks'),
    ambient: text.includes('hooks are off here')
      ? 'off'
      : text.includes('without the session digest')
        ? 'digest-off'
        : 'on',
  };
}

/**
 * What a project's agents file's CMOS line says, or null when there is no agents file or no line
 * starting with {@link CMOS_LINE_PREFIX}. A store recreated beside the file takes its level and
 * hooks setting back from here (s93-m12). Never throws.
 */
export function readCmosLine(projectRoot: string): CmosLineReading | null {
  try {
    const name = findAgentsFile(projectRoot);
    if (!name) return null;
    const line = fs
      .readFileSync(path.join(projectRoot, name), 'utf8')
      .split('\n')
      .find((candidate) => candidate.startsWith(CMOS_LINE_PREFIX));
    if (line === undefined) return null;
    const text = line.replace(/\r$/, '');
    const rendered = RENDERED_LINES.get(text);
    return rendered
      ? { name, rendered: true, ...rendered }
      : { name, rendered: false, ...stateOfText(text) };
  } catch {
    return null;
  }
}

/** What {@link refreshCmosLine} did. */
export interface CmosLineRefresh {
  readonly name: string;
  /**
   * rewritten: the line now says `line`. unchanged: it already said what the project is. left:
   * CMOS could not rewrite it (`why`), and `line` is what it would say.
   */
  readonly outcome: 'rewritten' | 'unchanged' | 'left';
  readonly line: string;
  readonly why?: 'edited by hand' | 'read-only' | 'not writable';
  /** What changed, for the message: the level, the hooks' state, or both. */
  readonly changed: { readonly level?: ProjectLevel; readonly ambient?: RulesAmbient };
}

/**
 * Re-render the CMOS line of a project's agents file in place after its level or its hooks'
 * presence changed (cmos_project update, init with a level, `cmos-mcp ambient`), so the one line
 * never says what the project no longer is (the m12 critics). Only a line exactly as CMOS rendered
 * it is rewritten: a line the project edited, or a file the user made read-only, is left as it is
 * and reported as left, with the line it would now read, so the caller can say what it left
 * undone. A rules file without the line is the project's own: null, nothing said. The file keeps
 * its line endings and its mode, and a symlinked one is written through the link; the new text
 * replaces the file by rename, so a hard link to it keeps the old text. Never throws, and leaves no
 * temporary file behind.
 */
export function refreshCmosLine(
  projectRoot: string,
  change: { readonly level?: ProjectLevel; readonly ambient?: RulesAmbient }
): CmosLineRefresh | null {
  let name: string | null;
  let file: string;
  let lines: string[];
  try {
    name = findAgentsFile(projectRoot);
    if (!name) return null;
    file = fs.realpathSync(path.join(projectRoot, name));
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return null;
  }
  const at = lines.findIndex((line) => line.startsWith(CMOS_LINE_PREFIX));
  if (at === -1) return null;
  const eol = lines[at].endsWith('\r') ? '\r' : '';
  const text = lines[at].slice(0, lines[at].length - eol.length);
  const current = RENDERED_LINES.get(text) ?? stateOfText(text);
  const level = change.level ?? current.level ?? 'ledger';
  const ambient = change.ambient ?? current.ambient;
  const next = cmosRulesLine(level, { hooks: current.hooks, ambient });
  // A hook-less line names no hooks setting, so only its level can change.
  const changed = {
    ...(level !== current.level ? { level } : {}),
    ...(current.hooks && ambient !== current.ambient ? { ambient } : {}),
  };
  if (next === text || (Object.keys(changed).length === 0 && !RENDERED_LINES.has(text))) {
    return { name, outcome: 'unchanged', line: text, changed: {} };
  }
  if (!RENDERED_LINES.has(text)) {
    return { name, outcome: 'left', line: next, why: 'edited by hand', changed };
  }
  try {
    fs.accessSync(file, fs.constants.W_OK);
  } catch {
    return { name, outcome: 'left', line: next, why: 'read-only', changed };
  }
  lines[at] = `${next}${eol}`;
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, lines.join('\n'));
    // The mode is set after the write: a mode given at creation passes through the umask.
    fs.chmodSync(temp, fs.statSync(file).mode & 0o7777);
    fs.renameSync(temp, file);
  } catch {
    fs.rmSync(temp, { force: true });
    return { name, outcome: 'left', line: next, why: 'not writable', changed };
  }
  return { name, outcome: 'rewritten', line: next, changed };
}

/** The sentence a caller adds to its answer for a refresh that changed or left something; else null. */
export function describeCmosLineRefresh(refresh: CmosLineRefresh | null): string | null {
  if (!refresh || refresh.outcome === 'unchanged') return null;
  const parts = [
    ...(refresh.changed.level ? [`names the ${levelName(refresh.changed.level)} level`] : []),
    ...(refresh.changed.ambient
      ? [
          refresh.changed.ambient === 'off'
            ? 'says the hooks are off'
            : refresh.changed.ambient === 'digest-off'
              ? 'says the hooks run without the session digest'
              : 'says the hooks are on',
        ]
      : []),
  ];
  const what = parts.length > 0 ? parts.join(' and ') : 'matches the project';
  return refresh.outcome === 'rewritten'
    ? `${refresh.name}'s CMOS line now ${what}.`
    : `${refresh.name}'s CMOS line was ${refresh.why}, so CMOS left it; for this project it would read: ${refresh.line}`;
}
