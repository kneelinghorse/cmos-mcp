// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Plans identifier-only edits and replaces owned text only while it remains unedited.
// ABOUTME: Document-only migration preserves real legacy paths until the record folder moves.
import * as fs from 'fs';
import * as path from 'path';
import { LEGACY } from '../intelligence/legacy-compat';
import { resolveSeedPath } from '../tools/rbook/level-files';
import {
  rbookRulesLine,
  isOwnedRulesLine,
  modernRulesText,
  renderedRulesState,
} from '../tools/rbook/rules-files';

export interface DocumentEdit {
  readonly file: string;
  readonly before: string;
  readonly after: string;
  readonly mode: number;
}
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function migrateIdentifiers(text: string, moved: boolean): string {
  let updated = text
    .replace(new RegExp(`\\b${escape(LEGACY.toolPrefix)}(?=[a-z])`, 'g'), 'rbook_')
    .replace(new RegExp(`\\b${escape(LEGACY.envPrefix)}(?=[A-Z])`, 'g'), 'RBOOK_')
    .split(LEGACY.addressScheme)
    .join('rbook://')
    .split(LEGACY.packageName)
    .join('@aquex/reasonbook')
    .replace(new RegExp(`(?<![\\w/-])${escape(LEGACY.command)}(?![\\w/-])`, 'g'), 'reasonbook');
  if (moved) {
    updated = updated
      .replace(new RegExp(`(?<![\\w.-])${escape(LEGACY.recordDirectory)}/(?!/)`, 'g'), 'rbook/')
      .replace(new RegExp(`(?<![\\w.-])${escape(LEGACY.databaseFile)}\\b`, 'g'), 'rbook.sqlite');
  }
  return updated;
}

/** Render an unedited seed against the folders that really exist, including after a new-name seed ships. */
function renderSeedPaths(text: string, moved: boolean, configDirectory?: string): string {
  const configPaths: string[] = [];
  const protectedText = text.replace(
    new RegExp(
      '(?:~/)?\\.config/(?:rbook|' + escape(LEGACY.configDirectory) + ')(?:/[^\\s`"\']*)?',
      'g'
    ),
    (value) => {
      configPaths.push(value);
      return `\uE000CONFIG_${configPaths.length - 1}\uE000`;
    }
  );
  let rendered = migrateIdentifiers(protectedText, true);
  if (!moved)
    rendered = rendered
      .replace(/(?<![\w.-])rbook\/(?!\/)/g, `${LEGACY.recordDirectory}/`)
      .replace(/(?<![\w.-])rbook\.sqlite\b/g, LEGACY.databaseFile);
  return rendered.replace(/\uE000CONFIG_(\d+)\uE000/g, (_whole, index: string) => {
    const original = configPaths[Number(index)];
    if (!configDirectory) return original;
    const suffix = original.replace(
      new RegExp(`^(?:~/)?\\.config/(?:rbook|${escape(LEGACY.configDirectory)})`),
      ''
    );
    return `${configDirectory}${suffix}`;
  });
}

function comparableSeed(text: string): string {
  return modernRulesText(migrateIdentifiers(text, true)).replace(
    new RegExp(`\\.config/(?:rbook|${escape(LEGACY.configDirectory)})`, 'g'),
    '.config/RECORD_CONFIG'
  );
}

function ownedText(text: string, left: string[]): string {
  const rendered = text
    .split('\n')
    .map((line) => {
      const eol = line.endsWith('\r') ? '\r' : '';
      const clean = line.replace(/\r$/, '');
      if (!isOwnedRulesLine(clean)) return line;
      if (renderedRulesState(clean)) return modernRulesText(clean) + eol;
      const level = /\*\*(Ledger|Planner|Builder)\*\*/.exec(clean)?.[1].toLowerCase() as
        | 'ledger'
        | 'planner'
        | 'builder'
        | undefined;
      left.push(
        `Owned line edited by hand; replacement: ${modernRulesText(rbookRulesLine(level ?? 'ledger'))}`
      );
      return line;
    })
    .join('\n');
  const seed = resolveSeedPath();
  if (!seed)
    throw new Error(
      'The package seed is missing; reinstall Reasonbook before migrating documents.'
    );
  const block = fs.readFileSync(path.join(seed, 'templates/AGENTS-no-hooks.md'), 'utf8').trim();
  const oldStart = rendered.indexOf(LEGACY.blockStart);
  if (oldStart === -1) return rendered;
  const end = rendered.indexOf(LEGACY.blockEnd, oldStart);
  if (end === -1) {
    left.push('Owned hook-less block is incomplete; left it unchanged.');
    return rendered;
  }
  const current = rendered.slice(oldStart, end + LEGACY.blockEnd.length);
  if (
    modernRulesText(current).replace(/\r\n/g, '\n') !==
    modernRulesText(block).replace(/\r\n/g, '\n')
  ) {
    left.push(`Owned hook-less block edited by hand; replacement:\n${modernRulesText(block)}`);
    return rendered;
  }
  return (
    rendered.slice(0, oldStart) +
    modernRulesText(block) +
    rendered.slice(end + LEGACY.blockEnd.length)
  );
}

