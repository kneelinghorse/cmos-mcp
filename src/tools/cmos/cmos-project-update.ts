/**
 * cmos_project update action handler
 *
 * Updates project metadata fields. Currently supports project_type.
 *
 * @module tools/cmos/cmos-project-update
 */

import { withClient } from './client';
import type { CmosToolResult } from './types';
import { createError, createSuccess, CmosErrors } from './errors';

const VALID_PROJECT_TYPES = ['general', 'managed', 'build'] as const;
export type ProjectType = (typeof VALID_PROJECT_TYPES)[number];

export interface CmosProjectUpdateParams {
  projectRoot?: string;
  projectType?: string;
}

export interface ProjectUpdateResult {
  updated: Record<string, string>;
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

      client.execute('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [
        'project_type',
        params.projectType!,
      ]);
      updated['project_type'] = params.projectType!;

      return createSuccess<ProjectUpdateResult>({ updated });
    },
    { projectRoot: params.projectRoot }
  );
}

export function formatProjectUpdateForLLM(result: CmosToolResult<ProjectUpdateResult>): string {
  if (!result.success) {
    return `Failed to update project: ${result.error?.message ?? 'Unknown error'}`;
  }

  const entries = Object.entries(result.data?.updated ?? {});
  if (entries.length === 0) {
    return 'No fields were updated.';
  }

  const lines = ['Project metadata updated:', ''];
  for (const [key, value] of entries) {
    lines.push(`  ${key}: ${value}`);
  }
  return lines.join('\n');
}
