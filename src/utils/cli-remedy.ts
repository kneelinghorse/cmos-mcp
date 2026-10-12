// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Format project-scoped CLI remedies with literal POSIX arguments and explicit target roots.
// ABOUTME: Keep unsafe display paths inert, and preserve the dispatcher’s project resolution source.

import * as path from 'path';
import type { ResolvedBy } from '../intelligence/sender-context';
import { getServerVersion } from '../server-version';
import { currentToolProjectResolution } from '../tools/rbook/tool-call-context';

export interface CliRemedyTarget {
  readonly projectRoot: string;
  readonly resolvedBy?: ResolvedBy;
}

/** A POSIX word, including the close-quote / escaped apostrophe / reopen-quote sequence. */
function quote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** The command installed by this package. */
const INSTALLED_COMMANDS = ['reasonbook'];

/** The executable the hook actually used, with paths preserved as literal POSIX words. */
export function cliCommand(argv: readonly string[] = process.argv): string {
  const script = argv[1] ?? '';
  if (INSTALLED_COMMANDS.includes(path.basename(script))) return path.basename(script);
  const word = (text: string): string => (/^[\w@%+=:,./-]+$/.test(text) ? text : quote(text));
  return `${word(argv[0] ?? 'node')} ${word(script)}`;
}

function unsafeDisplay(text: string): boolean {
  return [...text].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029 || ch === '`';
  });
}

/** JSON keeps control characters and Markdown delimiters from becoming executable-looking text. */
export function inertCliPath(text: string): string {
  return JSON.stringify(text)
    .replace(/`/g, '\\u0060')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * s99-m02: the command a remedy names when the caller cannot know how the reader runs the CLI (a
 * plugin user has no global command). The exact scoped package, because a bare `reasonbook` invites
 * `npx reasonbook`, which fetches an unrelated 2017 package.
 */
export function remedyCommand(): string {
  return `npx @aquex/reasonbook@${getServerVersion()}`;
}

/** Only a known cwd resolution can omit the root; direct handlers conservatively name theirs. */
export function formatCliRemedy(
  verb: string,
  target: CliRemedyTarget,
  command = remedyCommand()
): string {
  const root = path.resolve(target.projectRoot);
  if (unsafeDisplay(root) || unsafeDisplay(command)) {
    return `${verb} for project ${inertCliPath(root)} (no runnable remedy: the path contains a backtick or control character)`;
  }
  const context = currentToolProjectResolution();
  const source =
    target.resolvedBy ??
    (context && path.resolve(context.projectRoot) === root ? context.resolvedBy : 'explicit');
  const scope = source === 'cwd' ? '' : ` --project-root ${quote(root)}`;
  return `\`${command} ${verb}${scope}\` (POSIX shell)`;
}
