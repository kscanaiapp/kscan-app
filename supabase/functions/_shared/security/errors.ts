// Normalized, non-revealing error responses for provider-backed Edge Functions.
//
// Every rejected request returns one of the fixed public error categories below,
// plus a safe request ID the caller can quote in support requests. Internal detail
// (stack traces, provider payloads, SQL errors) must never reach the response body —
// log it server-side via security/logging.ts instead.

import { CorsHeaders } from './cors.ts';

export type SecurityErrorCategory =
  | 'unauthorized'
  | 'forbidden'
  | 'account_unavailable'
  | 'invalid_request'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'internal_error';

const STATUS_BY_CATEGORY: Record<SecurityErrorCategory, number> = {
  unauthorized: 401,
  forbidden: 403,
  account_unavailable: 403,
  invalid_request: 400,
  rate_limited: 429,
  provider_unavailable: 503,
  internal_error: 500,
};

const DEFAULT_MESSAGE_BY_CATEGORY: Record<SecurityErrorCategory, string> = {
  unauthorized: 'Authentication is required for this request.',
  forbidden: 'This request is not permitted.',
  account_unavailable: 'This account cannot perform this action right now.',
  invalid_request: 'Request validation failed.',
  rate_limited: 'Too many requests. Please try again later.',
  provider_unavailable: 'This feature is temporarily unavailable. Please try again shortly.',
  internal_error: 'Something went wrong. Please try again.',
};

export interface SecurityErrorOptions {
  message?: string;
  retryAfterSeconds?: number;
  corsHeaders?: CorsHeaders;
}

// Generates a per-request identifier safe to log and to return to the caller.
// Never derived from user input, tokens, or provider responses.
export function generateRequestId(): string {
  return crypto.randomUUID();
}

// Builds the standard error Response. Never pass raw error objects, provider
// bodies, or SQL error text into `options.message` — those belong in logs only.
export function securityErrorResponse(
  category: SecurityErrorCategory,
  requestId: string,
  options: SecurityErrorOptions = {},
): Response {
  const status = STATUS_BY_CATEGORY[category];
  const message = options.message ?? DEFAULT_MESSAGE_BY_CATEGORY[category];

  const headers: Record<string, string> = {
    ...(options.corsHeaders ?? {}),
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, private',
  };

  if (category === 'rate_limited') {
    const retryAfter = Math.max(1, Math.floor(options.retryAfterSeconds ?? 60));
    headers['Retry-After'] = String(retryAfter);
  }

  const body: Record<string, unknown> = {
    error: category,
    message,
    requestId,
  };

  if (category === 'rate_limited') {
    body.retryAfterSeconds = Math.max(1, Math.floor(options.retryAfterSeconds ?? 60));
  }

  return new Response(JSON.stringify(body), { status, headers });
}

// Thin wrapper so call sites can `throw` a security rejection from deep inside a
// handler and have it converted to a Response at the top level.
export class SecurityRejection extends Error {
  readonly category: SecurityErrorCategory;
  readonly options: SecurityErrorOptions;

  constructor(category: SecurityErrorCategory, options: SecurityErrorOptions = {}) {
    super(options.message ?? category);
    this.category = category;
    this.options = options;
  }

  toResponse(requestId: string): Response {
    return securityErrorResponse(this.category, requestId, this.options);
  }
}
