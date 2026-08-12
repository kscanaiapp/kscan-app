export const REQUEST_ID_HEADER = 'X-KScan-Request-ID';
export const TRACEPARENT_HEADER = 'traceparent';

const REQUEST_ID_RE = /^ksr_[a-f0-9]{32}$/;
const TRACEPARENT_RE = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/;
const SAFE_TOKEN_RE = /^[A-Za-z0-9_.:/-]{1,160}$/;
const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_FRAGMENTS = [
  'authorization', 'cookie', 'token', 'jwt', 'password', 'secret', 'api_key',
  'apikey', 'email', 'phone', 'prompt', 'message', 'chat', 'conversation',
  'image', 'photo', 'uri', 'signed_url', 'storage_path', 'latitude', 'longitude',
  'face', 'base64', 'access_token', 'refresh_token', 'sql',
];

const BACKEND_ALLOWED_KEYS = new Set([
  'request_id', 'trace_id', 'function_name', 'release_id', 'source_sha',
  'environment', 'method', 'operation', 'status_code', 'duration_ms',
  'error_category', 'retry_count', 'fallback_used', 'provider', 'model_family',
  'response_status', 'normalized_failure_type', 'row_count_bucket',
]);

export type BackendRequestContext = {
  requestId: string;
  traceparent: string;
  traceId: string;
  functionName: string;
  releaseId: string | null;
  sourceSha: string | null;
  environment: string;
  method: string;
};

export type BackendAttribution = {
  releaseId?: string;
  sourceSha?: string;
  environment?: string;
};

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9_]/g, '');
}

export function isSensitiveObservabilityKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

export function redactObservabilityValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (
      /bearer\s+/i.test(value) ||
      /data:image\//i.test(value) ||
      /eyJ[A-Za-z0-9_-]+\./.test(value) ||
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(value) ||
      /https?:\/\/[^\s]+[?&](?:token|signature|key)=/i.test(value) ||
      /\+?\d[\d\s().-]{7,}\d/.test(value)
    ) {
      return REDACTED;
    }
    return value.slice(0, 160);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 24).map((item) => redactObservabilityValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const safe: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, 48)) {
      safe[key] = isSensitiveObservabilityKey(key)
        ? REDACTED
        : redactObservabilityValue(nested, depth + 1);
    }
    return safe;
  }
  return undefined;
}

function randomHex(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values).map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function createRequestId(): string {
  return `ksr_${randomHex(16)}`;
}

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_RE.test(value);
}

export function isValidTraceparent(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = TRACEPARENT_RE.exec(value.trim().toLowerCase());
  return Boolean(match && !/^0+$/.test(match[1]) && !/^0+$/.test(match[2]));
}

export function createTraceparent(): string {
  let traceId = randomHex(16);
  let parentId = randomHex(8);
  if (/^0+$/.test(traceId)) traceId = `1${traceId.slice(1)}`;
  if (/^0+$/.test(parentId)) parentId = `1${parentId.slice(1)}`;
  return `00-${traceId}-${parentId}-01`;
}

function safeEnvironment(value: string | undefined): string {
  const normalized = String(value || '').trim().toLowerCase();
  return ['development', 'staging', 'production'].includes(normalized) ? normalized : 'unknown';
}

function safeIdentity(value: string | undefined, pattern: RegExp): string | null {
  const normalized = String(value || '').trim();
  return pattern.test(normalized) ? normalized : null;
}

function readEnvironmentVariable(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    // Unit tests and restricted runtimes can intentionally deny environment access.
    return undefined;
  }
}

export function createBackendRequestContext(
  req: Request,
  functionName: string,
  attribution: BackendAttribution = {},
): BackendRequestContext {
  const incomingRequestId = req.headers.get(REQUEST_ID_HEADER);
  const incomingTraceparent = req.headers.get(TRACEPARENT_HEADER);
  const requestId = isValidRequestId(incomingRequestId) ? incomingRequestId : createRequestId();
  const traceparent = isValidTraceparent(incomingTraceparent)
    ? incomingTraceparent.toLowerCase()
    : createTraceparent();
  return {
    requestId,
    traceparent,
    traceId: TRACEPARENT_RE.exec(traceparent)?.[1] ?? '',
    functionName: String(functionName || 'unknown').slice(0, 80),
    releaseId: safeIdentity(
      attribution.releaseId ?? readEnvironmentVariable('KSCAN_RELEASE_ID'),
      /^[A-Za-z0-9._-]{1,120}$/,
    ),
    sourceSha: safeIdentity(
      attribution.sourceSha ?? readEnvironmentVariable('KSCAN_SOURCE_SHA'),
      /^[a-f0-9]{40}$/,
    ),
    environment: safeEnvironment(
      attribution.environment ?? readEnvironmentVariable('KSCAN_ENVIRONMENT'),
    ),
    method: String(req.method || 'UNKNOWN').slice(0, 12),
  };
}

export function buildSafeBackendMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (!BACKEND_ALLOWED_KEYS.has(key) || isSensitiveObservabilityKey(key)) continue;
    if (value === null || typeof value === 'boolean') safe[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === 'string') {
      const bounded = value.slice(0, 160);
      if (SAFE_TOKEN_RE.test(bounded)) safe[key] = bounded;
    }
  }
  return safe;
}

export function requestMetadata(
  context: BackendRequestContext,
  input: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildSafeBackendMetadata({
    request_id: context.requestId,
    trace_id: context.traceId,
    function_name: context.functionName,
    release_id: context.releaseId,
    source_sha: context.sourceSha,
    environment: context.environment,
    method: context.method,
    ...input,
  });
}

export function emitBackendObservability(
  eventName: string,
  context: BackendRequestContext,
  input: Record<string, unknown> = {},
): void {
  try {
    if (!/^[a-z0-9_.:-]{1,80}$/.test(eventName)) return;
    console.log(`[kscan-observability] ${eventName} ${JSON.stringify(requestMetadata(context, input))}`);
  } catch {
    // Observability is fail-open and content-blind.
  }
}

export async function withCorrelationResponse(
  response: Response,
  context: BackendRequestContext,
): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set(REQUEST_ID_HEADER, context.requestId);
  headers.set(TRACEPARENT_HEADER, context.traceparent);
  headers.set('Access-Control-Expose-Headers', `${REQUEST_ID_HEADER}, ${TRACEPARENT_HEADER}`);

  const contentType = headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  const bodyText = await response.text();
  try {
    const parsed = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return new Response(JSON.stringify(parsed), { status: response.status, statusText: response.statusText, headers });
    }
    return new Response(JSON.stringify({
      ...parsed,
      correlation: { requestId: context.requestId, traceId: context.traceId },
    }), { status: response.status, statusText: response.statusText, headers });
  } catch {
    return new Response(bodyText, { status: response.status, statusText: response.statusText, headers });
  }
}

export async function observeEdgeRequest(
  req: Request,
  functionName: string,
  handler: (context: BackendRequestContext) => Promise<Response>,
): Promise<Response> {
  const context = createBackendRequestContext(req, functionName);
  const startedAt = Date.now();
  emitBackendObservability('request_started', context, { operation: 'edge_request' });
  try {
    const response = await handler(context);
    emitBackendObservability('request_completed', context, {
      operation: 'edge_request',
      status_code: response.status,
      duration_ms: Date.now() - startedAt,
    });
    return await withCorrelationResponse(response, context);
  } catch (error) {
    emitBackendObservability('request_failed', context, {
      operation: 'edge_request',
      status_code: 500,
      duration_ms: Date.now() - startedAt,
      error_category: error instanceof Error ? error.name : 'unknown_error',
    });
    throw error;
  }
}
