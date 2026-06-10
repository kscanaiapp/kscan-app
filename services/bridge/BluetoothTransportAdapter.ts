/**
 * Bluetooth transport adapter — BLOCKED stub (Phase 16 alpha).
 *
 * Generic Bluetooth is NOT implemented. Meta glasses Bluetooth
 * service/characteristic details are UNKNOWN, and no UUIDs, service
 * names, or protocol details are invented here. There is no verified
 * evidence that generic Android/iOS Bluetooth can communicate with Meta
 * glasses, so no production Bluetooth logic exists in this adapter.
 *
 * Every operation reports BLUETOOTH_NOT_CONFIGURED.
 */

import type { BridgeMessage } from './bridgeTypes.ts';
import type {
  BridgeMessageListener,
  BridgeTransport,
  BridgeTransportStatus,
} from './BridgeTransport.ts';

export const BLUETOOTH_BLOCKED_REASON =
  'BLUETOOTH_NOT_CONFIGURED: Meta glasses Bluetooth protocol details are unknown';

export class BluetoothTransportAdapter implements BridgeTransport {
  readonly name = 'bluetooth-adapter-blocked';
  readonly kind = 'bluetooth' as const;

  /** Stable error code surfaced to the bridge and UI. */
  readonly blockedCode = 'BLUETOOTH_NOT_CONFIGURED' as const;

  async connect(): Promise<void> {
    throw new Error(BLUETOOTH_BLOCKED_REASON);
  }

  async disconnect(): Promise<void> {
    // Nothing to tear down; the adapter never connects.
  }

  async send(_message: BridgeMessage): Promise<void> {
    throw new Error(BLUETOOTH_BLOCKED_REASON);
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
      detail: 'blocked: Meta Bluetooth service/characteristic details unknown',
    };
  }
}
