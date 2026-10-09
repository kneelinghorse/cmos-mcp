// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — turning an answered draft into a record: which draft, how its approval is known (approved,
// ABOUTME: agent-judged, agent-attested), and the constraint, rule and profile kinds, claimed before they are written.

import type { CmosDatabaseClient } from './client';
import { withClientAsync } from './client';
import { cmosSessionCapture } from './cmos-session-capture';
import {
  CONTENT_FLOOR,
  keywordOverlap,
  recordStatesDraft,
  REVISION_OVERLAP,
  type DraftKind,
  type ReplyClass,
} from './draft-grammar';
import { openDraftRuntime, openWindow, readExcerpt, startsSince } from './draft-runtime';
import { CMOS_ERROR_CODES, createError, createSuccess } from './errors';
import { addProfileLine, readProfile } from './operator-profile';
import {
  clientRunner,
  draftLabel,
  getDraft,
  isExpired,
  parseDraftId,
  pendingDrafts,
  proposalsTableExists,
  type ApprovalMode,
  type DraftRow,
} from './proposals';
import { currentSessionOwner } from './session-owner';
import { storedTimeMs } from './stored-time';
import type { CmosToolError, CmosToolResult } from './types';
import { sanitizeContentField } from '../../intelligence/content-sanitizer';
import { computeContentHash } from './schema-migrations';

/**
 * Build plan B9–B12: hooks bind words by store/session/draft for two hours; subagents share that
 * binding. Hook-less servers attest decisions only. Other kinds need plain approval and use draft
 * text. Approved decisions need one draft and recordStatesDraft (only whitespace may differ);
 * other same-subject wording reads agent-judged, without guessing at equivalent meaning.
 * Decisions approve atomically; other kinds claim first and release on failure.
 */
export interface DraftEvaluation {
  readonly draft: DraftRow;
  readonly label: string;
  readonly mode: ApprovalMode;
  /** The operator's message, for approved and agent-judged. */
  readonly words: string | null;
}

export interface ApprovalEcho {
  readonly draft: string;
  readonly kind: DraftKind;
  readonly mode: ApprovalMode;
  readonly words: string | null;
}

/** The recording server's harness session hash, or null when it writes as a process. */
export function harnessSessionOf(dbPath: string): string | null {
  const owner = currentSessionOwner(dbPath);
  return owner.kind === 'external' && owner.key.startsWith('ext:') ? owner.key.slice(4) : null;
}

function notPending(draft: DraftRow, label: string): CmosToolError {
  const states: Record<string, string> = {
    approved: `was already approved and recorded as ${draft.recordId ?? 'a record'}`,
    declined: 'was declined by the operator',
    replaced:
      `was replaced by its revision ${draft.replacedBy ? draftLabel(draft.replacedBy) : ''}`.trim(),
    answered: `was answered by a direct record (${draft.recordId ?? 'unknown'})`,
  };
  return {
    code: CMOS_ERROR_CODES.DRAFT_NOT_PENDING,
    message: `Draft ${label} ${states[draft.outcome] ?? `is ${draft.outcome}`}; nothing was recorded.`,
    suggestion:
      draft.outcome === 'replaced' && draft.replacedBy
        ? `Record the revision instead, with fromDraft="${draftLabel(draft.replacedBy)}", once the operator approves it.`
        : 'Nothing to record from this draft. Propose the choice again with a Would record line if it still matters.',
  };
}

const REPLY_WORDS: Readonly<Record<ReplyClass, string>> = {
  approval: 'an approval of several drafts at once',
  decline: 'a decline',
  question: 'a question',
  other: 'not a plain approval',
};

/** The one refusal for a draft the operator has not plainly approved here; its remedy re-proposes. */
function approvalRequired(draft: DraftRow, label: string, why: string): CmosToolError {
  return {
    code: CMOS_ERROR_CODES.APPROVAL_REQUIRED,
    message: `Draft ${label} (${draft.kind}) was not recorded: ${why}`,
    suggestion: `End a reply with "Would record${draft.kind === 'decision' ? '' : ` (${draft.kind})`}: ${draft.text.slice(0, 80)}" (revised if needed), and record it after the operator approves it.`,
  };
}

