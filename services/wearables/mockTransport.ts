import type { WearableDeviceType, WearableSession, WearableTransport } from './types';
import type { ScanRequest } from '../scan-contract/request';
import type { ScanResponse } from '../scan-contract/response';
import { SCAN_CONTRACT_VERSION } from '../scan-contract/version';
import { buildScanResponse } from '../scan-contract/response';
import {
  fixtureBlackLeatherJacket,
  fixtureProviderTimeout,
} from '../scan-contract/fixtures';

export interface MockWearableTransportOptions {
  deviceType?: WearableDeviceType;
  sessionDurationMs?: number;
  artificialDelayMs?: number;
}

/**
 * Mock wearable transport for local development and testing.
 *
 * Uses only local fixtures. Never performs a network request, never requests
 * camera permission, never requests microphone permission, and never retains
 * an auth token.
 */
export class MockWearableTransport implements WearableTransport {
  private deviceType: WearableDeviceType;
  private sessionDurationMs: number;
  private artificialDelayMs: number;
  private session: WearableSession | null = null;
  private connected = false;

  constructor(options: MockWearableTransportOptions = {}) {
    this.deviceType = options.deviceType ?? 'wearable_mock';
    this.sessionDurationMs = options.sessionDurationMs ?? 300000; // 5 minutes
    this.artificialDelayMs = options.artificialDelayMs ?? 50;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const now = Date.now();
    this.session = {
      sessionId: `mock-session-${now.toString(36)}`,
      deviceType: this.deviceType,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.sessionDurationMs).toISOString(),
      capabilities: {
        camera: true,
        microphone: false,
        display: true,
        audioOutput: true,
      },
    };
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.session = null;
    this.connected = false;
  }

  getSession(): WearableSession | null {
    if (!this.session) return null;
    if (Date.now() > new Date(this.session.expiresAt).getTime()) {
      this.session = null;
      this.connected = false;
      return null;
    }
    return this.session;
  }

  async sendScanRequest(request: ScanRequest): Promise<ScanResponse> {
    if (!this.connected || !this.getSession()) {
      return this.errorResponse(request.requestId, 'AUTH_REQUIRED', 'No active wearable session.');
    }

    if (request.contractVersion !== SCAN_CONTRACT_VERSION) {
      return this.errorResponse(
        request.requestId,
        'INVALID_REQUEST',
        `Expected contract version ${SCAN_CONTRACT_VERSION}.`,
      );
    }

    // Simulate async transport latency.
    await this.delay(this.artificialDelayMs);

    // Fixture routing keyed off synthetic textQuery or a default success fixture.
    const trigger = (request.textQuery ?? '').toLowerCase().trim();
    if (trigger.includes('timeout') || trigger.includes('fail')) {
      return {
        ...fixtureProviderTimeout,
        requestId: request.requestId,
      };
    }
    if (trigger.includes('empty') || trigger.includes('no product')) {
      return buildScanResponse(request.requestId, 'success', {
        attributes: fixtureBlackLeatherJacket.attributes,
        products: [],
      });
    }

    return {
      ...fixtureBlackLeatherJacket,
      requestId: request.requestId,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private errorResponse(
    requestId: string,
    code: 'AUTH_REQUIRED' | 'INVALID_REQUEST',
    message: string,
  ): ScanResponse {
    return buildScanResponse(requestId, 'error', {
      error: { code, message },
    });
  }
}
