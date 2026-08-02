import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

export const EVIDENCE_BUCKET = 'account-lifecycle-evidence';
export const REQUIRED_EVIDENCE_FILES = [
  'README.html',
  'manifest.json',
  'timeline.jsonl',
  'state-transitions.csv',
  'mobile-interactions.json',
  'provider-revocation.json',
  'notification-receipts.json',
  'inventory-before.json',
  'purge-stage-results.json',
  'inventory-after.json',
  'residual-verification.json',
  'cross-user-verification.json',
  'retained-records.json',
  'system-versions.json',
  'access-log.json',
  'SHA256SUMS',
] as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const JWT_RE = /(?:Bearer\s+)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/i;
const SENSITIVE_KEY_RE = /(^email$|(^|_)(password|jwt|token|access_token|refresh_token|restoration_token|provider_token|service_role|authorization|raw_email|email_body|raw_content|image|conversation|prompt|message_content)(_|$))/i;

type JsonRecord = Record<string, unknown>;

export type EvidenceReservation = {
  id: string;
  version: number;
  path: string;
  retentionExpiresAt: string;
  retentionPolicyVersion: string;
};

function fail<T extends { error: { message: string } | null; data: unknown }>(
  result: T,
  label: string,
) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data as T['data'];
}

export function sanitizeEvidenceValue(value: unknown, path = '$'): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    let sanitized = value.replace(new RegExp(EMAIL_RE.source, 'gi'), '[redacted-email]');
    if (JWT_RE.test(sanitized)) sanitized = '[redacted-token]';
    return sanitized.length > 4000 ? `${sanitized.slice(0, 4000)}[truncated]` : sanitized;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeEvidenceValue(item, `${path}[${index}]`));
  }
  if (typeof value === 'object') {
    const output: JsonRecord = {};
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(key)) continue;
      output[key] = sanitizeEvidenceValue(nested, `${path}.${key}`);
    }
    return output;
  }
  throw new Error(`unsupported evidence value at ${path}`);
}

async function sha256(value: Uint8Array | string) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function normalizedEmailHash(email: string) {
  const normalized = email.trim().toLowerCase().normalize('NFKC');
  if (!normalized || !EMAIL_RE.test(normalized)) throw new Error('valid Auth email required');
  return sha256(normalized);
}

function jsonBytes(value: unknown) {
  return encoder.encode(`${JSON.stringify(sanitizeEvidenceValue(value), null, 2)}\n`);
}

