// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A context render carries its local typed record IDs and their exact complete-item spans.
// ABOUTME: Delivery uses those spans to measure what survived the final output cap without parsing prose.

export interface RenderedContext {
  readonly text: string;
  readonly returnedIds: readonly string[];
  readonly items: readonly {
    readonly typedId: string;
    readonly start: number;
    readonly end: number;
  }[];
}
