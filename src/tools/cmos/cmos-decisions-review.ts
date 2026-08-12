/**
 * cmos_decisions review action
 *
 * Returns stale and approaching-stale decisions with per-decision
 * staleness scores and suggested lifecycle actions (archive/confirm/review).
 * Read-only — does not mutate the database.
 *
 * @module tools/cmos/cmos-decisions-review
 */

import { withClientValidated } from './client';
import type { CmosToolResult } from './types';
import { reviewDecisionStaleness, type DecisionReviewResult } from './staleness-detection';
import { buildUntaggedDecisionAdvisory } from './untagged-advisory';
import { appendWarnings } from './format-warnings';

export type CmosDecisionsReviewResult = DecisionReviewResult;

export interface CmosDecisionsReviewParams {
  /** Include decisions approaching staleness (default true) */
  includeApproaching?: boolean;
  /** Optional project root */
  projectRoot?: string;
}

export async function cmosDecisionsReview(
  params: CmosDecisionsReviewParams
): Promise<CmosToolResult<CmosDecisionsReviewResult>> {
  return withClientValidated(
    (client) => {
      const result = reviewDecisionStaleness(client, {
        includeApproaching: params.includeApproaching ?? true,
      });

      // s85-m03: staleness-detection.ts filters `sprint_id IS NOT NULL` when choosing
      // candidates, so an untagged active decision can NEVER be flagged stale. After m03
      // that set grows with normal use on a store with no open sprint, so report it rather
      // than let triage silently shrink.
      const untagged = buildUntaggedDecisionAdvisory(client);

      return {
        success: true as const,
        data: result,
        ...(untagged ? { warnings: [untagged] } : {}),
      };
    },
    { projectRoot: params.projectRoot }
  );
}

export function formatDecisionsReviewForLLM(
  result: CmosToolResult<CmosDecisionsReviewResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    return [
      '❌ Failed to review decisions',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
      error?.suggestion ? `Suggestion: ${error.suggestion}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const data = result.data;
  const lines: string[] = [];

  lines.push('📋 **Decision Lifecycle Review**');
  lines.push('');
  lines.push(
    `Active: ${data.totalActive} | Stale: ${data.totalStale} | Threshold: ${data.threshold} sprints | Current Sprint: ${data.currentSprintNumber ?? 'unknown'}`
  );

  if (data.decisions.length === 0) {
    lines.push('');
    lines.push('✅ No decisions need attention.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`**${data.decisions.length} decision(s) need attention:**`);
  lines.push('');

  // Group by suggested action
  const byAction = {
    archive: data.decisions.filter((d) => d.suggestedAction === 'archive'),
    review: data.decisions.filter((d) => d.suggestedAction === 'review'),
    confirm: data.decisions.filter((d) => d.suggestedAction === 'confirm'),
  };

  if (byAction.archive.length > 0) {
    lines.push(`**🗄️ Suggested: Archive (${byAction.archive.length})**`);
    for (const d of byAction.archive) {
      lines.push(`  #${d.id} [${d.sprintId}] score=${d.stalenessScore} — ${d.text}`);
    }
    lines.push(
      `  → cmos_decisions(action="batch_update", decisionIds=[${byAction.archive.map((d) => d.id).join(',')}], status="archived")`
    );
    lines.push('');
  }

  if (byAction.review.length > 0) {
    lines.push(`**🔍 Suggested: Review (${byAction.review.length})**`);
    for (const d of byAction.review) {
      lines.push(`  #${d.id} [${d.sprintId}] score=${d.stalenessScore} — ${d.text}`);
    }
    lines.push('');
  }

  if (byAction.confirm.length > 0) {
    lines.push(`**✅ Suggested: Confirm (${byAction.confirm.length})**`);
    for (const d of byAction.confirm) {
      const tag = d.hasEvidence ? '(has evidence)' : '(referenced)';
      lines.push(`  #${d.id} [${d.sprintId}] score=${d.stalenessScore} ${tag} — ${d.text}`);
    }
    lines.push('');
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}
