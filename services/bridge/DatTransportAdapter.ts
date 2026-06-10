/**
 * DAT transport adapter — BLOCKED stub (Phase 16 alpha).
 *
 * Official Meta DAT capture remains BLOCKED pending the official Meta
 * Android DAT SDK coordinate, API surface, result types, and permission
 * model. None of those details are verified, so:
 * - No DAT method names are used or invented here.
 * - No fake SDK imports are added.
 * - This adapter exists only so the bridge architecture is structurally
 *   ready when official evidence becomes available.
 *
 * Every operation reports DAT_NOT_CONFIGURED.
 */

import type { BridgeMessage } from './bridgeTypes.ts';
import type {
  BridgeMessageListener,
  BridgeTransport,
  BridgeTransportStatus,
} from './BridgeTransport.ts';

export const DAT_BLOCKED_REASON =
  'DAT_NOT_CONFIGURED: official Meta DAT SDK coordinate/API evidence is required';

export class DatTransportAdapter implements BridgeTransport {
  readonly name = 'dat-adapter-blocked';
  readonly kind = 'dat' as const;

  /** Stable error code surfaced to the bridge and UI. */
  readonly blockedCode = 'DAT_NOT_CONFIGURED' as const;

  async connect(): Promise<void> {
    throw new Error(DAT_BLOCKED_REASON);
  }

  async disconnect(): Promise<void> {
    // Nothing to tear down; the adapter never connects.
  }

  async send(_message: BridgeMessage): Promise<void> {
    throw new Error(DAT_BLOCKED_REASON);
  }

  onMessage(_callback: BridgeMessageListener): () => void {
    // No messages will ever arrive from a blocked adapter.
    return () => {};
  }

  getStatus(): BridgeTransportStatus {
    return {
      name: this.name,
      kind: this.kind,
      connectionState: 'blocked',
      detail: 'blocked: awaiting official Meta DAT SDK coordinate/API',
    };
  }
}
