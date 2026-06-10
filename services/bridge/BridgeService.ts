/**
 * Bridge service (Phase 16 alpha).
 *
 * Orchestrates the app-level bridge: selected transport, capture request
 * queue, dev capture provider, permission status, bridge state, and status
 * subscribers for the debug UI.
 *
 * Scope and safety:
 * - Dev/alpha only. In this phase the capture provider is the safe
 *   deterministic dev fixture — never the phone camera, never Meta DAT.
 * - DAT/Bluetooth paths stay blocked behind adapter stubs until official
 *   Meta SDK/API evidence exists.
 * - Never uploads to a backend, never writes images to disk, never logs
 *   image payloads. Status objects contain metadata only.
 */

import {
  CAPTURE_ERROR_TYPE,
  CAPTURE_REQUEST_TYPE,
  CAPTURE_SUCCESS_TYPE,
  type BridgeErrorCode,
  type BridgeMessage,
  type CaptureErrorMessage,
  type CaptureRequestMessage,
  type CaptureSuccessMessage,
} from './bridgeTypes.ts';
import { CaptureRequestQueue, CaptureQueueError } from './CaptureRequestQueue.ts';
import type { BridgeTransport, BridgeTransportStatus } from './BridgeTransport.ts';
import { WifiDevTransport } from './WifiDevTransport.ts';
import { DatTransportAdapter } from './DatTransportAdapter.ts';
import { BluetoothTransportAdapter } from './BluetoothTransportAdapter.ts';
import { devCaptureProvider, type DevCaptureProvider } from './devCaptureProvider.ts';
import { validateBridgePayload } from './validateBridgePayload.ts';
import type { BridgePermissionStatus } from './BridgePermissionStatus.ts';

export type BridgeState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'capturePending'
  | 'error'
  | 'stopped';

export type BridgeStatus = {
  bridgeState: BridgeState;
  activeTransport: string | null;
  isDevMode: boolean;
  lastMessageType: string | null;
  lastRequestId: string | null;
  lastErrorCode: BridgeErrorCode | null;
  datStatus: BridgeTransportStatus;
  bluetoothStatus: BridgeTransportStatus;
  wifiStatus: BridgeTransportStatus | null;
  permissionStatus: BridgePermissionStatus | null;
  updatedAt: string;
};

export type BridgeStatusListener = (status: BridgeStatus) => void;

export type BridgeServiceOptions = {
  /** Transport used by startDevBridge(); defaults to WifiDevTransport. */
  transport?: BridgeTransport;
  captureProvider?: DevCaptureProvider;
  /** Injected so this module never imports react-native. */
  getPermissionStatus?: () => Promise<BridgePermissionStatus>;
  isDevMode?: boolean;
};

let simulatedRequestCounter = 0;

export class BridgeService {
  private readonly queue = new CaptureRequestQueue();
  private readonly captureProvider: DevCaptureProvider;
  private readonly getPermissionStatus: (() => Promise<BridgePermissionStatus>) | null;
  private readonly isDevMode: boolean;
  private readonly datAdapter = new DatTransportAdapter();
  private readonly bluetoothAdapter = new BluetoothTransportAdapter();

  private transport: BridgeTransport;
  private transportUnsubscribe: (() => void) | null = null;
  private state: BridgeState = 'idle';
  private lastMessageType: string | null = null;
  private lastRequestId: string | null = null;
  private lastErrorCode: BridgeErrorCode | null = null;
  private permissionStatus: BridgePermissionStatus | null = null;
  private listeners: Set<BridgeStatusListener> = new Set();

  constructor(options: BridgeServiceOptions = {}) {
    this.transport = options.transport ?? new WifiDevTransport();
    this.captureProvider = options.captureProvider ?? devCaptureProvider;
    this.getPermissionStatus = options.getPermissionStatus ?? null;
    this.isDevMode = options.isDevMode ?? true;
  }

  /** Replaces the active transport. Only allowed while not started. */
  setTransport(transport: BridgeTransport): void {
    if (this.state === 'ready' || this.state === 'capturePending' || this.state === 'starting') {
      throw new Error('Cannot replace transport while the bridge is running');
    }
    this.transport = transport;
  }

  async startDevBridge(): Promise<void> {
    if (this.state === 'ready' || this.state === 'starting') return;
    this.setState('starting');
    try {
      await this.transport.connect();
      this.transportUnsubscribe = this.transport.onMessage((message) => {
        // Fire-and-forget; errors are reported through capture.error replies.
        void this.handleIncomingMessage(message);
      });
      this.setState('ready');
    } catch (error) {
      this.lastErrorCode = 'BRIDGE_UNAVAILABLE';
      this.setState('error');
      throw error instanceof Error ? error : new Error('Bridge start failed');
    }
  }

  async stopBridge(): Promise<void> {
    if (this.transportUnsubscribe) {
      this.transportUnsubscribe();
      this.transportUnsubscribe = null;
    }
    this.queue.reset();
    try {
      await this.transport.disconnect();
    } finally {
      this.setState('stopped');
    }
  }

  /** Clears queue/error state without disconnecting the transport. */
  resetBridge(): void {
    this.queue.reset();
    this.lastErrorCode = null;
    this.lastMessageType = null;
    this.lastRequestId = null;
    if (this.state === 'capturePending' || this.state === 'error') {
      const connected = this.transport.getStatus().connectionState === 'connected';
      this.setState(connected ? 'ready' : 'idle');
    } else {
      this.notify();
    }
  }

