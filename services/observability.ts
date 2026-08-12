import Constants from 'expo-constants';
import * as ExpoCrypto from 'expo-crypto';
import { Platform } from 'react-native';

export const REQUEST_ID_HEADER = 'X-KScan-Request-ID';
export const TRACEPARENT_HEADER = 'traceparent';
export const OBSERVABILITY_CONTRACT_VERSION = 'build29-observability-v1';

const REQUEST_ID_RE = /^ksr_[a-f0-9]{32}$/;
const TRACEPARENT_RE = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/;
const SAFE_TOKEN_RE = /^[A-Za-z0-9_.:/-]{1,160}$/;
const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_FRAGMENTS = [
  'authorization', 'cookie', 'token', 'jwt', 'password', 'secret', 'api_key',
  'apikey', 'email', 'phone', 'prompt', 'message', 'chat', 'conversation',
  'image', 'photo', 'uri', 'signed_url', 'storage_path', 'latitude', 'longitude',
  'face', 'base64', 'access_token', 'refresh_token',
];

const ALLOWED_CONTEXT_KEYS = new Set([
  'release_id', 'source_sha', 'environment', 'platform', 'app_version', 'build',
  'screen', 'operation', 'request_id', 'trace_id', 'error_category',
  'provider_category', 'fallback_used', 'duration_bucket', 'network_category',
  'function_name', 'status_code', 'retry_count',
]);

type SafeScalar = string | number | boolean | null;
export type ObservabilityContext = Record<string, SafeScalar>;
export type CorrelationContext = {
  requestId: string;
  traceparent: string;
  traceId: string;
  epoch: number;
};

type ObservabilitySink = (eventName: string, context: ObservabilityContext) => void;

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

function safeScalar(value: unknown): SafeScalar | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const redacted = redactObservabilityValue(value);
    if (redacted === REDACTED) return REDACTED;
    const bounded = String(redacted).slice(0, 160);
    return SAFE_TOKEN_RE.test(bounded) ? bounded : undefined;
  }
  return undefined;
}

export function buildObservabilityContext(input: Record<string, unknown>): ObservabilityContext {
  const safe: ObservabilityContext = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (!ALLOWED_CONTEXT_KEYS.has(key) || isSensitiveObservabilityKey(key)) continue;
    const scalar = safeScalar(value);
    if (scalar !== undefined) safe[key] = scalar;
  }
  return safe;
}

function randomHex(bytes: number): string {
  return Array.from(ExpoCrypto.getRandomBytes(bytes))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
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

let correlationEpoch = 0;

export function resetCorrelationContext(): void {
  correlationEpoch += 1;
}

export function createCorrelationContext(input: {
  requestId?: unknown;
  traceparent?: unknown;
} = {}): CorrelationContext {
  const requestId = isValidRequestId(input.requestId) ? input.requestId : createRequestId();
  const traceparent = isValidTraceparent(input.traceparent)
    ? input.traceparent.toLowerCase()
    : createTraceparent();
  return {
    requestId,
    traceparent,
    traceId: TRACEPARENT_RE.exec(traceparent)?.[1] ?? '',
    epoch: correlationEpoch,
  };
}

export function correlationHeaders(context: CorrelationContext): Record<string, string> {
  return {
    [REQUEST_ID_HEADER]: context.requestId,
    [TRACEPARENT_HEADER]: context.traceparent,
  };
}

function mobileBuildIdentity() {
  const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined;
  const observability = extra?.observability as Record<string, unknown> | undefined;
  const platformBuild = Platform.OS === 'ios'
    ? Constants.platform?.ios?.buildNumber
    : Platform.OS === 'android'
      ? Constants.platform?.android?.versionCode
      : null;
  return {
    release_id: observability?.releaseId ?? null,
    source_sha: observability?.sourceSha ?? null,
    environment: observability?.environment ?? (__DEV__ ? 'development' : null),
    platform: Platform.OS,
    app_version: Constants.expoConfig?.version ?? null,
    build: platformBuild == null ? null : String(platformBuild),
  };
}

export function createMobileObservabilityContext(input: Record<string, unknown> = {}): ObservabilityContext {
  return buildObservabilityContext({ ...mobileBuildIdentity(), ...input });
}

const defaultSink: ObservabilitySink = (eventName, context) => {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.info('[K-SCAN Observability]', eventName, context);
  }
};

let sink: ObservabilitySink = defaultSink;

export function setObservabilitySink(next: ObservabilitySink | null): void {
  sink = typeof next === 'function' ? next : defaultSink;
}

export function emitObservabilityEvent(eventName: string, input: Record<string, unknown> = {}): void {
  try {
    if (!/^[a-z0-9_.:-]{1,80}$/.test(eventName)) return;
    sink(eventName, createMobileObservabilityContext(input));
  } catch {
    // Observability must not alter product behavior.
  }
}
