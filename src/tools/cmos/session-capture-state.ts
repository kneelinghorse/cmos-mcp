// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Summarizes persisted session-capture blobs for close-time audit receipts.
// ABOUTME: Treats malformed capture state as unknown so diagnostics never invent a zero.

/**
 * Parse a stored session capture blob for diagnostic receipts.
 *
 * A malformed or non-array value is unknown rather than zero: zero would claim
 * that no deferred work exists when the stored value could not be inspected.
 */
export interface SessionCaptureSummary {
  captureCount: number | null;
  deferredCaptureCount: number | null;
  malformed: boolean;
}

export function summarizeSessionCaptures(rawCaptures: string | null): SessionCaptureSummary {
  if (rawCaptures === null) {
    return { captureCount: null, deferredCaptureCount: null, malformed: true };
  }

  try {
    const captures: unknown = JSON.parse(rawCaptures);
    if (!Array.isArray(captures)) {
      return { captureCount: null, deferredCaptureCount: null, malformed: true };
    }

    const deferredCaptureCount = captures.filter((capture) => {
      if (typeof capture !== 'object' || capture === null || !('category' in capture)) {
        return false;
      }
      const category = (capture as { category?: unknown }).category;
      return category === 'context' || category === 'next-step';
    }).length;

    return {
      captureCount: captures.length,
      deferredCaptureCount,
      malformed: false,
    };
  } catch {
    return { captureCount: null, deferredCaptureCount: null, malformed: true };
  }
}
