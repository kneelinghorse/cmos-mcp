// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m04 — the published list of CMOS usage-instruction patterns (G1 criterion 1) and the ceremony
// ABOUTME: sentences counted apart, matched on a prompt before any skip; only ids ever leave this module.

/**
 * G1 CRITERION 1 (decisions #1184, #1192). A prompt counts as prompting when it matches at least
 * one PROCEDURE pattern below and is not a plugin ceremony command. The prompt hook matches before
 * any skip rule and logs only the ids, never the text. A plain sentence that starts a ceremony the
 * operator chose (close out, planning, a build) is not prompting: it matches a CEREMONY pattern
 * and is reported as a separate count, unless it also carries procedure.
 *
 * PRECISION, published before the G1 window opened (s93-m04; counts only, no prompt text). The
 * last 30 days (2026-09-08 to 2026-10-08) of operator prompts in the three G1 projects, from
 * Claude Code transcripts and Codex sessions read offline: 580 prompts that are not slash
 * commands. The first list, fixed from the design's examples before any prompt was read, matched
 * 181 prompts, 177 of them real instructions about using CMOS (97.8%). This list adds what that one
 * missed in the same prompts, so its figure is in-sample: 199 matches, 196 real (98.5%); the three
 * false positives were a description of the operator's own routine, "open a session" meaning a
 * harness session, and a negated "can't save this in cmos". A bare "cmos" match would have caught
 * 215 prompts, most of them ordinary work. Per pattern (real of matched): P02 90 of 90, P03 171 of
 * 171, P04 86 of 87, P05 74 of 75, P07 8 of 9, P12 2 of 2, P13 6 of 6; P01, P06 and P08-P11 matched
 * nothing in those days.
 */

export interface PromptPattern {
  readonly id: string;
  readonly label: string;
  readonly pattern: RegExp;
}

/** Up to 40 characters inside one sentence. */
const GAP = String.raw`[^.\n?!]{0,40}`;

