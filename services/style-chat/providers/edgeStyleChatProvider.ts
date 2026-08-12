// EdgeStyleChatProvider — mobile-side proxy to the stylechat-generate Edge Function.
//
// Fallback chain:
//   1. stylechat-generate Edge Function → Gemini Flash
//   2. On network error / timeout → returns error status with safe fallback content
//   3. MockStyleChatProvider remains importable for kill-switch-level fallback
//
// The mobile app sends only { sessionId, message }.
// All context assembly, quota enforcement, and Gemini calls happen server-side.

import { supabase } from '../../supabaseClient';
import { STYLE_CHAT_COPY, STYLE_CHAT_DAILY_MESSAGE_LIMIT } from '../../../constants/styleChat';
import {
  ELISE_ADVICE_METADATA_CLIENT_V1,
} from '../../../constants/featureFlags';
import { getFriendlyStyleChatError } from '../styleChatErrors';
import type { WeatherLocationInput } from '../../../constants/weatherStyling';
import type { StyleDnaContext } from '../../style-dna/styleDnaContext';
import type { StyleChatHandoffContext } from '../styleChatHandoffContext';
import {
  STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
  type StyleChatAttachment,
} from '../../../types/styleChatAttachments';
import type { EliseAdviceMetadataClient } from '../../../types/eliseAdvice';
import { prepareContextForTransport } from '../eliseFashionContextV2';
import {
  correlationHeaders,
  createCorrelationContext,
  emitObservabilityEvent,
} from '../../observability';

const EDGE_FN      = 'stylechat-generate';
export const ELISE_VISUAL_COLLECTION_CONTRACT_VERSION = '1';
// 30s: a complete response may make two sequential ~12s Gemini calls (frozen-map
// primary then fallback / incomplete-reply retry) plus auth/quota/context work.
// The client margin must exceed the worst-case sequential server budget so the
// app does not report a failure while the Edge Function is still succeeding.
const TIMEOUT_MS   = 30_000;

// ── Response contract ─────────────────────────────────────────────────────────

export type EdgeChatStatus =
  | 'success'
  | 'limit_reached'
  | 'burst_limit'
  | 'error'
  // Phase 2: the deployed backend did not acknowledge the v2 attachment
  // contract (or rejected the attachments). The caller must preserve the
  // draft (text + attachments) and must NOT display an attachment-blind reply
  // as though the model saw the attachments.
  | 'attachments_unsupported'
  | 'attachments_rejected'
  | 'visual_collection_unsupported'
  | 'visual_collection_rejected';

/** Validated structured action passed through from the v2 backend. */
export interface EdgeChatAction {
  type: string;
  label: string;
  contractVersion: string;
  payload: Record<string, unknown>;
}

export interface EdgeChatMessage {
  sender: 'assistant' | 'system';
  content: string;
  model: string;
  tokenEstimate: number;
  // Optional, additive explanation for concrete recommendations. Absent for
  // greetings, refusals, fallbacks, and older backend responses.
  whyThisWorks?: string;
}

export interface EdgeChatUsage {
  messagesUsed: number;
  messagesLimit: number;
  resetAt?: string;
}

export interface EdgeChatResult {
  status: EdgeChatStatus;
  message: EdgeChatMessage;
  usage: EdgeChatUsage;
  /** v2 only: validated structured actions (allowlisted server-side). */
  actions?: EdgeChatAction[];
  /** v2 only: safe error code for attachment failures. */
  errorCode?: string;
  /**
   * E-4 optional structured advice metadata.
   * Older clients ignore this field; text remains authoritative.
   * Applied only when ELISE_ADVICE_METADATA_CLIENT_V1 is enabled and object-shaped.
   */
  adviceMetadata?: EliseAdviceMetadataClient | Record<string, unknown>;
  adviceContractVersion?: string;
  /**
   * Optional compact weather context, present only when this turn actually
   * resolved live weather. Absent on every pre-deployment backend and on every
   * request that sent no location, was denied, timed out, or failed — so absence
   * is the normal case and must never be treated as an error.
   *
   * Deliberately left as `unknown`: the value crosses a trust boundary and is
   * validated by `parseWeatherContextWire` before use. Typing it as the parsed
   * shape here would let an unvalidated payload be read as if it were checked.
   */
  weatherContext?: unknown;
  weatherContextVersion?: number;
}