  /**
   * Creates a local capture.request so the UI can exercise the full flow
   * without glasses hardware. Returns the outbound response message.
   */
  async simulateGlassesCaptureRequest(): Promise<CaptureSuccessMessage | CaptureErrorMessage> {
    simulatedRequestCounter += 1;
    const request: CaptureRequestMessage = {
      type: CAPTURE_REQUEST_TYPE,
      requestId: `sim-${simulatedRequestCounter}-${Math.random().toString(36).slice(2, 8)}`,
      source: 'glasses-web',
      createdAt: new Date().toISOString(),
    };
    return this.processCaptureRequest(request, { sendViaTransport: false });
  }

  /** Entry point for messages arriving from the transport. */
  async handleIncomingMessage(message: BridgeMessage): Promise<void> {
    this.lastMessageType = message.type;
    this.lastRequestId = message.requestId;
    this.notify();

    if (message.type === CAPTURE_REQUEST_TYPE) {
      await this.processCaptureRequest(message, { sendViaTransport: true });
      return;
    }

    // capture.success / capture.error answer an app-initiated request.
    if (message.type === CAPTURE_SUCCESS_TYPE) {
      try {
        const image = validateBridgePayload(message.image);
        this.queue.resolveRequest(message.requestId, image);
      } catch {
        this.queue.rejectRequest(
          message.requestId,
          'INVALID_CAPTURE_RESPONSE',
          'Capture response payload failed validation'
        );
        this.lastErrorCode = 'INVALID_CAPTURE_RESPONSE';
        this.notify();
      }
      return;
    }

    if (message.type === CAPTURE_ERROR_TYPE) {
      this.queue.rejectRequest(message.requestId, message.code, message.message);
      this.lastErrorCode = message.code;
      this.notify();
    }
  }

  /** Sends a message over the active transport. */
  async sendMessage(message: BridgeMessage): Promise<void> {
    await this.transport.send(message);
    this.lastMessageType = message.type;
    this.lastRequestId = message.requestId;
    this.notify();
  }

  async refreshPermissions(): Promise<BridgePermissionStatus | null> {
    if (!this.getPermissionStatus) return this.permissionStatus;
    this.permissionStatus = await this.getPermissionStatus();
    this.notify();
    return this.permissionStatus;
  }

  getStatus(): BridgeStatus {
    let wifiStatus: BridgeTransportStatus | null = null;
    if (this.transport.kind === 'wifi-dev' || this.transport.kind === 'mock') {
      wifiStatus = this.transport.getStatus();
    }
    return {
      bridgeState: this.state,
      activeTransport: this.transport.name,
      isDevMode: this.isDevMode,
      lastMessageType: this.lastMessageType,
      lastRequestId: this.lastRequestId,
      lastErrorCode: this.lastErrorCode,
      datStatus: this.datAdapter.getStatus(),
      bluetoothStatus: this.bluetoothAdapter.getStatus(),
      wifiStatus,
      permissionStatus: this.permissionStatus,
      updatedAt: new Date().toISOString(),
    };
  }

  subscribe(listener: BridgeStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async processCaptureRequest(
    request: CaptureRequestMessage,
    options: { sendViaTransport: boolean }
  ): Promise<CaptureSuccessMessage | CaptureErrorMessage> {
    let response: CaptureSuccessMessage | CaptureErrorMessage;

    try {
      const active = this.queue.createRequest({
        requestId: request.requestId,
        timeoutMs: request.timeoutMs,
      });
      this.setState('capturePending');

      // Run the dev capture provider and settle the queue entry by id.
      void this.captureProvider
        .capture()
        .then((raw) => {
          try {
            const image = validateBridgePayload(raw);
            this.queue.resolveRequest(active.requestId, image);
          } catch {
            this.queue.rejectRequest(
              active.requestId,
              'INVALID_CAPTURE_RESPONSE',
              'Dev capture provider returned an invalid payload'
            );
          }
        })
        .catch(() => {
          this.queue.rejectRequest(
            active.requestId,
            'NATIVE_CAPTURE_FAILED',
            'Dev capture provider failed'
          );
        });

      const image = await active.promise;
      response = {
        type: CAPTURE_SUCCESS_TYPE,
        requestId: request.requestId,
        image,
        mime: 'image/jpeg',
        encoding: 'data-url',
        createdAt: new Date().toISOString(),
      };
      this.lastMessageType = CAPTURE_SUCCESS_TYPE;
    } catch (error) {
      const code: BridgeErrorCode =
        error instanceof CaptureQueueError ? error.code : 'NATIVE_CAPTURE_FAILED';
      // Static message only — never error text derived from payload data.
      response = {
        type: CAPTURE_ERROR_TYPE,
        requestId: request.requestId,
        code,
        message: `Capture failed with code ${code}`,
        createdAt: new Date().toISOString(),
      };
      this.lastErrorCode = code;
      this.lastMessageType = CAPTURE_ERROR_TYPE;
    }

    this.lastRequestId = request.requestId;
    if (this.queue.getSnapshot().state === 'pending') {
      // Another capture is still in flight (e.g. this one was rejected
      // with CAPTURE_ALREADY_PENDING) — keep capturePending.
      this.setState('capturePending');
    } else {
      const connected = this.transport.getStatus().connectionState === 'connected';
      this.setState(connected ? 'ready' : 'idle');
    }

    if (options.sendViaTransport) {
      try {
        await this.transport.send(response);
      } catch {
        this.lastErrorCode = 'HANDOFF_FAILED';
        this.notify();
      }
    }

    this.notify();
    return response;
  }

  private setState(state: BridgeState): void {
    this.state = state;
    this.notify();
  }

  private notify(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) {
      listener(status);
    }
  }
}