export const PROCEDURE_PATTERNS: readonly PromptPattern[] = [
  {
    id: 'P01',
    label: 'open with the review',
    pattern: new RegExp(
      String.raw`\b(open|start|begin|kick\s+off)\b${GAP}\b(with|by)\b[^.\n?!]{0,25}\b(cmos_review|the review|a review|review(ing)? (the )?(record|cmos))\b`,
      'i'
    ),
  },
  {
    id: 'P02',
    label: 'run a CMOS tool by name',
    pattern: /\b(run|call|use|invoke)\s+(the\s+)?cmos_[a-z_]+/i,
  },
  { id: 'P03', label: 'a written-out CMOS tool call', pattern: /\bcmos_[a-z_]+\s*\(/i },
  {
    id: 'P04',
    label: 'start a CMOS session',
    pattern: /\b(start|open|begin)\s+(a|the|your|a\s+new)\s+(cmos\s+)?session\b/i,
  },
  {
    id: 'P05',
    label: 'capture decisions, learnings or next steps',
    pattern:
      /\b(capture|log)\s+(the\s+|this\s+|that\s+|these\s+|any\s+|your\s+|all\s+|final\s+)?(decisions?|learnings?|lessons?|next[- ]steps?|constraints?)\b|\bremember\s+to\s+capture\b|\b(make|do)\s+(any\s+|the\s+|your\s+)?(final\s+)?(changes\s+or\s+)?captures\b/i,
  },
  {
    id: 'P06',
    label: 'record that decision',
    pattern:
      /\brecord\s+(that|this|the|a|these|those|your|any)\s+(as\s+a\s+)?(decisions?|learnings?)\b/i,
  },
  {
    id: 'P07',
    label: 'put it in CMOS',
    pattern: new RegExp(
      String.raw`\b(record|log|capture|add|put|save|track|note|write|file|store|enter|create[ds]?|updates?|hand\s*off)\b${GAP}\b(in|into|to)\s+(the\s+)?cmos\b(?!\s*/)`,
      'i'
    ),
  },
  {
    id: 'P08',
    label: 'update CMOS',
    pattern:
      /\b(update|sync)\s+(the\s+)?cmos\b|\bkeep\s+cmos\s+(updated|current|up\s+to\s+date)\b/i,
  },
  {
    id: 'P09',
    label: 'close the CMOS session',
    pattern: /\b(close|complete|end|finish)\s+(out\s+)?(the|your|this)\s+cmos\s+session\b/i,
  },
  {
    id: 'P10',
    label: 'move a mission in CMOS',
    pattern: new RegExp(
      String.raw`\b(mark|move|transition|set|complete|start|block|unblock|close)\s+(the|this|that|each)\s+mission\b${GAP}\bin\s+cmos\b`,
      'i'
    ),
  },
  {
    id: 'P11',
    label: 'onboard',
    pattern: new RegExp(String.raw`\bcmos_agent_onboard\b|\bonboard\b${GAP}\bcmos\b`, 'i'),
  },
  {
    id: 'P12',
    label: 'read it in CMOS',
    pattern: new RegExp(
      String.raw`\b(check|consult|search|query|re-?read|read)\b${GAP}\b(in|from)\s+cmos\b(?!\s*/)`,
      'i'
    ),
  },
  {
    id: 'P13',
    label: 'messages or feedback through CMOS',
    pattern: new RegExp(
      String.raw`\b(check|read|answer|respond\s+to|reply\s+to)\b${GAP}\bcmos\s+messages?\b|\bsend\b${GAP}\b(feedback|message)\b${GAP}\b(via|through|in|to)\s+(the\s+)?cmos\b|\bfeedback\b${GAP}\bcmos[\s-]mcp\b`,
      'i'
    ),
  },
];

export const CEREMONY_PATTERNS: readonly PromptPattern[] = [
  {
    id: 'C01',
    label: 'close out a sprint',
    pattern:
      /\b(close\s+out|close|wrap\s+up|complete)\s+(the\s+|this\s+)?sprint\b|\bsprint\s+(review|close)\b/i,
  },
  {
    id: 'C02',
    label: 'open planning',
    pattern:
      /\b(sprint|mission)\s+planning\b|\bplan\s+(the\s+)?next\s+sprint\b|\bplanning\s+session\b/i,
  },
  {
    id: 'C03',
    label: 'start a build',
    pattern: /\b(begin|start|run|kick\s+off)\s+(the\s+)?build\b|\bbuild\s+(for\s+)?sprint\s+\d+/i,
  },
];

/**
 * What a harness wraps around typed text, so a pattern sees what the operator wrote: the pasted-
 * content tags of the VS Code extension, HTML entities and non-breaking spaces, and the markdown
 * escapes a rich-text box adds (`cmos\_review()`).
 */
export function normalizePrompt(text: string): string {
  return text
    .replace(/<\/?pasted_content[^>]*>/g, ' ')
    .replace(/&#x20;|&nbsp;|\u00a0/g, ' ')
    .replace(/\\([_.*#\-`[\]()])/g, '$1');
}

/** A typed slash command at the start of a prompt (`/cmos:close`, `/compact`), or null. */
export function slashCommand(text: string): string | null {
  const match = /^\s*\/([a-z0-9][\w-]*(?::[\w-]+)?)(?=\s|$)/i.exec(text);
  return match ? `/${match[1]}` : null;
}

export interface PromptMatch {
  /** The procedure patterns the prompt matches, in list order. */
  readonly procedurePatternIds: readonly string[];
  /** The command the prompt is, else the ceremony sentence it starts, else null. */
  readonly ceremony: string | null;
}

/** Match one prompt against the published lists. Pure; the text never leaves this function. */
export function matchPrompt(text: string): PromptMatch {
  const normalized = normalizePrompt(text);
  const procedurePatternIds = PROCEDURE_PATTERNS.filter((p) => p.pattern.test(normalized)).map(
    (p) => p.id
  );
  const command = slashCommand(normalized);
  const sentence = CEREMONY_PATTERNS.find((p) => p.pattern.test(normalized))?.id ?? null;
  return { procedurePatternIds, ceremony: command ?? sentence };
}

/** The plugin's ceremony commands (s93-m02): a prompt that is one never counts as prompting. */
export function isCeremonyCommand(ceremony: string | null): boolean {
  return ceremony !== null && /^\/cmos:/i.test(ceremony);
}