// ── Safe fallback ─────────────────────────────────────────────────────────────

const DEFAULT_USAGE: EdgeChatUsage = {
  messagesUsed: 0,
  messagesLimit: STYLE_CHAT_DAILY_MESSAGE_LIMIT,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The last gate before a canonical fashion context crosses the wire.
 *
 * Returns the ROUND-TRIPPED value, not the original object. That is deliberate:
 * what the backend receives is the serialized form, so the serialized form is
 * what must be validated and what must be sent. Returning the original would let
 * an object that only survives serialization by luck pass a check performed on a
 * different value.
 *
 * Returns null on any failure, and null means the field is simply omitted — the
 * request stays valid and the caller's own blocked-state handling decides whether
 * an image-backed message may be sent at all.
 */
export function toTransportableFashionContext(value: unknown): unknown | null {
  if (value == null) return null;
  const prepared = prepareContextForTransport(value);
  if (prepared.kind !== 'ok') return null;
  try {
    return JSON.parse(JSON.stringify(prepared.context));
  } catch {
    return null;
  }
}

/** Copy only descriptive fields that are safe to send to StyleChat. */
export function toServerSafeActiveContext(
  context: StyleChatHandoffContext,
): Omit<StyleChatHandoffContext, 'imageUri' | 'textScanId' | 'createdAt'> {
  const visual = context.visualContext;
  const visualCollection = context.visualCollection;
  return {
    source: context.source,
    ...(context.query != null ? { query: context.query } : {}),
    ...(context.category != null ? { category: context.category } : {}),
    ...(context.color != null ? { color: context.color } : {}),
    ...(context.silhouette != null ? { silhouette: context.silhouette } : {}),
    ...(context.material != null ? { material: context.material } : {}),
    ...(Array.isArray(context.descriptors) ? { descriptors: [...context.descriptors] } : {}),
    ...(context.analysisText != null ? { analysisText: context.analysisText } : {}),
    ...(visual
      ? {
          visualContext: {
            source: visual.source,
            title: visual.title,
            summary: visual.summary ?? null,
            category: visual.category ?? null,
            colors: visual.colors ? [...visual.colors] : null,
            materials: visual.materials ? [...visual.materials] : null,
            silhouette: visual.silhouette ?? null,
            styleAttributes: visual.styleAttributes ? [...visual.styleAttributes] : null,
            brand: visual.brand ?? null,
            confidence: visual.confidence ?? null,
          },
        }
      : {}),
    ...(visualCollection?.evidence?.length
      ? {
          visualCollection: {
            evidence: visualCollection.evidence.map((entry) => ({
              id: entry.id,
              order: entry.order,
              source: entry.source,
              title: entry.title,
              summary: entry.summary ?? null,
              category: entry.category ?? null,
              colors: entry.colors ? [...entry.colors] : null,
              materials: entry.materials ? [...entry.materials] : null,
              silhouette: entry.silhouette ?? null,
              styleAttributes: entry.styleAttributes ? [...entry.styleAttributes] : null,
              brand: entry.brand ?? null,
              confidence: entry.confidence ?? null,
            })),
            ...(visualCollection.focusEvidenceId
              ? { focusEvidenceId: visualCollection.focusEvidenceId }
              : {}),
          },
        }
      : {}),
  };
}

function normalizeStatus(status: unknown): EdgeChatStatus | null {
  return status === 'success'
    || status === 'limit_reached'
    || status === 'burst_limit'
    || status === 'error'
    || status === 'attachments_unsupported'
    || status === 'attachments_rejected'
    || status === 'visual_collection_unsupported'
    || status === 'visual_collection_rejected'
    ? status
    : null;
}

function normalizeUsage(value: unknown): EdgeChatUsage {
  if (!isRecord(value)) return DEFAULT_USAGE;

  const messagesUsed = typeof value.messagesUsed === 'number' && Number.isFinite(value.messagesUsed)
    ? Math.max(0, value.messagesUsed)
    : DEFAULT_USAGE.messagesUsed;
  const messagesLimit = typeof value.messagesLimit === 'number' && Number.isFinite(value.messagesLimit)
    ? Math.max(0, value.messagesLimit)
    : DEFAULT_USAGE.messagesLimit;

  return {
    messagesUsed,
    messagesLimit,
    resetAt: typeof value.resetAt === 'string' ? value.resetAt : undefined,
  };
}

function normalizeMessage(value: unknown, fallbackContent: string): EdgeChatMessage {
  const raw = isRecord(value) ? value : {};
  const content = typeof raw.content === 'string' && raw.content.trim().length > 0
    ? raw.content
    : fallbackContent;

  // Additive, optional. Only surfaced when the backend sends a non-empty string.
  const whyThisWorks = typeof raw.why_this_works === 'string' && raw.why_this_works.trim().length > 0
    ? raw.why_this_works.trim()
    : undefined;

  return {
    sender: raw.sender === 'system' ? 'system' : 'assistant',
    content,
    model: typeof raw.model === 'string' ? raw.model : '',
    tokenEstimate: typeof raw.tokenEstimate === 'number' && Number.isFinite(raw.tokenEstimate)
      ? raw.tokenEstimate
      : 0,
    ...(whyThisWorks ? { whyThisWorks } : {}),
  };
}

function fallbackResult(
  overrides?: Partial<EdgeChatMessage>,
  errorCode = 'STYLECHAT_OPERATIONAL_FAILURE',
): EdgeChatResult {
  return {
    status: 'error',
    message: {
      sender: 'assistant',
      content: STYLE_CHAT_COPY.errorGeneric,
      model: 'fallback',
      tokenEstimate: 0,
      ...overrides,
    },
    usage: DEFAULT_USAGE,
    errorCode,
  };
}

function getFunctionHttpStatus(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const context = error.context;
  if (!isRecord(context)) return null;
  return typeof context.status === 'number' && Number.isFinite(context.status)
    ? context.status
    : null;
}

function logHandledOperationalFailure(category: string) {
  if (__DEV__) console.info('[EdgeStyleChatProvider] handled operational failure:', category);
}

function isExpectedNetworkFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return (
    message.includes('network request failed') ||
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('offline') ||
    message.includes('internet')
  );
}

