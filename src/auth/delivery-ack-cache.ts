// ABOUTME: Sprint 57 m04 — module-level cache for the most recent deliveryAck.identitySource.
// ABOUTME: Captured by sendMessage and read by computeAuthState() for whoami + onboard diagnostics.

/**
 * Last `deliveryAck.identitySource` returned by the dashboard.
 *
 * The dashboard reports how it attributed an outbound send:
 *   - `api-key`      — authenticated via a project-scoped key (rotation complete)
 *   - `request-body` — still using user-scoped key + body-level senderProjectId (rotation pending)
 *   - `none`         — no identifiable sender project
 *
 * This module is a tiny in-process cache so `whoami` and `cmos_agent_onboard`
 * can surface the most-recent value without forcing a fresh round-trip. The
 * cache is process-local (cleared on restart) and never persisted to disk.
 *
 * @module auth/delivery-ack-cache
 */

export type DeliveryIdentitySource = 'api-key' | 'request-body' | 'none';

export interface DeliveryAckSnapshot {
  identitySource: DeliveryIdentitySource;
  /** ISO timestamp when this value was last observed. */
  observedAt: string;
}

let cached: DeliveryAckSnapshot | null = null;

/** Record the most recent deliveryAck — called by `sendMessage` after a 2xx send. */
export function recordDeliveryAck(identitySource: DeliveryIdentitySource): void {
  cached = { identitySource, observedAt: new Date().toISOString() };
}

/** Read the most recent snapshot, or `null` if no send has been observed this process. */
export function getLastDeliveryAck(): DeliveryAckSnapshot | null {
  return cached;
}

/** Reset the cache. Tests only. */
export function resetDeliveryAckCache(): void {
  cached = null;
}