/** Which draft, whether it can still be recorded, and how its approval is known. */
export function evaluateDraft(
  client: CmosDatabaseClient,
  fromDraft: unknown,
  content: string,
  env: NodeJS.ProcessEnv,
  now: number
): { ok: true; value: DraftEvaluation } | { ok: false; error: CmosToolError } {
  const id = parseDraftId(
    typeof fromDraft === 'string' || typeof fromDraft === 'number' ? fromDraft : null
  );
  if (id === null)
    return {
      ok: false,
      error: {
        code: CMOS_ERROR_CODES.INVALID_PARAMETER,
        message: `fromDraft must be a draft id such as "P3"; got ${JSON.stringify(fromDraft)}.`,
        field: 'fromDraft',
        providedValue: fromDraft,
        suggestion: 'Use the id CMOS gave the draft (P<n>), or record without fromDraft.',
      },
    };
  const label = draftLabel(id);
  const run = clientRunner(client);
  const draft = proposalsTableExists(run) ? getDraft(run, id) : undefined;
  if (!draft)
    return {
      ok: false,
      error: {
        code: CMOS_ERROR_CODES.DRAFT_NOT_FOUND,
        message: `No draft ${label} in this project's store; nothing was recorded.`,
        suggestion:
          'Check the project (projectRoot) and the id with `cmos-mcp drafts list`, or record without fromDraft.',
      },
    };
  if (draft.outcome !== 'pending') return { ok: false, error: notPending(draft, label) };
  const runtime = openDraftRuntime(client.path, env, { readonly: true });
  try {
    const starts = runtime ? startsSince(runtime, storedTimeMs(draft.createdAt)) : 0;
    if (isExpired(draft, starts, now))
      return {
        ok: false,
        error: {
          code: CMOS_ERROR_CODES.DRAFT_NOT_PENDING,
          message: `Draft ${label} expired unanswered (7 days or 3 session starts); an expired draft is never recorded.`,
          suggestion: 'Propose the choice again with a Would record line if it still matters.',
        },
      };
    if (keywordOverlap(draft.text, content) < CONTENT_FLOOR)
      return {
        ok: false,
        error: {
          code: CMOS_ERROR_CODES.INVALID_PARAMETER,
          message: `The content does not state draft ${label} ("${draft.text.slice(0, 120)}"); the operator's approval covers only what the draft said.`,
          field: 'content',
          suggestion: `Record ${label}'s decision, with any nuance folded in. If the decision itself changed, end your reply with a revised Would record line so the operator approves the new text, or record it without fromDraft.`,
        },
      };
    const session = harnessSessionOf(client.path);
    const excerpt = session && runtime ? readExcerpt(runtime, session, id, now) : null;
    if (excerpt?.reply === 'decline')
      return {
        ok: false,
        error: {
          code: CMOS_ERROR_CODES.DRAFT_NOT_PENDING,
          message: `The operator declined draft ${label}; nothing was recorded.`,
          suggestion: 'Do not record it. Propose a different choice with a new Would record line.',
        },
      };
    if (session && !excerpt)
      return {
        ok: false,
        error: approvalRequired(
          draft,
          label,
          'the operator has not answered it in this conversation within the last two hours, and a draft nobody answered is never recorded.'
        ),
      };
    const plain = excerpt?.reply === 'approval';
    if (draft.kind !== 'decision' && !plain)
      return {
        ok: false,
        error: approvalRequired(
          draft,
          label,
          excerpt
            ? `a ${draft.kind} is written only on the operator's plain approval, and their message was ${REPLY_WORDS[excerpt.reply as ReplyClass] ?? 'not one'}.`
            : `a ${draft.kind} needs the operator's approval in a conversation with CMOS hooks, and this server has none.`
        ),
      };
    const single = plain && excerpt?.windowSize === 1;
    const mode: ApprovalMode = !excerpt
      ? 'agent-attested'
      : single && (draft.kind !== 'decision' || recordStatesDraft(draft.text, content))
        ? 'approved'
        : 'agent-judged';
    return { ok: true, value: { draft, label, mode, words: excerpt ? excerpt.message : null } };
  } finally {
    runtime?.close();
  }
}

