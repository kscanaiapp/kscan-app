// Allowlisted Elise visual-attachment telemetry.
// Failure must never block send, rendering, or cleanup.

export type EliseAttachmentTelemetryEvent = {
  attachmentSourceCounts: Record<string, number>;
  attachmentCount: number;
  directImageCount: number;
  attachmentsResolved: number;
  attachmentsRejected: number;
  preparationOutcome: string;
  transportOutcome: string;
  resolutionOutcome: string;
  sendOutcome: string;
  latencyMs: number;
  contractVersion: string;
  deduplicatedAttachmentCount: number;
  failureCode?: string | null;
};

export type EliseAttachmentFailureCode =
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'INVALID_SHAPE'
  | 'PREPARATION_FAILED'
  | 'UPLOAD_FAILED'
  | 'RESOLUTION_FAILED'
  | 'DUPLICATE_REMOVED';

const ALLOWED_FAILURE_CODES = new Set<string>([
  'UNAUTHORIZED',
  'NOT_FOUND',
  'EXPIRED',
  'INVALID_SHAPE',
  'PREPARATION_FAILED',
  'UPLOAD_FAILED',
  'RESOLUTION_FAILED',
  'DUPLICATE_REMOVED',
]);

export function sanitizeAttachmentFailureCode(raw: unknown): EliseAttachmentFailureCode | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (ALLOWED_FAILURE_CODES.has(code)) return code as EliseAttachmentFailureCode;

  // Map sanitized backend classifications → stable internal codes.
  if (code.includes('NOT_OWNED') || code.includes('UNAUTHORIZED')) return 'UNAUTHORIZED';
  if (code.includes('NOT_FOUND') || code.includes('UNAVAILABLE')) return 'NOT_FOUND';
  if (code.includes('EXPIRED')) return 'EXPIRED';
  if (code.includes('INVALID')) return 'INVALID_SHAPE';
  if (code.includes('PREPAR')) return 'PREPARATION_FAILED';
  if (code.includes('UPLOAD') || code.includes('MEDIA')) return 'UPLOAD_FAILED';
  if (code.includes('RESOLV')) return 'RESOLUTION_FAILED';
  if (code.includes('DUPLICATE')) return 'DUPLICATE_REMOVED';
  return null;
}

type TelemetrySink = (eventName: string, payload: Record<string, unknown>) => void;

let sink: TelemetrySink | null = null;

/** Test-only / optional sink registration. */
export function setEliseAttachmentTelemetrySink(next: TelemetrySink | null): void {
  sink = next;
}

export function trackEliseAttachmentTelemetry(
  eventName: string,
  event: Partial<EliseAttachmentTelemetryEvent>,
): void {
  try {
    const payload: Record<string, unknown> = {
      attachmentCount: event.attachmentCount ?? 0,
      directImageCount: event.directImageCount ?? 0,
      attachmentsResolved: event.attachmentsResolved ?? 0,
      attachmentsRejected: event.attachmentsRejected ?? 0,
      preparationOutcome: event.preparationOutcome ?? 'unknown',
      transportOutcome: event.transportOutcome ?? 'unknown',
      resolutionOutcome: event.resolutionOutcome ?? 'unknown',
      sendOutcome: event.sendOutcome ?? 'unknown',
      latencyMs: event.latencyMs ?? 0,
      contractVersion: event.contractVersion ?? '2',
      deduplicatedAttachmentCount: event.deduplicatedAttachmentCount ?? 0,
    };
    if (event.attachmentSourceCounts) {
      payload.attachmentSourceCounts = { ...event.attachmentSourceCounts };
    }
    const failureCode = sanitizeAttachmentFailureCode(event.failureCode);
    if (failureCode) payload.failureCode = failureCode;
    sink?.(eventName, payload);
  } catch {
    // Telemetry must never block composer flows.
  }
}
