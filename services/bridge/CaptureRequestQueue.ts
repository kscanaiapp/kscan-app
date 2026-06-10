/**
 * Capture request queue (Phase 16 alpha).
 *
 * Manages the capture request lifecycle for the app-level bridge.
 * The bridge is synchronous request/response for now: only one active
 * capture request at a time, no FIFO/multi-request queueing. Responses
 * are matched by requestId, never by arrival order.
 *
 * Privacy rules:
 * - No raw image logging.
 * - No image persistence.
 * - No backend upload.
 * - Snapshots contain safe metadata only — never image payloads.
 */

import type { BridgeErrorCode } from './bridgeTypes.ts';

export const DEFAULT_CAPTURE_TIMEOUT_MS = 10_000;

export type CaptureQueueState = 'idle' | 'pending';

export type CaptureRequestOptions = {
  timeoutMs?: number;
  requestId?: string;
};

export type ActiveCaptureRequest = {
  requestId: string;
  createdAt: string;
  timeoutMs: number;
  /** Resolves with the validated image payload string. */
  promise: Promise<string>;
};

export type CaptureQueueSnapshot = {
  state: CaptureQueueState;
  activeRequestId: string | null;
  createdAt: string | null;
  timeoutMs: number | null;
  lastErrorCode: BridgeErrorCode | null;
  lastEvent:
    | 'created'
    | 'resolved'
    | 'rejected'
    | 'timeout'
    | 'reset'
    | null;
};

export class CaptureQueueError extends Error {
  code: BridgeErrorCode;
  requestId: string | null;

  constructor(code: BridgeErrorCode, message: string, requestId: string | null = null) {
    super(message);
    this.name = 'CaptureQueueError';
    this.code = code;
    this.requestId = requestId;
  }
}

type PendingEntry = {
  requestId: string;
  createdAt: string;
  timeoutMs: number;
  resolve: (image: string) => void;
  reject: (error: CaptureQueueError) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

let requestCounter = 0;

function generateRequestId(): string {
  requestCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `cap-${requestCounter}-${random}`;
}

export class CaptureRequestQueue {
  private pending: PendingEntry | null = null;
  private lastErrorCode: BridgeErrorCode | null = null;
  private lastEvent: CaptureQueueSnapshot['lastEvent'] = null;

  /**
   * Creates a new capture request. Rejects immediately (throws) with
   * CAPTURE_ALREADY_PENDING if another capture is already in flight.
   */
  createRequest(options: CaptureRequestOptions = {}): ActiveCaptureRequest {
    if (this.pending) {
      this.lastErrorCode = 'CAPTURE_ALREADY_PENDING';
      throw new CaptureQueueError(
        'CAPTURE_ALREADY_PENDING',
        'A capture request is already pending',
        this.pending.requestId
      );
    }

    const requestId = options.requestId ?? generateRequestId();
    const timeoutMs = options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
    const createdAt = new Date().toISOString();

    let resolveFn: (image: string) => void = () => {};
    let rejectFn: (error: CaptureQueueError) => void = () => {};

    const promise = new Promise<string>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    const entry: PendingEntry = {
      requestId,
      createdAt,
      timeoutMs,
      resolve: resolveFn,
      reject: rejectFn,
      timer: null,
    };

    entry.timer = setTimeout(() => {
      // Timer matches the active request by identity; a stale timer for a
      // replaced request can never fire because timers are always cleared
      // on resolve/reject/reset.
      if (this.pending !== entry) return;
      this.pending = null;
      this.lastErrorCode = 'CAPTURE_TIMEOUT';
      this.lastEvent = 'timeout';
      entry.reject(
        new CaptureQueueError('CAPTURE_TIMEOUT', 'Capture request timed out', requestId)
      );
    }, timeoutMs);

    this.pending = entry;
    this.lastEvent = 'created';

    return { requestId, createdAt, timeoutMs, promise };
  }

  /**
   * Resolves the active request if `requestId` matches.
   * Mismatched or stale requestIds are ignored safely (returns false).
   * The image must already be validated by validateBridgePayload upstream.
   */
  resolveRequest(requestId: string, image: string): boolean {
    const entry = this.pending;
    if (!entry || entry.requestId !== requestId) {
      return false;
    }
    this.clearTimer(entry);
    this.pending = null;
    this.lastEvent = 'resolved';
    entry.resolve(image);
    return true;
  }

  /**
   * Rejects the active request if `requestId` matches.
   * Mismatched or stale requestIds are ignored safely (returns false).
   */
  rejectRequest(requestId: string, errorCode: BridgeErrorCode, message: string): boolean {
    const entry = this.pending;
    if (!entry || entry.requestId !== requestId) {
      return false;
    }
    this.clearTimer(entry);
    this.pending = null;
    this.lastErrorCode = errorCode;
    this.lastEvent = 'rejected';
    entry.reject(new CaptureQueueError(errorCode, message, requestId));
    return true;
  }

  /** Clears any pending request, rejecting it with CAPTURE_CANCELLED. */
  reset(): void {
    const entry = this.pending;
    if (entry) {
      this.clearTimer(entry);
      this.pending = null;
      entry.reject(
        new CaptureQueueError('CAPTURE_CANCELLED', 'Capture queue was reset', entry.requestId)
      );
    }
    this.lastErrorCode = null;
    this.lastEvent = 'reset';
  }

  /** Safe metadata only — never includes image payloads. */
  getSnapshot(): CaptureQueueSnapshot {
    return {
      state: this.pending ? 'pending' : 'idle',
      activeRequestId: this.pending?.requestId ?? null,
      createdAt: this.pending?.createdAt ?? null,
      timeoutMs: this.pending?.timeoutMs ?? null,
      lastErrorCode: this.lastErrorCode,
      lastEvent: this.lastEvent,
    };
  }

  private clearTimer(entry: PendingEntry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }
}