function csvCell(value: unknown) {
  const text = String(sanitizeEvidenceValue(value == null ? '' : String(value)));
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function htmlEscape(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function selectEvents(events: JsonRecord[], matcher: RegExp) {
  return events.filter((event) => matcher.test(String(event.event_type ?? '')));
}

async function buildEvidenceFiles(input: {
  summary: JsonRecord;
  timeline: JsonRecord[];
  accessLog: JsonRecord[];
}) {
  const summary = sanitizeEvidenceValue(input.summary) as JsonRecord;
  const timeline = sanitizeEvidenceValue(input.timeline) as JsonRecord[];
  const accessLog = sanitizeEvidenceValue(input.accessLog) as JsonRecord[];
  const generatedAt = new Date().toISOString();
  const manifest = {
    schema_version: '1.0',
    deletion_request_id: summary.deletion_request_id,
    correlation_id: summary.correlation_id,
    environment: summary.environment,
    evidence_version: summary.evidence_version,
    evidence_bundle_path: summary.evidence_bundle_path,
    generated_at: generatedAt,
    data_minimization: 'sanitized metadata only; raw user content excluded',
    files: REQUIRED_EVIDENCE_FILES.filter((name) => name !== 'SHA256SUMS'),
  };
  const files = new Map<string, Uint8Array>();
  files.set('manifest.json', jsonBytes(manifest));
  files.set(
    'timeline.jsonl',
    encoder.encode(`${timeline.map((event) => JSON.stringify(event)).join('\n')}${timeline.length ? '\n' : ''}`),
  );
  const header = ['occurred_at', 'event_type', 'state_before', 'state_after', 'outcome', 'source'];
  const rows = timeline
    .filter((event) => event.state_before != null || event.state_after != null)
    .map((event) => header.map((key) => csvCell(event[key])).join(','));
  files.set('state-transitions.csv', encoder.encode(`${header.join(',')}\n${rows.join('\n')}${rows.length ? '\n' : ''}`));
  files.set('mobile-interactions.json', jsonBytes(selectEvents(timeline, /^(DELETE_|RESTORE_)/)));
  files.set('provider-revocation.json', jsonBytes(selectEvents(timeline, /(PROVIDER|APPLE|GOOGLE|REVOCATION|DISCONNECT)/)));
  files.set('notification-receipts.json', jsonBytes(selectEvents(timeline, /(NOTIFICATION|EMAIL|DELIVERY|BOUNCE)/)));
  files.set('inventory-before.json', jsonBytes(selectEvents(timeline, /INVENTORY_BEFORE/)));
  files.set('purge-stage-results.json', jsonBytes(selectEvents(timeline, /(PURGE_|STORAGE_|AUTH_USER_)/)));
  files.set('inventory-after.json', jsonBytes(selectEvents(timeline, /INVENTORY_AFTER/)));
  files.set('residual-verification.json', jsonBytes(selectEvents(timeline, /RESIDUAL/)));
  files.set('cross-user-verification.json', jsonBytes(selectEvents(timeline, /CROSS_USER/)));
  files.set('retained-records.json', jsonBytes(selectEvents(timeline, /(RETAINED|LEGAL_HOLD)/)));
  files.set('system-versions.json', jsonBytes(selectEvents(timeline, /(SYSTEM_VERSION|DEPLOYMENT_VERSION)/)));
  files.set('access-log.json', jsonBytes(accessLog));
  const htmlRows = timeline.map((event) => `<tr><td>${htmlEscape(event.occurred_at)}</td><td>${htmlEscape(event.event_type)}</td><td>${htmlEscape(event.state_before)}</td><td>${htmlEscape(event.state_after)}</td><td>${htmlEscape(event.outcome)}</td></tr>`).join('');
  files.set('README.html', encoder.encode(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>K Scan account lifecycle evidence</title><style>body{font:14px system-ui;margin:32px;color:#17171b}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:8px;text-align:left}code{background:#eee;padding:2px 4px}</style></head><body><h1>Account lifecycle evidence</h1><p>Deletion request: <code>${htmlEscape(summary.deletion_request_id)}</code></p><p>Environment: ${htmlEscape(summary.environment)} · Evidence version: v${htmlEscape(summary.evidence_version)} · State: ${htmlEscape(summary.lifecycle_state)}</p><p>Generated: ${htmlEscape(generatedAt)} · Raw user content is intentionally excluded.</p><h2>Timeline</h2><table><thead><tr><th>UTC timestamp</th><th>Event</th><th>Before</th><th>After</th><th>Outcome</th></tr></thead><tbody>${htmlRows}</tbody></table></body></html>`));
  const checksumLines: string[] = [];
  for (const [filename, bytes] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    checksumLines.push(`${await sha256(bytes)}  ${filename}`);
  }
  files.set('SHA256SUMS', encoder.encode(`${checksumLines.join('\n')}\n`));
  for (const filename of REQUIRED_EVIDENCE_FILES) {
    if (!files.has(filename)) throw new Error(`required evidence file missing: ${filename}`);
  }
  return files;
}

async function verifyFiles(files: Map<string, Uint8Array>) {
  const checksumBytes = files.get('SHA256SUMS');
  if (!checksumBytes) throw new Error('SHA256SUMS is missing');
  const expected = new Map<string, string>();
  for (const rawLine of decoder.decode(checksumBytes).split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const match = /^([a-f0-9]{64})\s{2}([^/\\]+)$/.exec(rawLine.trim());
    if (!match) throw new Error('invalid SHA256SUMS line');
    expected.set(match[2], match[1]);
  }
  for (const filename of REQUIRED_EVIDENCE_FILES.filter((name) => name !== 'SHA256SUMS')) {
    const bytes = files.get(filename);
    if (!bytes) throw new Error(`evidence object missing: ${filename}`);
    if (expected.get(filename) !== await sha256(bytes)) {
      throw new Error(`evidence checksum mismatch: ${filename}`);
    }
  }
}

function bundlePath(environment: string, requestedAt: string, requestId: string, version: number) {
  const date = new Date(requestedAt);
  if (Number.isNaN(date.getTime())) throw new Error('invalid request date');
  return `${environment}/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${requestId}/v${version}`;
}

export async function appendEvidenceEvent(
  supabase: SupabaseClient,
  input: {
    requestId: string;
    userId?: string | null;
    eventType: string;
    outcome: string;
    idempotencyKey: string;
    evidenceReference?: string | null;
    metadata?: JsonRecord;
  },
) {
  const result = await supabase.rpc('append_account_lifecycle_event', {
    p_deletion_request_id: input.requestId,
    p_correlation_id: input.requestId,
    p_event_type: input.eventType,
    p_source: 'process-account-deletions',
    p_actor_type: 'worker',
    p_outcome: input.outcome,
    p_idempotency_key: input.idempotencyKey,
    p_subject_user_id: input.userId ?? null,
    p_evidence_reference: input.evidenceReference ?? null,
    p_sanitized_metadata: sanitizeEvidenceValue(input.metadata ?? {}),
  });
  fail(result, `append evidence event ${input.eventType}`);
}

export async function initializePurgeEvidence(
  supabase: SupabaseClient,
  input: { request: JsonRecord; email: string; environment: string },
): Promise<EvidenceReservation> {
  const requestId = String(input.request.id);
  const now = new Date().toISOString();
  const policyResult = await supabase
    .from('evidence_retention_policies')
    .select('id,retention_days,policy_version')
    .eq('environment', input.environment)
    .eq('evidence_type', 'account_lifecycle')
    .lte('effective_at', now)
    .is('retired_at', null)
    .order('effective_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const policy = fail(policyResult, 'load evidence retention policy') as {
    id: string;
    retention_days: number;
    policy_version: string;
  } | null;
  if (!policy) throw new Error(`no approved active retention policy for ${input.environment}`);
  const latestResult = await supabase
    .from('account_lifecycle_evidence_index')
    .select('evidence_version')
    .eq('deletion_request_id', requestId)
    .order('evidence_version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const latest = fail(latestResult, 'load evidence version') as { evidence_version: number } | null;
  const version = (latest?.evidence_version ?? 0) + 1;
  const path = bundlePath(input.environment, String(input.request.requested_at), requestId, version);
  const existing = await supabase.storage.from(EVIDENCE_BUCKET).list(path, { limit: 1 });
  fail(existing, 'check immutable evidence path');
  if ((existing.data ?? []).length) throw new Error('immutable evidence path is already populated');
  const retentionExpiresAt = new Date(Date.now() + Number(policy.retention_days) * 86400000).toISOString();
  const inserted = await supabase
    .from('account_lifecycle_evidence_index')
    .insert({
      deletion_request_id: requestId,
      subject_ref: input.request.subject_ref,
      subject_user_id: input.request.user_id,
      normalized_email_hash: await normalizedEmailHash(input.email),
      environment: input.environment,
      request_date: input.request.requested_at,
      lifecycle_state: 'purging',
      evidence_bundle_path: path,
      evidence_version: version,
      generation_status: 'generating',
      checksum_status: 'pending',
      retention_policy_id: policy.id,
      retention_expires_at: retentionExpiresAt,
    })
    .select('id')
    .single();
  const row = fail(inserted, 'reserve evidence index') as { id: string };
  await appendEvidenceEvent(supabase, {
    requestId,
    userId: String(input.request.user_id),
    eventType: 'EVIDENCE_BUNDLE_INITIALIZED',
    outcome: 'success',
    idempotencyKey: `evidence-initialized:${requestId}:v${version}`,
    evidenceReference: path,
    metadata: { evidence_version: version, retention_policy_version: policy.policy_version },
  });
  return {
    id: row.id,
    version,
    path,
    retentionExpiresAt,
    retentionPolicyVersion: policy.policy_version,
  };
}

export async function finalizePurgeEvidence(
  supabase: SupabaseClient,
  input: {
    request: JsonRecord;
    environment: string;
    reservation: EvidenceReservation;
  },
) {
  const requestId = String(input.request.id);
  const timelineResult = await supabase
    .from('v_account_lifecycle_timeline')
    .select('*')
    .eq('deletion_request_id', requestId)
    .order('occurred_at', { ascending: true });
  const timeline = fail(timelineResult, 'load lifecycle timeline') as JsonRecord[];
  const accessResult = await supabase
    .from('evidence_access_events')
    .select('event_type,reviewer_identity,occurred_at,reason,case_number,files_accessed,export_checksum,outcome')
    .eq('deletion_request_id', requestId)
    .order('occurred_at', { ascending: true });
  const accessLog = fail(accessResult, 'load evidence access log') as JsonRecord[];
  const chainResult = await supabase.rpc('verify_account_lifecycle_hash_chain', {
    p_deletion_request_id: requestId,
  });
  const chain = fail(chainResult, 'verify lifecycle hash chain') as Array<{ valid: boolean }>;
  if (!chain?.[0]?.valid) throw new Error('lifecycle ledger hash-chain verification failed');
  const files = await buildEvidenceFiles({
    summary: {
      deletion_request_id: requestId,
      correlation_id: requestId,
      environment: input.environment,
      evidence_version: input.reservation.version,
      evidence_bundle_path: input.reservation.path,
      lifecycle_state: 'purging_verified',
      requested_at: input.request.requested_at,
      grace_period_ends_at: input.request.grace_period_ends_at,
      retention_policy_version: input.reservation.retentionPolicyVersion,
      retention_expires_at: input.reservation.retentionExpiresAt,
      ledger_hash_chain_valid: true,
    },
    timeline,
    accessLog,
  });
  for (const [filename, bytes] of files) {
    const uploaded = await supabase.storage
      .from(EVIDENCE_BUCKET)
      .upload(`${input.reservation.path}/${filename}`, bytes, {
        contentType:
          filename === 'README.html' ? 'text/html' :
          filename === 'SHA256SUMS' ? 'text/plain' :
          filename === 'state-transitions.csv' ? 'text/csv' : 'application/json',
        cacheControl: '0',
        upsert: false,
      });
    fail(uploaded, `upload evidence ${filename}`);
  }
  const downloaded = new Map<string, Uint8Array>();
  for (const filename of REQUIRED_EVIDENCE_FILES) {
    const result = await supabase.storage
      .from(EVIDENCE_BUCKET)
      .download(`${input.reservation.path}/${filename}`);
    const blob = fail(result, `download evidence ${filename}`) as Blob;
    downloaded.set(filename, new Uint8Array(await blob.arrayBuffer()));
  }
  await verifyFiles(downloaded);
  const manifestHash = await sha256(downloaded.get('SHA256SUMS')!);
  const finalized = await supabase
    .from('account_lifecycle_evidence_index')
    .update({
      lifecycle_state: 'purging_verified',
      generation_status: 'complete',
      checksum_status: 'verified',
      checksum_verified_at: new Date().toISOString(),
      finalized_at: new Date().toISOString(),
    })
    .eq('id', input.reservation.id)
    .eq('generation_status', 'generating')
    .select('id')
    .single();
  fail(finalized, 'finalize evidence index');
  await appendEvidenceEvent(supabase, {
    requestId,
    eventType: 'EVIDENCE_BUNDLE_GENERATED',
    outcome: 'verified',
    idempotencyKey: `evidence-generated:${requestId}:v${input.reservation.version}`,
    evidenceReference: input.reservation.path,
    metadata: {
      evidence_version: input.reservation.version,
      checksum_manifest_hash: manifestHash,
      retention_policy_version: input.reservation.retentionPolicyVersion,
    },
  });
  return { checksumManifestHash: manifestHash, fileCount: files.size };
}

export async function markEvidenceFailed(
  supabase: SupabaseClient,
  reservation: EvidenceReservation | null,
) {
  if (!reservation) return;
  await supabase
    .from('account_lifecycle_evidence_index')
    .update({ generation_status: 'failed', checksum_status: 'failed' })
    .eq('id', reservation.id)
    .eq('generation_status', 'generating');
}
