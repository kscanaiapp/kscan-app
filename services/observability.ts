import Constants from 'expo-constants';
import * as ExpoCrypto from 'expo-crypto';
import { Platform } from 'react-native';
import {
  ALLOWED_CONTEXT_KEYS,
  buildObservabilityContext as buildSafeContext,
  isSensitiveObservabilityKey as isSensitiveKey,
  redactObservabilityValue as redactValue,
} from './observabilityRedaction';

export const REQUEST_ID_HEADER = 'X-KScan-Request-ID';
export const TRACEPARENT_HEADER = 'traceparent';
export const OBSERVABILITY_CONTRACT_VERSION = 'build29-observability-v1';

const REQUEST_ID_RE = /^ksr_[a-f0-9]{32}$/;
const TRACEPARENT_RE = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/;
type SafeScalar = string | number | boolean | null;
export type ObservabilityContext = Record<string, SafeScalar>;
export type CorrelationContext = {
  requestId: string;
  traceparent: string;
  traceId: string;
  epoch: number;
};

type ObservabilitySink = (eventName: string, context: ObservabilityContext) => void;

export { ALLOWED_CONTEXT_KEYS };

export function isSensitiveObservabilityKey(key: string): boolean {
  return isSensitiveKey(key);
}

export function redactObservabilityValue(value: unknown, depth = 0): unknown {
  return redactValue(value, depth);
}

export function buildObservabilityContext(input: Record<string, unknown>): ObservabilityContext {
  return buildSafeContext(input) as ObservabilityContext;
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

// A monitoring provider must MIRROR K Scan correlation identity, never mint its
// own. Observers are notified after the canonical context is built so a
// provider adapter can tag its events with the same request/trace ids that
// already travel on X-KScan-Request-ID and traceparent.
type CorrelationObserver = (context: CorrelationContext) => void;

let correlationObserver: CorrelationObserver | null = null;

export function setCorrelationObserver(next: CorrelationObserver | null): void {
  correlationObserver = typeof next === 'function' ? next : null;
}

export function createCorrelationContext(input: {
  requestId?: unknown;
  traceparent?: unknown;
} = {}): CorrelationContext {
  const requestId = isValidRequestId(input.requestId) ? input.requestId : createRequestId();
  const traceparent = isValidTraceparent(input.traceparent)
    ? input.traceparent.toLowerCase()
    : createTraceparent();
  const context = {
    requestId,
    traceparent,
    traceId: TRACEPARENT_RE.exec(traceparent)?.[1] ?? '',
    epoch: correlationEpoch,
  };
  try {
    correlationObserver?.(context);
  } catch {
    // A provider must never break request correlation.
  }
  return context;
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

// A breadcrumb is not an error report. Breadcrumbs only travel attached to a
// later event, so a failure that produces no subsequent event is never seen at
// all. Paths that end a user's session — a caught render error puts the app on
// the error screen — must therefore raise an event of their own.
type ExceptionSink = (error: unknown, context: ObservabilityContext) => void;

let exceptionSink: ExceptionSink | null = null;

export function setExceptionSink(next: ExceptionSink | null): void {
  exceptionSink = typeof next === 'function' ? next : null;
}

/**
 * Report a handled failure that the app recovered from but the user still felt.
 *
 * Deliberately NOT wired into `logError`: that is called from ordinary catch
 * blocks across the app and would turn recoverable, already-handled conditions
 * into an event storm. Reserve this for terminal paths.
 */
export function captureHandledException(
  error: unknown,
  input: Record<string, unknown> = {},
): void {
  try {
    const context = createMobileObservabilityContext(input);
    emitObservabilityEvent('mobile.handled_exception', input);
    exceptionSink?.(error, context);
  } catch {
    // Observability must not alter product behavior.
  }
}

export function emitObservabilityEvent(eventName: string, input: Record<string, unknown> = {}): void {
  try {
    if (!/^[a-z0-9_.:-]{1,80}$/.test(eventName)) return;
    sink(eventName, createMobileObservabilityContext(input));
  } catch {
    // Observability must not alter product behavior.
  }
}