/** No files are opened for writing here; previews and validation use the exact same plan. */
export function planDocumentEdits(
  root: string,
  recordDirectory: string,
  moved: boolean,
  configDirectory?: string
): { edits: DocumentEdit[]; left: string[] } {
  const files = fs
    .readdirSync(root)
    .filter((name) => /^(?:agents|claude)\.md$/i.test(name))
    .map((name) => path.join(root, name));
  if (fs.existsSync(path.join(root, '.mcp.json'))) files.push(path.join(root, '.mcp.json'));
  for (const relative of ['README.md', 'tiers/general.md', 'tiers/managed.md', 'tiers/build.md']) {
    const file = path.join(recordDirectory, relative);
    if (fs.existsSync(file)) files.push(file);
  }
  const edits: DocumentEdit[] = [];
  const left: string[] = [];
  const seed = resolveSeedPath();
  for (const file of files) {
    if (fs.lstatSync(file).isSymbolicLink())
      throw new Error(`Migration will not rewrite a symlinked document: ${file}`);
    const before = fs.readFileSync(file, 'utf8');
    let after: string;
    if (path.basename(file) === '.mcp.json') {
      const parsed = JSON.parse(before) as { mcpServers?: Record<string, unknown> };
      const servers = parsed.mcpServers;
      if (servers?.[LEGACY.command] && servers.rbook)
        throw new Error(
          `${file} has both old and rbook server entries; resolve that collision before migration.`
        );
      if (servers?.[LEGACY.command]) {
        servers.rbook = servers[LEGACY.command];
        delete servers[LEGACY.command];
      }
      after = migrateIdentifiers(JSON.stringify(parsed, null, 2) + '\n', moved);
      // Avoid formatting churn when no identifier changed.
      if (JSON.stringify(JSON.parse(before)) === JSON.stringify(JSON.parse(after))) after = before;
    } else {
      const notes: string[] = [];
      const owned = ownedText(before, notes);
      const protectedBlocks: string[] = [];
      const guarded = owned.replace(
        new RegExp(`${escape(LEGACY.blockStart)}[\\s\\S]*?${escape(LEGACY.blockEnd)}`, 'g'),
        (block) => {
          protectedBlocks.push(block);
          return `\uE000RBOOK_BLOCK_${protectedBlocks.length - 1}\uE000`;
        }
      );
      after = guarded
        .split('\n')
        .map((line) =>
          isOwnedRulesLine(line) && !renderedRulesState(line.replace(/\r$/, ''))
            ? line
            : migrateIdentifiers(line, moved)
        )
        .join('\n')
        .replace(
          /\uE000RBOOK_BLOCK_(\d+)\uE000/g,
          (_whole, index: string) => protectedBlocks[Number(index)]
        );
      const relative = path.relative(recordDirectory, file);
      if (!relative.startsWith('..') && seed) {
        const sources =
          relative === 'README.md'
            ? ['README.md', 'templates/README-ledger.md', 'templates/README-planner.md']
            : [relative];
        for (const candidate of sources) {
          const seedFile = path.join(seed, candidate);
          if (!fs.existsSync(seedFile)) continue;
          const baseline = fs.readFileSync(seedFile, 'utf8');
          if (comparableSeed(before) === comparableSeed(baseline)) {
            after = modernRulesText(renderSeedPaths(baseline, moved, configDirectory));
            break;
          }
        }
      }
      left.push(...notes.map((note) => `${file}: ${note}`));
      const residual = after
        .split('\n')
        .filter(
          (line) => new RegExp(`\\b${LEGACY.proseName}\\b`).test(line) && !isOwnedRulesLine(line)
        );
      if (residual.length)
        left.push(
          `${file}: left ${residual.length} line(s) of project-owned prose mentioning the former name.`
        );
    }
    if (after !== before)
      edits.push({ file, before, after, mode: fs.statSync(file).mode & 0o7777 });
  }
  return { edits, left };
}

export function applyDocumentEdits(edits: readonly DocumentEdit[]): string[] {
  const changed: string[] = [];
  for (const edit of edits) {
    if (fs.readFileSync(edit.file, 'utf8') !== edit.before)
      throw new Error(`${edit.file} changed after migration preview; retry to preserve that edit.`);
    const temporary = `${edit.file}.rbook-migrate-${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, edit.after, { flag: 'wx', mode: edit.mode });
      fs.chmodSync(temporary, edit.mode);
      fs.renameSync(temporary, edit.file);
      changed.push(edit.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return changed;
}
