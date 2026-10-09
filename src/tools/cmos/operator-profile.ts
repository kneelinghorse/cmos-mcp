// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m12 — the operator profile: how the operator likes to work, one file outside every repository,
// ABOUTME: read into every project's session-start digest. Agents change it only through an approved draft.

import * as fs from 'fs';
import * as path from 'path';

import { cmosConfigDir } from './harness-session';

/**
 * WHY ONE FILE (decision #1183, Q11). The operator's working preferences were relearned project by
 * project in each harness's private memory ("ask in prose" was written separately in twelve
 * projects), which other harnesses never read. The profile is one file, `<configDir>/profile.md`
 * (default `~/.config/cmos-mcp/profile.md`): never in a repository, never in a store, so never
 * uploaded, and given to every agent in every project at session start (s93-m05's digest).
 *
 * WHO CHANGES IT. The operator, by editing the file. An agent only through a draft of kind
 * `profile` that the operator approved (s93-m06 supplies those drafts and the approval binding);
 * {@link addProfileLine} refuses everything else, so a write path that skips approval cannot exist
 * by accident. Who owns outward actions (pushes, deploys, releases) stays in each project's rules
 * file, because it differs by project.
 *
 * NEVER SILENTLY CUT. The profile is capped at {@link PROFILE_CAP_CHARS} characters. A line that
 * would take it past the cap is refused with a message naming the cap; the file is never trimmed.
 * A profile the operator edited past the cap is read whole and reported as over it.
 *
 * WHAT THE APPROVAL CHECK CANNOT SEE. {@link addProfileLine} checks the shape of the approval it is
 * handed (kind, status, the very line), not that a draft with that id exists and was approved in
 * the store: a caller that builds the object itself passes. s93-m06's binding is the only caller
 * meant to build one, and must check the draft against the store before it calls.
 */

/**
 * The profile's size limit, in characters. 1,100, not the design's 900: the 900 was sized to sit
 * just above a mis-measured first version ("about 880"), which really measures 1,071 characters,
 * so the cap follows the approved text with headroom (decision at the s93-m12 close; s93-m05's
 * digest gives the profile this much room).
 */
export const PROFILE_CAP_CHARS = 1100;

/** `<configDir>/profile.md`. */
export function profilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cmosConfigDir(env), 'profile.md');
}

export interface OperatorProfile {
  readonly path: string;
  readonly text: string;
  readonly chars: number;
  readonly overCap: boolean;
}

/** Null means absent; other read failures must not silently remove the operator's instructions. */
export function readProfile(env: NodeJS.ProcessEnv = process.env): OperatorProfile | null {
  const file = profilePath(env);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `The operator profile could not be read at ${file}. Check that it is a readable file, then retry.`
    );
  }
  return { path: file, text, chars: text.length, overCap: text.length > PROFILE_CAP_CHARS };
}

/**
 * The approval an agent's profile write needs: an approved draft of kind `profile` naming the very
 * line it adds. s93-m06's binding creates these from the operator's reply; nothing else does.
 */
export interface ApprovedProfileDraft {
  readonly kind: 'profile';
  readonly status: 'approved';
  readonly draftId: string;
  readonly line: string;
}

/** A refused profile write: no approved draft, or past the cap. The message names the remedy. */
export class ProfileWriteRefused extends Error {}

/**
 * Add one line to the profile on an approved draft's authority. Refuses without one, and refuses a
 * line that would take the profile past {@link PROFILE_CAP_CHARS}; the file is never cut to fit.
 * Atomic (temp file, then rename).
 */
export function addProfileLine(
  line: string,
  approval: ApprovedProfileDraft | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): OperatorProfile {
  const file = profilePath(env);
  const text = line.trim();
  if (
    !approval ||
    approval.kind !== 'profile' ||
    approval.status !== 'approved' ||
    approval.line.trim() !== text
  ) {
    throw new ProfileWriteRefused(
      'The operator profile changes only through a draft the operator approved: propose the line ' +
        `as "Would record (profile): ${text}". The operator may also edit ${file} by hand.`
    );
  }
  if (text === '' || text.includes('\n')) {
    throw new ProfileWriteRefused('A profile line is one line of text.');
  }
  const current = readProfile(env)?.text ?? '';
  const next = `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${text}\n`;
  if (next.length > PROFILE_CAP_CHARS) {
    throw new ProfileWriteRefused(
      `The profile is capped at ${PROFILE_CAP_CHARS} characters, and this line would bring it to ` +
        `${next.length}. Shorten or replace a line first (${file}); nothing was written.`
    );
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, next);
  fs.renameSync(temp, file);
  return { path: file, text: next, chars: next.length, overCap: false };
}
