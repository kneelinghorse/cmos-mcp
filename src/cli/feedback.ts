// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Files standalone friction through the shared feedback writer without creating a session.
// ABOUTME: Preserves project resolution, sanitized receipts, write failures and local telemetry.

import { oneLine, parseArgs, resolveCliProject, type CliIo } from './core';
import { sanitizeContentField } from '../intelligence/content-sanitizer';
import { observeCliResult } from './telemetry';
import { recordAgentFeedback } from '../tools/cmos/agent-feedback';
import { withClient } from '../tools/cmos/client';
import { createError, createSuccess } from '../tools/cmos/errors';
import { attachWarnings } from '../tools/cmos/format-warnings';
import { getProjectId } from '../tools/cmos/project-id';
import { isReadOnlyAgentSession } from '../tools/cmos/read-only-agent-guard';
import { captureToolCall } from '../tools/cmos/tool-call-context';
import type { CmosToolResult } from '../tools/cmos/types';

type FeedbackReceipt = CmosToolResult<
  { feedbackId: number } | { dryRun: true; content: string; projectRoot: string }
>;

/** Filing feedback is independent of the harness lifecycle; omitted context stays NULL. */
export async function runFeedback(argv: readonly string[], io: CliIo): Promise<number> {
  const { flags } = parseArgs(argv);
  const dryRun = flags['dry-run'] === 'true';
  const finish = (result: FeedbackReceipt): number => {
    observeCliResult(io, 'feedback', {}, result);
    if (flags.format === 'json') {
      io.stdout(`${JSON.stringify(result)}\n`);
    } else if (!result.success) {
      io.stderr(
        oneLine(
          `cmos-mcp feedback: ${result.error?.message ?? 'Feedback was not recorded.'} ` +
            `${result.error?.suggestion ?? ''} ${(result.warnings ?? []).join(' ')}`
        )
      );
    } else {
      const data = result.data!;
      io.stdout(
        'dryRun' in data
          ? `Feedback preview (not recorded):\n${data.content}\n`
          : `Feedback #${data.feedbackId} recorded.\n`
      );
      for (const field of result.sanitizedFields ?? []) {
        io.stdout(`Sanitized ${field.field}: ${oneLine(field.reason)}\n`);
      }
      for (const warning of result.warnings ?? []) io.stdout(`Warning: ${oneLine(warning)}\n`);
    }
    return result.success ? 0 : 1;
  };

  const content = flags.content;
  if (!content?.trim() || content === 'true') {
    return finish(
      createError({
        code: 'INVALID_PARAMETER',
        message: 'Feedback needs content.',
        suggestion: 'Pass --content <text> describing the friction.',
      })
    );
  }
  if (!dryRun && isReadOnlyAgentSession(io.env)) {
    return finish(
      createError({
        code: 'READ_ONLY_AGENT',
        message: 'CMOS_AGENT_ROLE=review permits only reads; feedback was not recorded.',
        suggestion: 'Use a write-enabled session to file feedback.',
      })
    );
  }
  const resolution = resolveCliProject({
    projectRootArg: flags['project-root'],
    env: io.env,
    cwd: io.cwd,
  });
  if (resolution.kind !== 'store') {
    return finish(
      createError({
        code: 'CMOS_NOT_DETECTED',
        message:
          resolution.kind === 'store-missing'
            ? `The CMOS store is missing: ${resolution.dbPath}.`
            : `No CMOS project at ${resolution.kind === 'none' ? resolution.workingDir : resolution.dir}.`,
        suggestion: 'Pass --project-root <dir> for an existing CMOS project.',
      })
    );
  }
  if (dryRun) {
    const sanitation = sanitizeContentField(content.trim());
    if (!sanitation.cleaned) {
      return finish(
        createError({
          code: 'INVALID_PARAMETER',
          message: 'Feedback has no usable text after sanitization.',
          suggestion: 'Pass --content <text> without parameter markup.',
        })
      );
    }
    return finish(
      createSuccess(
        { dryRun: true, content: sanitation.cleaned, projectRoot: resolution.projectRoot },
        undefined,
        sanitation.wasModified
          ? [{ field: 'agentFeedback', reason: sanitation.reason ?? 'Stripped parameter markup.' }]
          : undefined
      )
    );
  }
  const captured = await captureToolCall('write', async () => {
    const warnings: string[] = [];
    const result = await withClient<{ feedbackId: number }>(
      (client) => {
        const recorded = recordAgentFeedback(client, content, {
          toolName: 'cmos-mcp feedback',
          projectId: getProjectId(client),
        });
        warnings.push(...recorded.warnings);
        if (recorded.feedbackId === null) {
          return {
            ...createError<{ feedbackId: number }>({
              code: recorded.warnings.length > 0 ? 'DB_QUERY_FAILED' : 'INVALID_PARAMETER',
              message:
                recorded.warnings.length > 0
                  ? 'Feedback was not recorded.'
                  : 'Feedback has no usable text after sanitization.',
              suggestion:
                recorded.warnings.length > 0
                  ? 'Resolve the reported database error and retry.'
                  : 'Pass --content <text> without parameter markup.',
            }),
            sanitizedFields: recorded.sanitizedFields,
          };
        }
        return createSuccess(
          { feedbackId: recorded.feedbackId },
          undefined,
          recorded.sanitizedFields
        );
      },
      { projectRoot: resolution.projectRoot, registerProject: false }
    );
    return attachWarnings(result, warnings);
  });
  return finish({
    ...captured.value,
    warnings: [
      ...(captured.value.warnings ?? []),
      ...captured.projectIdentityDisclosures,
      ...captured.storeUpkeepNotes,
    ],
  });
}