export function approvalEcho(evaluation: DraftEvaluation): ApprovalEcho {
  return {
    draft: evaluation.label,
    kind: evaluation.draft.kind,
    mode: evaluation.mode,
    words: evaluation.words,
  };
}

export interface DirectRecordAnswers {
  /** Window drafts the record covers: marked answered in the record's transaction. */
  readonly answered: readonly number[];
  /** Window drafts it does not: named on the answer so the same choice is not recorded twice. */
  readonly stillPending: readonly number[];
}

/**
 * A record made without fromDraft while the operator's message is open on drafts (B12, folded):
 * the drafts it covers are answered by it; the others stay pending and are named.
 */
export function directRecordAnswers(
  client: CmosDatabaseClient,
  content: string,
  env: NodeJS.ProcessEnv,
  now: number
): DirectRecordAnswers {
  const none = { answered: [], stillPending: [] };
  const session = harnessSessionOf(client.path);
  if (!session) return none;
  const run = clientRunner(client);
  if (!proposalsTableExists(run)) return none;
  const runtime = openDraftRuntime(client.path, env, { readonly: true });
  if (!runtime) return none;
  try {
    const window = openWindow(runtime, session, now);
    if (!window.length) return none;
    const drafts = pendingDrafts(run).filter(
      (row) =>
        window.includes(row.id) &&
        !isExpired(row, startsSince(runtime, storedTimeMs(row.createdAt)), now)
    );
    const answered = drafts
      .filter((row) => keywordOverlap(row.text, content) >= REVISION_OVERLAP)
      .map((row) => row.id);
    return {
      answered,
      stillPending: drafts.map((row) => row.id).filter((id) => !answered.includes(id)),
    };
  } finally {
    runtime.close();
  }
}

export interface CmosDraftRecordResult {
  /** What the draft became: a constraint, an evergreen learning (rule) or a profile line. */
  readonly recorded: {
    readonly kind: Exclude<DraftKind, 'decision'>;
    readonly id: number | null;
    readonly typedId: string;
    readonly materialization: 'materialized' | 'existing';
  };
  readonly approval: ApprovalEcho;
  readonly message: string;
}

async function withRun<T>(
  projectRoot: string | undefined,
  action: (client: CmosDatabaseClient) => T
): Promise<CmosToolResult<T>> {
  return withClientAsync(async (client) => createSuccess(action(client)), {
    projectRoot,
    registerProject: false,
  });
}

