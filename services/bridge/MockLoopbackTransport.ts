/**
 * Mock loopback transport (Phase 16 alpha).
 *
 * Local in-memory transport for tests and the debug screen. No network.
 * Messages "sent" by the app are recorded; tests/UI can emit inbound
 * messages to the BridgeService via emitIncoming().
 */

import type { BridgeMessage } from './bridgeTypes.ts';
import type {
  BridgeMessageListener,
  BridgeTransport,
  BridgeTransportStatus,
} from './BridgeTransport.ts';

export class MockLoopbackTransport implements BridgeTransport {
  readonly name = 'mock-loopback';
  readonly kind = 'mock' as const;

  private connected = false;
  private listeners: Set<BridgeMessageListener> = new Set();
  /** Messages the app sent outward. Safe to inspect in tests/UI. */
  readonly sentMessages: BridgeMessage[] = [];

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async send(message: BridgeMessage): Promise<void> {
    if (!this.connected) {
      throw new Error('MockLoopbackTransport is not connected');
    }
    this.sentMessages.push(message);
  }

  onMessage(callback: BridgeMessageListener): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /** Simulates an inbound message from the glasses/web side. */
  emitIncoming(message: BridgeMessage): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }

  getStatus(): BridgeTransportStatus {
    return {
      name: this.name,
      kind: this.kind,
      connectionState: this.connected ? 'connected' : 'disconnected',
      detail: 'in-memory loopback (no network)',
    };
  }
}
