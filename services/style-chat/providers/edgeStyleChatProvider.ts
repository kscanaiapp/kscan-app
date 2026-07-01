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
import { getFriendlyStyleChatError } from '../styleChatErrors';
import type { WeatherLocationInput } from '../../../constants/weatherStyling';

const EDGE_FN      = 'stylechat-generate';
// 20s: Edge Function runs Gemini at 12s plus multiple auth/quota/context queries
// before Gemini starts. Client must wait longer than the worst-case server budget
// so it does not abort while the backend is still succeeding.
const TIMEOUT_MS   = 20_000;

// ── Response contract ─────────────────────────────────────────────────────────

export type EdgeChatStatus = 'success' | 'limit_reached' | 'burst_limit' | 'error';

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
}

// ── Safe fallback ─────────────────────────────────────────────────────────────

const DEFAULT_USAGE: EdgeChatUsage = {
  messagesUsed: 0,
  messagesLimit: STYLE_CHAT_DAILY_MESSAGE_LIMIT,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStatus(status: unknown): EdgeChatStatus | null {
  return status === 'success'
    || status === 'limit_reached'
    || status === 'burst_limit'
    || status === 'error'
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

function fallbackResult(overrides?: Partial<EdgeChatMessage>): EdgeChatResult {
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
  };
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
  async generateReply(input: {
    sessionId: string;
    message: string;
    weatherLocation?: WeatherLocationInput | null;
  }): Promise<EdgeChatResult> {
    const ac        = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), TIMEOUT_MS);

    try {
      const { data, error } = await supabase.functions.invoke<EdgeChatResult>(EDGE_FN, {
        body: {
          sessionId: input.sessionId,
          message: input.message,
          // Additive/optional: sent only when weather-aware styling is enabled and a
          // rounded foreground fix is available. Requests without it stay valid.
          ...(input.weatherLocation && input.weatherLocation.enabled
            ? { weatherLocation: input.weatherLocation }
            : {}),
        },
        signal: ac.signal,
      });

      if (error) {
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
              if (status === 'burst_limit') {
                return burstLimitResult(bodyContent || STYLE_CHAT_COPY.burstLimitNotice, body.usage);
              }
              if (status === 'limit_reached') {
                return limitResult(bodyContent || STYLE_CHAT_COPY.systemLimitNotice, body.usage);
              }
              if (status === 'error') {
                return fallbackResult(normalizeMessage(bodyMessage, STYLE_CHAT_COPY.errorGeneric));
              }
            }
          } catch {
            // fall through to generic fallback
          }
        }
        if (__DEV__) console.warn('[EdgeStyleChatProvider] invoke error:', (error as Error).message);
        return fallbackResult({ content: getFriendlyStyleChatError(error) });
      }

      if (!data || typeof data.status !== 'string') {
        if (__DEV__) console.warn('[EdgeStyleChatProvider] unexpected response shape');
        return fallbackResult();
      }

      const status = normalizeStatus(data.status);
      if (!status) {
        if (__DEV__) console.warn('[EdgeStyleChatProvider] unexpected response status:', data.status);
        return fallbackResult();
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
        return fallbackResult(normalizeMessage(data.message, STYLE_CHAT_COPY.errorGeneric));
      }

      if (typeof data.message?.content !== 'string' || data.message.content.trim().length === 0) {
        return fallbackResult();
      }
      const message = normalizeMessage(data.message, STYLE_CHAT_COPY.errorGeneric);

      // Validate and pass through the typed response.
      return {
        status,
        message,
        usage: normalizeUsage(data.usage),
      };

    } catch (err: unknown) {
      const isAbort = (err as { name?: string })?.name === 'AbortError';
      if (__DEV__) {
        console.warn('[EdgeStyleChatProvider]', isAbort ? 'request timed out' : (err as Error)?.message);
      }
      return fallbackResult({ content: getFriendlyStyleChatError(err) });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