/** Constraint, rule and profile drafts: claim, write, then name the record (N1). */
export async function recordDraftOfKind(
  params: {
    readonly content: string;
    readonly missionId?: string;
    readonly sprintId?: string;
    readonly projectRoot?: string;
  },
  evaluation: DraftEvaluation,
  env: NodeJS.ProcessEnv = process.env
): Promise<CmosToolResult<CmosDraftRecordResult>> {
  const kind = evaluation.draft.kind as Exclude<DraftKind, 'decision'>;
  const id = evaluation.draft.id;
  const at = new Date().toISOString();
  // Written as drafted: the operator approved the draft's words, and these kinds reach every
  // session (the build critic, B2). Different content is reported, never written.
  const drafted = evaluation.draft.text.trim();
  const ignored = recordStatesDraft(drafted, params.content)
    ? []
    : [
        `The ${kind} was written as drafted (${evaluation.label}); the content passed differs and was not used. Propose a revised line to change it.`,
      ];
  const claimed = await withRun(params.projectRoot, (client) =>
    clientRunner(client).run(
      `UPDATE proposals SET outcome = 'approved', approval_mode = ?, answered_at = ?
       WHERE id = ? AND outcome = 'pending'`,
      [evaluation.mode, at, id]
    )
  );
  if (!claimed.success) return createError(claimed.error!);
  if (claimed.data!.changes === 0)
    return createError({
      code: CMOS_ERROR_CODES.DRAFT_NOT_PENDING,
      message: `Draft ${evaluation.label} was answered by another call first; nothing was written.`,
      suggestion: 'Read the drafts with `cmos-mcp drafts list` before recording again.',
    });
  const release = async (): Promise<void> => {
    await withRun(params.projectRoot, (client) =>
      clientRunner(client).run(
        `UPDATE proposals SET outcome = 'pending', approval_mode = NULL, answered_at = NULL
         WHERE id = ? AND outcome = 'approved' AND record_id IS NULL`,
        [id]
      )
    );
  };
  let recordId: number | null = null;
  let typedId: string;
  let materialization: 'materialized' | 'existing' = 'materialized';
  try {
    if (kind === 'profile') {
      const line = drafted;
      const existing = readProfile(env)
        ?.text.split('\n')
        .some((row) => row.trim() === line);
      if (existing) materialization = 'existing';
      else
        addProfileLine(
          line,
          { kind: 'profile', status: 'approved', draftId: evaluation.label, line },
          env
        );
      typedId = 'profile';
    } else {
      const captured = await cmosSessionCapture({
        category: kind === 'constraint' ? 'constraint' : 'learning',
        content: drafted,
        missionId: params.missionId,
        sprintId: params.sprintId,
        projectRoot: params.projectRoot,
        ...(kind === 'rule' ? { evergreen: true } : {}),
      });
      if (!captured.success || !captured.data) {
        await release();
        return createError(
          captured.error ?? {
            code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
            message: `The ${kind} was not written; draft ${evaluation.label} stays pending.`,
          }
        );
      }
      materialization =
        captured.data.structuredMaterialization.outcome === 'existing'
          ? 'existing'
          : 'materialized';
      if (kind === 'rule') {
        recordId = captured.data.learningId ?? null;
        typedId = recordId ? `l:${recordId}` : 'l:unknown';
      } else {
        const hash = computeContentHash(sanitizeContentField(drafted).cleaned, 'constraint');
        const row = await withRun(params.projectRoot, (client) =>
          clientRunner(client).get<{ id: number }>(
            "SELECT id FROM constraints WHERE content_hash = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
            [hash]
          )
        );
        recordId = row.success ? (row.data?.id ?? null) : null;
        typedId = recordId ? `c:${recordId}` : 'c:unknown';
      }
    }
  } catch (error) {
    await release();
    return createError({
      code: CMOS_ERROR_CODES.INVALID_PARAMETER,
      message: `${error instanceof Error ? error.message : String(error)} Draft ${evaluation.label} stays pending.`,
      suggestion: 'Fix the content and record again once the operator has approved it.',
    });
  }
  const named = await withRun(params.projectRoot, (client) =>
    clientRunner(client).run('UPDATE proposals SET record_id = ? WHERE id = ?', [typedId, id])
  );
  const warnings = [
    ...ignored,
    ...(named.success
      ? []
      : [
          `The ${kind} was written, but draft ${evaluation.label} could not name it: ${named.error?.message ?? 'unknown'}.`,
        ]),
  ];
  const result = createSuccess<CmosDraftRecordResult>({
    recorded: { kind, id: recordId, typedId, materialization },
    approval: approvalEcho(evaluation),
    message: `Recorded draft ${evaluation.label} as ${kind === 'rule' ? 'a standing rule' : kind === 'profile' ? 'a profile line' : 'a constraint'} (${typedId}), ${evaluation.mode}.`,
  });
  return warnings.length ? { ...result, warnings } : result;
}
