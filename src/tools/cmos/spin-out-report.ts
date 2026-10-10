// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Report affected source sprints whose remaining missions are all parked after spin-out.
// ABOUTME: Preview projects only the selected drops; completed missions and unselected open work remain.
import type { CmosDatabaseClient } from './client';
import type { SpinOutKey, SpinOutSourceSnapshot } from './spin-out-types';
import { isParkedMissionStatus } from './terminal-status';
import { requireSpinOut } from './spin-out-store';
export interface SpinOutParkedSprint {
  readonly sprintId: string;
  readonly status: string | null;
  readonly missionCount: number;
  readonly parkedMissionCount: number;
}
export function spinOutParkedSprints(
  reader: CmosDatabaseClient,
  snapshot: SpinOutSourceSnapshot,
  copied: readonly SpinOutKey[],
  projected: boolean
): SpinOutParkedSprint[] {
  const missions = new Set(copied.filter((key) => key.kind === 'mission').map((key) => key.id));
  const affected = [
    ...new Set(
      snapshot.rows
        .filter((row) => row.key.kind === 'mission' && missions.has(row.key.id))
        .map((row) => row.values.sprint_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    ),
  ].sort();
  const results: SpinOutParkedSprint[] = [];
  for (const sprintId of affected) {
    const rows = requireSpinOut(
      reader.getMany<{ id: string; status: string | null }>(
        'SELECT id,status FROM missions WHERE sprint_id=?',
        [sprintId]
      ),
      'Read affected sprint missions'
    );
    const parked = rows.filter((row) =>
      isParkedMissionStatus(
        projected && missions.has(row.id) && row.status !== 'Completed' ? 'Dropped' : row.status
      )
    ).length;
    if (!rows.length || parked !== rows.length) continue;
    const sprint = requireSpinOut(
      reader.getOne<{ status: string | null }>('SELECT status FROM sprints WHERE id=?', [sprintId]),
      'Read affected sprint status'
    );
    results.push({
      sprintId,
      status: sprint?.status ?? null,
      missionCount: rows.length,
      parkedMissionCount: parked,
    });
  }
  return results;
}
