// Privacy-safe structured logging for provider-backed Edge Functions.
//
// Every log line goes through `logSecurityEvent`, which only accepts the fixed,
// allow-listed field set below. There is deliberately no escape hatch for adding
// arbitrary extra fields — if a call site needs to log something new, it must be
// added here explicitly and reviewed for privacy, not passed through ad hoc.
//
// Never call console.log/warn/error directly with request bodies, tokens,
// provider payloads, or prompts anywhere downstream of this module.

export type SecurityOutcome =
  | 'allowed'
  | 'denied'
  | 'success'
  | 'provider_error'
  | 'internal_error';

export type AbuseState = 'normal' | 'throttled' | 'temporarily_blocked' | 'security_review';

export interface SecurityLogEvent {
  requestId: string;
  userIdFragment?: string;
  functionName: string;
  providerCategory?: string;
  outcome: SecurityOutcome;
  latencyMs?: number;
  quotaDecision?: 'reserved' | 'completed' | 'released' | 'denied' | 'not_applicable';
  abuseState?: AbuseState;
  status: number;
  errorCategory?: string;
}

export function logSecurityEvent(event: SecurityLogEvent): void {
  const line = {
    ts: new Date().toISOString(),
    kind: 'provider_security_event',
    ...event,
  };
  console.log(JSON.stringify(line));
}

// Returns a safe, non-reversible-enough-for-casual-exposure fragment of a user ID
// for correlating log lines without printing the full identifier. Matches the
// truncation convention already used across K Scan's Edge Functions.
export function safeUserIdFragment(userId: string): string {
  return userId.slice(0, 8);
}

// Collapses whitespace and clamps length so a log line can never carry a full
// raw payload, prompt, or provider body — only a short, shape-level summary.
export function sanitizeLogText(value: unknown, maxLength = 180): string | undefined {
  if (typeof value !== 'string') return undefined;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed ? collapsed.slice(0, maxLength) : undefined;
}

// Field names that must never appear as keys or values in a log line. Used by
// tests to assert privacy-safe logging; not a runtime filter (the allow-listed
// SecurityLogEvent shape is the actual enforcement mechanism).
export const FORBIDDEN_LOG_SUBSTRINGS = [
  'authorization',
  'bearer ',
  'access_token',
  'refresh_token',
  'api_key',
  'apikey',
  'service_role',
] as const;
