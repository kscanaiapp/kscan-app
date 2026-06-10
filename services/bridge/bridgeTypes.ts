/**
 * K Scan app-level bridge message contract (Phase 16 alpha).
 *
 * IMPORTANT SCOPE NOTES:
 * - This is the K Scan app-level bridge contract between the K Scan mobile
 *   app and the K Scan glasses web app / dev tooling.
 * - This is NOT a verified Meta platform contract.
 * - The native Meta DAT transport remains UNKNOWN. No DAT method names,
 *   Bluetooth services/characteristics, or native bridge object names are
 *   verified, and none are defined here.
 * - Bluetooth/Wi-Fi production transport remains adapter-specific; only the
 *   Wi-Fi dev transport and a mock loopback transport are implemented in
 *   this phase.
 * - `HANDOFF_FAILED` means the transfer of a captured image to the bridge
 *   consumer failed (app-level handoff), not a Meta-defined error.
 *
 * PAYLOAD SIZE NOTE:
 * - No maximum payload size is defined in this phase.
 * - Future phases must account for WebSocket frame limits, Bluetooth
 *   MTU/chunking, Meta DAT payload limits, and compression/chunking.
 * - Do not implement chunking in this phase.
 */

export const CAPTURE_REQUEST_TYPE = 'capture.request';
export const CAPTURE_SUCCESS_TYPE = 'capture.success';
export const CAPTURE_ERROR_TYPE = 'capture.error';

/** Glasses/web -> mobile: ask the mobile app to perform a capture. */
export type CaptureRequestMessage = {
  type: 'capture.request';
  requestId: string;
  source: 'glasses-web';
  createdAt: string;
  timeoutMs?: number;
};

/** Mobile -> glasses/web: capture succeeded; image is a JPEG data URL. */
export type CaptureSuccessMessage = {
  type: 'capture.success';
  requestId: string;
  image: string;
  mime: 'image/jpeg';
  encoding: 'data-url';
  createdAt: string;
};

export const BRIDGE_ERROR_CODES = [
  'BRIDGE_UNAVAILABLE',
  'PERMISSION_DENIED',
  'CAPTURE_CANCELLED',
  'CAPTURE_TIMEOUT',
  'CAPTURE_ALREADY_PENDING',
  'INVALID_CAPTURE_RESPONSE',
  'DAT_NOT_CONFIGURED',
  'BLUETOOTH_NOT_CONFIGURED',
  'NATIVE_CAPTURE_FAILED',
  'HANDOFF_FAILED',
] as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

/** Mobile -> glasses/web: capture failed with a structured error code. */
export type CaptureErrorMessage = {
  type: 'capture.error';
  requestId: string;
  code: BridgeErrorCode;
  message: string;
  createdAt: string;
};

export type BridgeMessage =
  | CaptureRequestMessage
  | CaptureSuccessMessage
  | CaptureErrorMessage;

export function isBridgeErrorCode(value: unknown): value is BridgeErrorCode {
  return (
    typeof value === 'string' &&
    (BRIDGE_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Structural check that a parsed object looks like a bridge message.
 * Does not validate image payload contents (see validateBridgePayload).
 */
export function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (value === null || typeof value !== 'object') return false;
  const msg = value as { type?: unknown; requestId?: unknown };
  if (typeof msg.requestId !== 'string' || msg.requestId.length === 0) {
    return false;
  }
  return (
    msg.type === CAPTURE_REQUEST_TYPE ||
    msg.type === CAPTURE_SUCCESS_TYPE ||
    msg.type === CAPTURE_ERROR_TYPE
  );
}
