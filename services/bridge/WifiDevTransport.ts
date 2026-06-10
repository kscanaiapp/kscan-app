/**
 * Wi-Fi dev transport (Phase 16 alpha).
 *
 * Dev-only WebSocket client transport for the app-level bridge. Uses the
 * WebSocket global provided by React Native (and by Node 22+ when the
 * module is loaded in tests). It must NOT import Node `ws` or any
 * Node-only API — this file is bundled by Metro into the mobile app.
 *
 * This is a K Scan development transport. It is not a verified Meta
 * glasses transport.
 *
 * Logging policy: only message type, requestId, and status are logged.
 * Image payload data is never logged.
 */

import { isBridgeMessage, type BridgeMessage } from './bridgeTypes.ts';
import type {
  BridgeMessageListener,
  BridgeTransport,
  BridgeTransportConnectionState,
  BridgeTransportStatus,
} from './BridgeTransport.ts';

export const DEFAULT_WIFI_DEV_URL = 'ws://localhost:8787';

type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
};

type WebSocketFactory = (url: string) => WebSocketLike;

function defaultWebSocketFactory(url: string): WebSocketLike {
  const WS = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!WS) {
    throw new Error('WebSocket global is unavailable in this environment');
  }
  return new WS(url);
}

export type WifiDevTransportOptions = {
  url?: string;
  /** Test seam; production callers should omit this. */
  webSocketFactory?: WebSocketFactory;
  connectTimeoutMs?: number;
};

export class WifiDevTransport implements BridgeTransport {
  readonly name = 'wifi-dev-websocket';
  readonly kind = 'wifi-dev' as const;

  private readonly url: string;
  private readonly factory: WebSocketFactory;
  private readonly connectTimeoutMs: number;
  private socket: WebSocketLike | null = null;
  private connectionState: BridgeTransportConnectionState = 'disconnected';
  private detail: string | null = null;
  private listeners: Set<BridgeMessageListener> = new Set();

  constructor(options: WifiDevTransportOptions = {}) {
    this.url = options.url ?? DEFAULT_WIFI_DEV_URL;
    this.factory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  }

  async connect(): Promise<void> {
    if (this.connectionState === 'connected' || this.connectionState === 'connecting') {
      return;
    }
    this.connectionState = 'connecting';
    this.detail = null;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let socket: WebSocketLike;
      try {
        socket = this.factory(this.url);
      } catch (error) {
        this.connectionState = 'error';
        this.detail = 'WebSocket unavailable';
        reject(error instanceof Error ? error : new Error('WebSocket create failed'));
        return;
      }

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.connectionState = 'error';
        this.detail = 'connect timeout';
        try {
          socket.close();
        } catch {
          // ignore close failures during teardown
        }
        reject(new Error('WifiDevTransport connect timed out'));
      }, this.connectTimeoutMs);

      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket = socket;
        this.connectionState = 'connected';
        this.detail = this.url;
        resolve();
      };

      socket.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connectionState = 'error';
        this.detail = 'connection error';
        reject(new Error('WifiDevTransport connection error'));
      };

      socket.onclose = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.connectionState = 'error';
          this.detail = 'closed before open';
          reject(new Error('WifiDevTransport closed before open'));
          return;
        }
        if (this.socket === socket) {
          this.socket = null;
          this.connectionState = 'disconnected';
        }
      };

      socket.onmessage = (event) => {
        this.handleRawMessage(event?.data);
      };
    });
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.connectionState = 'disconnected';
    this.detail = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // ignore close failures during teardown
      }
    }
  }

  async send(message: BridgeMessage): Promise<void> {
    if (!this.socket || this.connectionState !== 'connected') {
      throw new Error('WifiDevTransport is not connected');
    }
    // Safe log: type + requestId only, never payload contents.
    console.log(`[bridge:wifi-dev] send type=${message.type} requestId=${message.requestId}`);
    this.socket.send(JSON.stringify(message));
  }

  onMessage(callback: BridgeMessageListener): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  getStatus(): BridgeTransportStatus {
    return {
      name: this.name,
      kind: this.kind,
      connectionState: this.connectionState,
      detail: this.detail,
    };
  }

  private handleRawMessage(data: unknown): void {
    if (typeof data !== 'string') {
      console.log('[bridge:wifi-dev] dropped non-string frame');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      // Never log frame contents — they could contain image data.
      console.log('[bridge:wifi-dev] dropped invalid JSON frame');
      return;
    }
    if (!isBridgeMessage(parsed)) {
      console.log('[bridge:wifi-dev] dropped non-bridge message');
      return;
    }
    console.log(
      `[bridge:wifi-dev] recv type=${parsed.type} requestId=${parsed.requestId}`
    );
    for (const listener of this.listeners) {
      listener(parsed);
    }
  }
}
