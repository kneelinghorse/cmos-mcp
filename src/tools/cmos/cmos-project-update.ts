/**
 * cmos_project update action handler
 *
 * Updates project metadata fields. Currently supports project_type.
 *
 * @module tools/cmos/cmos-project-update
 */

import * as path from 'path';

import { withClient } from './client';
import type { CmosToolResult } from './types';
import { createError, createSuccess, CmosErrors } from './errors';
import { appendWarnings, appendWriteFailures } from './format-warnings';
import { patchProjectIdentity } from './project-identity';
import {
  AMBIENT_METADATA_KEY,
  asRulesAmbient,
  describeCmosLineRefresh,
  levelOfTier,
  refreshCmosLine,
} from './rules-files';
import { checkWrite, type WriteFailure } from './write-guard';

const VALID_PROJECT_TYPES = ['general', 'managed', 'build'] as const;
export type ProjectType = (typeof VALID_PROJECT_TYPES)[number];

export interface CmosProjectUpdateParams {
  projectRoot?: string;
  projectType?: string;
}

export interface ProjectUpdateResult {
  updated: Record<string, string>;
  /**
   * s86-m02b — DB errors from the metadata write. ABSENT, not empty, on the clean path: a
   * successful update's answer shape is unchanged from 2.5.0, so the field's presence is itself
   * the signal that something was rejected.
   */
  writeFailures?: WriteFailure[];
}

export async function cmosProjectUpdate(
  params: CmosProjectUpdateParams
): Promise<CmosToolResult<ProjectUpdateResult>> {
  if (!params.projectType) {
    return createError<ProjectUpdateResult>(CmosErrors.missingParameter('projectType'));
  }

  if (!(VALID_PROJECT_TYPES as readonly string[]).includes(params.projectType)) {
    return createError<ProjectUpdateResult>(
      CmosErrors.invalidParameter('projectType', params.projectType, [...VALID_PROJECT_TYPES])
    );
  }

  return withClient(
    (client) => {
      const updated: Record<string, string> = {};
      const writeFailures: WriteFailure[] = [];

      const result = client.execute('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [
        'project_type',
        params.projectType!,
      ]);
      // s86-m02b: `updated` is the answer's claim about what the store now holds. It may only
      // name project_type when the statement actually ran.
      const warnings: string[] = [];
      if (checkWrite(result, { failures: writeFailures }, 'metadata.project_type')) {
        updated['project_type'] = params.projectType!;
        // s93-m12: the identity row names the tier too, so its view says what the project is.
        patchProjectIdentity(client, { tier: params.projectType! }, warnings);
        // s93-m12: the agents file's one CMOS line names the level, so it follows the change, and
        // the answer says so, or says what it left (a line edited by hand, a read-only file).
        // `<root>/cmos/db/cmos.sqlite` → `<root>`.
        // The hooks' setting comes from the store too, so the line says all of what the project is.
        const ambient = client.getOne<{ value: string }>(
          'SELECT value FROM metadata WHERE key = ?',
          [AMBIENT_METADATA_KEY]
        );
        const note = describeCmosLineRefresh(
          refreshCmosLine(path.dirname(path.dirname(path.dirname(client.path))), {
            level: levelOfTier(params.projectType),
            ambient: asRulesAmbient(ambient.success ? ambient.data?.value : undefined),
          })
        );
        if (note) warnings.push(note);
      }

      return createSuccess<ProjectUpdateResult>(
        {
          updated,
          ...(writeFailures.length > 0 ? { writeFailures } : {}),
        },
        warnings
      );
    },
    { projectRoot: params.projectRoot }
  );
}

export function formatProjectUpdateForLLM(result: CmosToolResult<ProjectUpdateResult>): string {
  if (!result.success) {
    return `Failed to update project: ${result.error?.message ?? 'Unknown error'}`;
  }

  const entries = Object.entries(result.data?.updated ?? {});
  // s86-m02b: the empty case can now mean "the write was rejected", so it must not return early
  // past the write-failure section — that is exactly the answer that would assert nothing happened
  // without saying why.
  const lines =
    entries.length === 0 ? ['No fields were updated.'] : ['Project metadata updated:', ''];
  for (const [key, value] of entries) {
    lines.push(`  ${key}: ${value}`);
  }
  appendWriteFailures(lines, result.data?.writeFailures);
  appendWarnings(lines, result);

  return lines.join('\n');
}
