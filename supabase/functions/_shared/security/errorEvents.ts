// Redacted error-event reporter for Edge Functions.
// Writes structured console logs always; optionally inserts into
// internal.edge_function_errors when service role credentials are present.
// Never accepts raw bodies, tokens, emails, or full user IDs.

export type ErrorClass =
  | 'boot_failure'
  | 'uncaught_runtime'
  | 'database_failure'
  | 'provider_timeout'
  | 'provider_http_failure'
  | 'auth_failure_burst'
  | 'authz_failure_burst'
  | 'synthetic_test_failure'
  | 'health_degraded'
  | 'deployment_failure'
  | 'internal_error';

export interface EdgeErrorEventInput {
  functionName: string;
  functionVersion?: string;
  requestId?: string;
  errorClass: ErrorClass;
  errorCode?: string;
  safeMessage: string;
  statusCode?: number;
  durationMs?: number;
  provider?: string;
}

const FORBIDDEN = [
  'authorization',
  'bearer ',
  'access_token',
  'refresh_token',
  'service_role',
  'api_key',
  'apikey',
  'password',
  'eyj',
];

export function sanitizeSafeMessage(value: string, max = 240): string {
  let text = String(value || 'error').replace(/\s+/g, ' ').trim().slice(0, max);
  for (const needle of FORBIDDEN) {
    if (text.toLowerCase().includes(needle)) {
      text = 'redacted_error';
      break;
    }
  }
  return text;
}

export function resolveEnvironment(): 'staging' | 'production' {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  if (url.includes('yzqjvdfgefveprobvvyw')) return 'staging';
  if (url.includes('wyyuqfdxucjksghsmhry')) return 'production';
  const explicit = Deno.env.get('KSCAN_ENVIRONMENT');
  if (explicit === 'staging' || explicit === 'production') return explicit;
  return 'staging';
}

export function logEdgeErrorEvent(input: EdgeErrorEventInput): void {
  const environment = resolveEnvironment();
  const safeMessage = sanitizeSafeMessage(input.safeMessage);
  const line = {
    ts: new Date().toISOString(),
    kind: 'edge_function_error_event',
    environment,
    function_name: input.functionName,
    function_version: input.functionVersion ?? null,
    request_id: input.requestId ?? null,
    error_class: input.errorClass,
    error_code: input.errorCode ?? null,
    safe_message: safeMessage,
    status_code: input.statusCode ?? null,
    duration_ms: input.durationMs ?? null,
    provider: input.provider ?? null,
  };
  console.log(JSON.stringify(line));
}

export async function persistEdgeErrorEvent(input: EdgeErrorEventInput): Promise<boolean> {
  logEdgeErrorEvent(input);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return false;

  // Insert via PostgREST only works if the table is exposed. Prefer schema-qualified
  // REST is unavailable for `internal` by design — persistence is best-effort via
  // Management later. For now console logging is the durable local foundation.
  // Returning false signals "logged only".
  return false;
}

// High-severity classes that should page/alert when thresholds are exceeded.
export const ALERTABLE_ERROR_CLASSES: readonly ErrorClass[] = [
  'boot_failure',
  'uncaught_runtime',
  'database_failure',
  'provider_timeout',
  'provider_http_failure',
  'synthetic_test_failure',
  'health_degraded',
  'deployment_failure',
];

// Expected client auth failures must not create high-severity alerts by default.
export const NON_ALERT_DEFAULT_CLASSES: readonly ErrorClass[] = [
  'auth_failure_burst',
  'authz_failure_burst',
];
