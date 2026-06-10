/**
 * Bridge transport abstraction (Phase 16 alpha).
 *
 * Transports move bridge messages between the K Scan mobile app and a
 * counterpart (glasses web app, dev tooling, or — in the future — official
 * Meta DAT/Bluetooth channels once their SDK/API details are available).
 *
 * Only `wifi-dev` and `mock` are implemented in this phase. `dat` and
 * `bluetooth` exist as blocked adapter stubs; no Meta protocol details are
 * known or invented here.
 */

import type { BridgeMessage } from './bridgeTypes.ts';

export type BridgeTransportKind = 'wifi-dev' | 'dat' | 'bluetooth' | 'mock';

export type BridgeTransportConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'blocked';

export type BridgeTransportStatus = {
  name: string;
  kind: BridgeTransportKind;
  connectionState: BridgeTransportConnectionState;
  detail: string | null;
};

export type BridgeMessageListener = (message: BridgeMessage) => void;

export interface BridgeTransport {
  readonly name: string;
  readonly kind: BridgeTransportKind;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: BridgeMessage): Promise<void>;
  /** Returns an unsubscribe function. */
  onMessage(callback: BridgeMessageListener): () => void;
  getStatus(): BridgeTransportStatus;
}