function limitResult(message: string, usage: unknown): EdgeChatResult {
  return {
    status: 'limit_reached',
    message: {
      sender: 'assistant',
      content: message,
      model: '',
      tokenEstimate: 0,
    },
    usage: normalizeUsage(usage),
  };
}

function burstLimitResult(message: string, usage: unknown): EdgeChatResult {
  return {
    status: 'burst_limit',
    message: {
      sender: 'assistant',
      content: message,
      model: '',
      tokenEstimate: 0,
    },
    usage: normalizeUsage(usage),
  };
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class EdgeStyleChatProvider {
  private readonly timeoutMs: number;

  constructor(timeoutMs = TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  async generateReply(input: {
    sessionId: string;
    message: string;
    weatherLocation?: WeatherLocationInput | null;
    styleDnaContext?: StyleDnaContext | null;
    activeContext?: StyleChatHandoffContext | null;
    sourceMessageId?: string | null;
    /** v2 (Closet Intelligence): READY resolved references only — never local ids. */
    attachments?: StyleChatAttachment[] | null;
    contextHint?: string | null;
    /**
     * Canonical Elise fashion identity (Phase 2B.3).
     *
     * Additive and INDEPENDENT of `attachments`: a reused Scanner or Recent Scan
     * identity carries no new attachment reference, and a Closet attachment
     * carries a reference with no fresh identification. Tying the two together
     * would make one of those cases unsendable.
     */
    fashionContextV2?: unknown;
  }): Promise<EdgeChatResult> {
    const ac        = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), this.timeoutMs);
    const hasAttachments = Array.isArray(input.attachments) && input.attachments.length > 0;
    const hasVisualCollection = Boolean(input.activeContext?.visualCollection?.evidence?.length);
    // Verified serializable before transport. A context carrying a function, a
    // ref, a setter or an AbortController would be silently mangled by
    // JSON.stringify and arrive at the backend missing required fields; refusing
    // it here keeps that from becoming a server-side validation failure.
    const fashionContext = toTransportableFashionContext(input.fashionContextV2);
    const correlation = createCorrelationContext();

    try {
      const { data, error } = await supabase.functions.invoke<EdgeChatResult>(EDGE_FN, {
        body: {
          sessionId: input.sessionId,
          message: input.message,
          ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
          // Additive/optional: sent only when weather-aware styling is enabled and a
          // rounded foreground fix is available. Requests without it stay valid.
          ...(input.weatherLocation && input.weatherLocation.enabled
            ? { weatherLocation: input.weatherLocation }
            : {}),
          // Additive/optional Style DNA personalization signal (Phase 2). Sent only
          // when the client built a flag-on, above-threshold context. Requests without
          // it stay valid; the Edge Function treats a missing field as pre-Phase 2.
          ...(input.styleDnaContext && input.styleDnaContext.enabled
            ? { styleDnaContext: input.styleDnaContext }
            : {}),
          // Additive/optional active scan/upload/TextScan context. Sent while the user
          // has a visible context card in StyleChat. Requests without it stay valid.
          ...(input.activeContext
            ? { activeContext: toServerSafeActiveContext(input.activeContext) }
            : {}),
          // v2 Closet attachments: contractVersion is sent ONLY with attachments so
          // attachment-free requests remain exact v1 shapes.
          ...(hasAttachments
            ? {
                attachments: input.attachments,
                contractVersion: STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
                ...(input.contextHint ? { contextHint: input.contextHint } : {}),
              }
            : {}),
          // Phase 2B.3 — canonical fashion identity. Present ONLY when the caller
          // actually supplied one, so a text-only request stays a byte-for-byte v1
          // body and no existing request shape changes.
          ...(fashionContext ? { fashionContextV2: fashionContext } : {}),
        },
        headers: correlationHeaders(correlation),
        signal: ac.signal,
      });

      if (error) {
        emitObservabilityEvent('elise.request_failed', {
          operation: 'stylechat_generate',
          request_id: correlation.requestId,
          trace_id: correlation.traceId,
          error_category: 'invoke_error',
        });
        const httpStatus = getFunctionHttpStatus(error);
        // The Supabase functions-js SDK wraps non-2xx responses as FunctionsHttpError
        // with the raw (unconsumed) Response in error.context. Attempt to parse a
        // structured burst_limit body from a 429 before falling back to generic error.
        const ctx = (error as Record<string, unknown>).context;
        if (ctx != null && typeof (ctx as Response).json === 'function') {
          try {
            const body = await (ctx as Response).json() as unknown;
            if (isRecord(body)) {
              const status = normalizeStatus(body.status);
              const bodyMessage = isRecord(body.message) ? body.message : {};
              const bodyContent = typeof bodyMessage.content === 'string' ? bodyMessage.content : '';
              if (
                hasVisualCollection &&
                typeof body.errorCode === 'string' &&
                body.errorCode.startsWith('VISUAL_COLLECTION_')
              ) {
                return {
                  status: 'visual_collection_rejected',
                  errorCode: body.errorCode,
                  message: { sender: 'assistant', content: '', model: '', tokenEstimate: 0 },
                  usage: DEFAULT_USAGE,
                };
              }
              // v2: safe structured attachment failures (400/403/404 with errorCode).
              if (hasAttachments && typeof body.errorCode === 'string' && body.errorCode.length > 0) {
                return {
                  status: 'attachments_rejected',
                  errorCode: body.errorCode,
                  message: {
                    sender: 'assistant',
                    content: '',
                    model: '',
                    tokenEstimate: 0,
                  },
                  usage: DEFAULT_USAGE,
                };
              }
              if (status === 'burst_limit') {
                return burstLimitResult(bodyContent || STYLE_CHAT_COPY.burstLimitNotice, body.usage);
              }
              if (status === 'limit_reached') {
                return limitResult(bodyContent || STYLE_CHAT_COPY.systemLimitNotice, body.usage);
              }
              if (status === 'error') {
                return fallbackResult(
                  normalizeMessage(bodyMessage, STYLE_CHAT_COPY.errorGeneric),
                  typeof body.errorCode === 'string' ? body.errorCode : 'EDGE_ERROR_RESPONSE',
                );
              }
            }
          } catch {
            // fall through to generic fallback
          }
        }
        if (httpStatus != null && (httpStatus >= 500 || httpStatus === 408 || httpStatus === 429)) {
          logHandledOperationalFailure(`http_${httpStatus}`);
        } else if (__DEV__) {
          // Client/auth/schema 4xx responses are not expected operational
          // outages. Keep their safe status visible to developers.
          console.warn(
            '[EdgeStyleChatProvider] unexpected function failure status:',
            httpStatus ?? 'unknown',
          );
        }
        // Attachment-bearing sends must never degrade into an attachment-blind
        // answer: function-unavailable / 404 / 503 / network failures become an
        // explicit unsupported result so the caller preserves the draft.
        if (hasAttachments || hasVisualCollection) {
          return {
            status: hasAttachments ? 'attachments_unsupported' : 'visual_collection_unsupported',
            message: { sender: 'assistant', content: '', model: '', tokenEstimate: 0 },
            usage: DEFAULT_USAGE,
          };
        }
        return fallbackResult(
          { content: getFriendlyStyleChatError(error) },
          httpStatus != null ? `EDGE_HTTP_${httpStatus}` : 'EDGE_INVOKE_ERROR',
        );
      }

      emitObservabilityEvent('elise.request_completed', {
        operation: 'stylechat_generate',
        request_id: correlation.requestId,
        trace_id: correlation.traceId,
      });

      if (!data || typeof data.status !== 'string') {
        if (__DEV__) console.warn('[EdgeStyleChatProvider] unexpected response shape');
        return fallbackResult(undefined, 'MALFORMED_EDGE_RESPONSE');
      }

      const status = normalizeStatus(data.status);
      if (!status) {
        if (__DEV__) console.warn('[EdgeStyleChatProvider] unexpected response status:', data.status);
        return fallbackResult(undefined, 'UNKNOWN_EDGE_STATUS');
      }

      if (status === 'burst_limit') {
        return burstLimitResult(
          typeof data.message?.content === 'string' ? data.message.content : STYLE_CHAT_COPY.burstLimitNotice,
          data.usage,
        );
      }

      if (status === 'limit_reached') {
        return limitResult(
          typeof data.message?.content === 'string' ? data.message.content : STYLE_CHAT_COPY.systemLimitNotice,
          data.usage,
        );
      }

      if (status === 'error') {
        return fallbackResult(
          normalizeMessage(data.message, STYLE_CHAT_COPY.errorGeneric),
          data.errorCode || 'EDGE_ERROR_RESPONSE',
        );
      }

      if (typeof data.message?.content !== 'string' || data.message.content.trim().length === 0) {
        return fallbackResult(undefined, 'EMPTY_EDGE_RESPONSE');
      }
      const message = normalizeMessage(data.message, STYLE_CHAT_COPY.errorGeneric);

      if (hasVisualCollection) {
        const raw = data as unknown as Record<string, unknown>;
        if (raw.visualCollectionContractVersion !== ELISE_VISUAL_COLLECTION_CONTRACT_VERSION) {
          if (__DEV__) console.warn('[EdgeStyleChatProvider] backend lacks visual collection capability');
          return {
            status: 'visual_collection_unsupported',
            message: { sender: 'assistant', content: '', model: '', tokenEstimate: 0 },
            usage: normalizeUsage(data.usage),
          };
        }
      }

      // v2 capability detection: when attachments were sent, the backend must
      // acknowledge the contract. An older deployed function silently ignores
      // unknown fields and answers attachment-blind — that reply must NOT be
      // shown as attachment-aware.
      if (hasAttachments) {
        const raw = data as unknown as Record<string, unknown>;
        if (raw.contractVersion !== STYLECHAT_ATTACHMENT_CONTRACT_VERSION) {
          if (__DEV__) console.warn('[EdgeStyleChatProvider] backend lacks attachment capability');
          return {
            status: 'attachments_unsupported',
            message: { sender: 'assistant', content: '', model: '', tokenEstimate: 0 },
            usage: normalizeUsage(data.usage),
          };
        }
      }

      // v2 actions: pass through only well-shaped entries (server validated).
      const rawActions = (data as unknown as Record<string, unknown>).actions;
      const actions: EdgeChatAction[] = Array.isArray(rawActions)
        ? rawActions
            .filter(
              (entry): entry is Record<string, unknown> =>
                isRecord(entry) && typeof entry.type === 'string' && typeof entry.label === 'string',
            )
            .map((entry) => ({
              type: String(entry.type),
              label: String(entry.label),
              contractVersion: typeof entry.contractVersion === 'string' ? entry.contractVersion : '2',
              payload: isRecord(entry.payload) ? entry.payload : {},
            }))
        : [];

      // Optional advice metadata: flag OFF or non-object → omit (never crash).
      const rawAdvice = (data as unknown as Record<string, unknown>).adviceMetadata;
      const adviceContractVersion =
        typeof (data as unknown as Record<string, unknown>).adviceContractVersion === 'string'
          ? String((data as unknown as Record<string, unknown>).adviceContractVersion)
          : undefined;
      const includeAdvice =
        ELISE_ADVICE_METADATA_CLIENT_V1 && isRecord(rawAdvice);

      // Optional weather context. Passed through UNVALIDATED and untyped by
      // design — the store's `parseWeatherContextWire` is the single validation
      // point, so a malformed payload is rejected in exactly one place rather
      // than being half-checked here and trusted downstream. A backend that
      // predates this field simply omits it and nothing changes.
      const rawWeather = (data as unknown as Record<string, unknown>).weatherContext;
      const weatherContextVersion = (data as unknown as Record<string, unknown>)
        .weatherContextVersion;

      return {
        status,
        message,
        usage: normalizeUsage(data.usage),
        ...(actions.length > 0 ? { actions } : {}),
        ...(includeAdvice
          ? {
              adviceMetadata: rawAdvice,
              ...(adviceContractVersion ? { adviceContractVersion } : {}),
            }
          : {}),
        ...(isRecord(rawWeather)
          ? {
              weatherContext: rawWeather,
              ...(typeof weatherContextVersion === 'number'
                ? { weatherContextVersion }
                : {}),
            }
          : {}),
      };

    } catch (err: unknown) {
      const isAbort = (err as { name?: string })?.name === 'AbortError';
      if (isAbort) {
        logHandledOperationalFailure('client_timeout');
      } else if (isExpectedNetworkFailure(err)) {
        logHandledOperationalFailure('network_failure');
      } else if (__DEV__) {
        console.warn('[EdgeStyleChatProvider] unexpected client failure');
      }
      if (hasAttachments || hasVisualCollection) {
        // Timeout/network with evidence: preserve the draft, never pretend
        // the model saw the collection or attachments.
        return {
          status: hasAttachments ? 'attachments_unsupported' : 'visual_collection_unsupported',
          message: { sender: 'assistant', content: '', model: '', tokenEstimate: 0 },
          usage: DEFAULT_USAGE,
        };
      }
      return fallbackResult(
        { content: getFriendlyStyleChatError(err) },
        isAbort ? 'CLIENT_TIMEOUT' : 'NETWORK_OR_CLIENT_FAILURE',
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
