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

const EDGE_FN      = 'stylechat-generate';
// 16s: Edge Function runs Gemini at 12s + ~2-3s for auth/quota/context queries.
// Client must wait longer than the total server execution budget.
const TIMEOUT_MS   = 16_000;

// ── Response contract ─────────────────────────────────────────────────────────

export type EdgeChatStatus = 'success' | 'limit_reached' | 'burst_limit' | 'error';

export interface EdgeChatMessage {
  sender: 'assistant' | 'system';
  content: string;
  model: string;
  tokenEstimate: number;
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

function fallbackResult(overrides?: Partial<EdgeChatMessage>): EdgeChatResult {
  return {
    status: 'error',
    message: {
      sender: 'assistant',
      content: "I'm having trouble generating styling advice right now. Please try again shortly.",
      model: 'fallback',
      tokenEstimate: 0,
      ...overrides,
    },
    usage: { messagesUsed: 0, messagesLimit: 25 },
  };
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class EdgeStyleChatProvider {
  async generateReply(input: {
    sessionId: string;
    message: string;
  }): Promise<EdgeChatResult> {
    const ac        = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), TIMEOUT_MS);

    try {
      const { data, error } = await supabase.functions.invoke<EdgeChatResult>(EDGE_FN, {
        body: { sessionId: input.sessionId, message: input.message },
        signal: ac.signal,
      });

      if (error) {
        // The Supabase functions-js SDK wraps non-2xx responses as FunctionsHttpError
        // with the raw (unconsumed) Response in error.context. Attempt to parse a
        // structured burst_limit body from a 429 before falling back to generic error.
        const ctx = (error as Record<string, unknown>).context;
        if (ctx != null && typeof (ctx as Response).json === 'function') {
          try {
            const body = await (ctx as Response).json() as Record<string, unknown>;
            if (body?.status === 'burst_limit') {
              const msgContent = (body.message as Record<string, unknown> | undefined)?.content;
              return {
                status: 'burst_limit',
                message: {
                  sender: 'assistant',
                  content: typeof msgContent === 'string' ? msgContent
                    : 'StyleChat is receiving messages too quickly. Please wait a moment and try again.',
                  model: '',
                  tokenEstimate: 0,
                },
                usage: { messagesUsed: 0, messagesLimit: 25 },
              };
            }
          } catch {
            // fall through to generic fallback
          }
        }
        if (__DEV__) console.warn('[EdgeStyleChatProvider] invoke error:', (error as Error).message);
        return fallbackResult();
      }

      if (!data || typeof data.status !== 'string') {
        if (__DEV__) console.warn('[EdgeStyleChatProvider] unexpected response shape');
        return fallbackResult();
      }

      // Validate and pass through the typed response.
      return {
        status: data.status as EdgeChatStatus,
        message: {
          sender: data.message?.sender === 'system' ? 'system' : 'assistant',
          content: typeof data.message?.content === 'string' ? data.message.content : '',
          model: typeof data.message?.model === 'string' ? data.message.model : '',
          tokenEstimate: typeof data.message?.tokenEstimate === 'number' ? data.message.tokenEstimate : 0,
        },
        usage: {
          messagesUsed: data.usage?.messagesUsed ?? 0,
          messagesLimit: data.usage?.messagesLimit ?? 25,
          resetAt: data.usage?.resetAt,
        },
      };

    } catch (err: unknown) {
      const isAbort = (err as { name?: string })?.name === 'AbortError';
      if (__DEV__) {
        console.warn('[EdgeStyleChatProvider]', isAbort ? 'request timed out' : (err as Error)?.message);
      }
      return fallbackResult();
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
