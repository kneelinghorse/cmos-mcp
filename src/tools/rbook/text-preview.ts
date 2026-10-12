// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m08 — retrieval answers carry a preview of each row, at most 300 characters, and say
// ABOUTME: when it was cut; the full text comes from show by id.

/**
 * WHY (retrieval study, R5). Every hit used to carry its full text: decisions here average about
 * 2,000 characters and run to 9,000, so a 10-hit search was about 41 KB and mission start a median
 * 17 KB of structured content behind a 588-byte rendered preview. A preview of at most 300
 * characters with the id, status and sprint lets the agent choose what to expand.
 */
export const PREVIEW_MAX_CHARS = 300;

export interface TextPreview {
  /** At most PREVIEW_MAX_CHARS characters, ending in "…" when cut. */
  preview: string;
  truncated: boolean;
  /** Characters in the full text. */
  fullLength: number;
}

/**
 * Cut at a word boundary where one falls in the last fifth of the window, so a preview does not
 * end mid-word when it need not. Whitespace runs collapse to one space first.
 */
export function previewText(text: string, max: number = PREVIEW_MAX_CHARS): TextPreview {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return { preview: flat, truncated: false, fullLength: text.length };
  const window = flat.slice(0, max - 1);
  const lastSpace = window.lastIndexOf(' ');
  const cut = lastSpace >= Math.floor(max * 0.8) ? window.slice(0, lastSpace) : window;
  return { preview: `${cut.trimEnd()}…`, truncated: true, fullLength: text.length };
}
