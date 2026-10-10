// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Shared copy plans keep row identity separate from the containing store's identity.
// ABOUTME: Mapping helpers are synchronous and never own a transaction or stamp genesis events.
import type { CmosDatabaseClient } from './client';
import type { CitationIdentity, InventoryKind } from './record-link-extractor';

export type SpinOutKind = 'mission' | 'decision' | 'learning' | 'next-step';
export type SpinOutKey =
  | { readonly kind: 'mission'; readonly id: string }
  | { readonly kind: Exclude<SpinOutKind, 'mission'>; readonly id: number };
export type SpinOutSqlValue = string | number | null;
export type SpinOutReader = Pick<CmosDatabaseClient, 'path' | 'getOne' | 'getMany'>;
export const SPIN_OUT_ROW_PREFIX = 'spin_out_row:';
export const SPIN_OUT_ORIGIN_PREFIX = 'spin_out_origin:';
export interface SpinOutPointer {
  readonly operationId: string;
  readonly sourceProjectId: string;
  readonly sourceRoot: string;
  readonly sourceId: string | number;
  readonly targetProjectId: string;
  readonly targetRoot: string;
  readonly targetId: string | number;
}
export interface SpinOutSourceRow {
  readonly key: SpinOutKey;
  readonly values: Readonly<Record<string, SpinOutSqlValue>>;
}
export interface SpinOutDependency {
  readonly from_id: string;
  readonly to_id: string;
  readonly type: string;
}
export interface SpinOutSourceSnapshot {
  readonly sourceProjectId: string;
  readonly selectionDescriptor: Readonly<Record<string, unknown>>;
  readonly columns: Readonly<Record<SpinOutKind, readonly string[]>>;
  readonly rows: readonly SpinOutSourceRow[];
  /** Include all edges incident on the selection, including uncopied boundary endpoints. */
  readonly dependencies: readonly SpinOutDependency[];
  /** Full five-table identity inventory; changes to uncopied collisions invalidate the proof. */
  readonly collisionInventory: readonly (CitationIdentity & { readonly kind: InventoryKind })[];
}
export interface SpinOutIdMapping {
  readonly source: SpinOutKey;
  readonly target: SpinOutKey;
}
export interface SpinOutIdentity {
  readonly projectId: string;
  readonly root: string;
  readonly storePath: string;
}
export interface SpinOutMappingContext {
  readonly operationId: string;
  readonly source: SpinOutIdentity;
  readonly target: SpinOutIdentity;
  /** Explicit source project address, e.g. cmos://owner/project; never a target-local label. */
  readonly sourceUri: string;
  readonly masterContextId: 'master_context';
}
export interface SpinOutProvenance extends SpinOutPointer {
  readonly kind: SpinOutKind;
  readonly sourceStorePath: string;
  readonly originalProjectId: SpinOutSqlValue;
  readonly originalReferences: Readonly<Record<string, SpinOutSqlValue>>;
  readonly originalApproval?: {
    readonly mode: SpinOutSqlValue;
    readonly draft: SpinOutSqlValue;
    readonly words: SpinOutSqlValue;
  };
}
export interface SpinOutCopyRow {
  readonly source: SpinOutKey;
  readonly target: SpinOutKey;
  readonly table: 'missions' | 'strategic_decisions' | 'learnings' | 'next_steps';
  /** Explicit column values; the executor appends a fresh genesis stamp per INSERT. */
  readonly values: Readonly<Record<string, SpinOutSqlValue>>;
}
export interface SpinOutCitationReport {
  readonly rewritten: number;
  readonly qualified: number;
}
export interface SpinOutCopyPlan {
  readonly rows: readonly SpinOutCopyRow[];
  readonly deferredSupersessions: readonly { readonly id: number; readonly supersededBy: number }[];
  readonly dependencies: readonly SpinOutDependency[];
  readonly boundaryDependencies: readonly SpinOutDependency[];
  readonly provenance: readonly SpinOutProvenance[];
  readonly citationReport: SpinOutCitationReport;
}
export interface SpinOutManifest {
  readonly hash: string;
  readonly selectionHash: string;
  readonly schemaHash: string;
  readonly collisionHash: string;
  readonly rows: readonly { readonly key: SpinOutKey; readonly hash: string }[];
  readonly dependencyHash: string;
}
