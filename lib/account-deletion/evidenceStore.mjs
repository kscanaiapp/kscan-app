import crypto from 'node:crypto';

export const EVIDENCE_BUCKET = 'account-lifecycle-evidence';

export const REQUIRED_EVIDENCE_FILES = Object.freeze([
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
]);

const CONTENT_TYPES = Object.freeze({
  'README.html': 'text/html',
  'manifest.json': 'application/json',
  'timeline.jsonl': 'application/x-ndjson',
  'state-transitions.csv': 'text/csv',
  'SHA256SUMS': 'text/plain',
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const JWT_RE = /(?:Bearer\s+)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/i;
const SENSITIVE_KEY_RE = /(^email$|(^|_)(password|jwt|token|access_token|refresh_token|restoration_token|provider_token|service_role|authorization|raw_email|email_body|raw_content|image|conversation|prompt|message_content)(_|$))/i;

export function assertUuid(value, label = 'value') {
  if (!UUID_RE.test(String(value ?? ''))) {
    throw new Error(`${label} must be a UUID`);
  }
  return String(value).toLowerCase();
}

export function normalizeEnvironment(value) {
  const environment = String(value ?? '').trim().toLowerCase();
  if (!['development', 'staging', 'production'].includes(environment)) {
    throw new Error('environment must be development, staging, or production');
  }
  return environment;
}

export function buildEvidenceBundlePath({ environment, requestDate, deletionRequestId, version }) {
  const safeEnvironment = normalizeEnvironment(environment);
  const safeRequestId = assertUuid(deletionRequestId, 'deletion_request_id');
  const parsedVersion = Number(version);
  if (!Number.isSafeInteger(parsedVersion) || parsedVersion < 1 || parsedVersion > 9999) {
    throw new Error('evidence version must be an integer between 1 and 9999');
  }
  const date = new Date(requestDate);
  if (Number.isNaN(date.getTime())) throw new Error('request_date must be a valid timestamp');
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${safeEnvironment}/${year}/${month}/${safeRequestId}/v${parsedVersion}`;
}

export function hashNormalizedEmail(email) {
  const normalized = String(email ?? '').trim().toLowerCase().normalize('NFKC');
  if (!normalized || !EMAIL_RE.test(normalized)) {
    throw new Error('a valid account email is required to prepare the evidence index');
  }
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function sha256(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function contentTypeFor(filename) {
  return CONTENT_TYPES[filename] ?? 'application/json';
}

export function sanitizeEvidenceValue(value, path = '$') {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    let sanitized = value.replace(new RegExp(EMAIL_RE.source, 'gi'), '[redacted-email]');
    if (JWT_RE.test(sanitized)) sanitized = '[redacted-token]';
    return sanitized.length > 4000 ? `${sanitized.slice(0, 4000)}[truncated]` : sanitized;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item, index) => sanitizeEvidenceValue(item, `${path}[${index}]`));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(key)) continue;
      output[key] = sanitizeEvidenceValue(nested, `${path}.${key}`);
    }
    return output;
  }
  throw new Error(`unsupported evidence value at ${path}`);
}

export function assertEvidenceIsSanitized(value, path = '$') {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (EMAIL_RE.test(value)) throw new Error(`raw email detected at ${path}`);
    if (JWT_RE.test(value)) throw new Error(`token-shaped value detected at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertEvidenceIsSanitized(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(key)) throw new Error(`sensitive key detected at ${path}.${key}`);
      assertEvidenceIsSanitized(nested, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`unsupported evidence value at ${path}`);
}

function jsonFile(value) {
  const sanitized = sanitizeEvidenceValue(value);
  assertEvidenceIsSanitized(sanitized);
  return Buffer.from(`${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
}

function csvCell(value) {
  const safe = sanitizeEvidenceValue(value == null ? '' : String(value));
  const text = String(safe);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function buildStateCsv(events) {
  const header = ['occurred_at', 'event_type', 'state_before', 'state_after', 'outcome', 'source'];
  const rows = events
    .filter((event) => event.state_before != null || event.state_after != null)
    .map((event) => header.map((key) => csvCell(event[key])).join(','));
  return Buffer.from(`${header.join(',')}\n${rows.join('\n')}${rows.length ? '\n' : ''}`, 'utf8');
}

function htmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildReadme(summary, timeline, manifest) {
  const rows = timeline.map((event) => `
    <tr>
      <td>${htmlEscape(event.occurred_at)}</td>
      <td>${htmlEscape(event.event_type)}</td>
      <td>${htmlEscape(event.state_before ?? '')}</td>
      <td>${htmlEscape(event.state_after ?? '')}</td>
      <td>${htmlEscape(event.outcome ?? '')}</td>
    </tr>`).join('');
  return Buffer.from(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<title>K Scan account lifecycle evidence</title>
<style>body{font:14px system-ui;margin:32px;color:#17171b}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:8px;text-align:left}code{background:#eee;padding:2px 4px}</style></head>
<body><h1>Account lifecycle evidence</h1>
<p>Deletion request: <code>${htmlEscape(summary.deletion_request_id)}</code></p>
<p>Environment: ${htmlEscape(manifest.environment)} · Evidence version: v${htmlEscape(manifest.evidence_version)} · State: ${htmlEscape(summary.lifecycle_state)}</p>
<p>Generated: ${htmlEscape(manifest.generated_at)} · Raw user content is intentionally excluded.</p>
<h2>Timeline</h2><table><thead><tr><th>UTC timestamp</th><th>Event</th><th>Before</th><th>After</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`, 'utf8');
}

function selectEvents(events, matcher) {
  return events.filter((event) => matcher.test(String(event.event_type ?? '')));
}

export function buildEvidenceFiles({ summary, timeline, accessLog = [], generatedAt = new Date().toISOString() }) {
  const safeSummary = sanitizeEvidenceValue(summary);
  const safeTimeline = sanitizeEvidenceValue(timeline ?? []);
  const safeAccessLog = sanitizeEvidenceValue(accessLog ?? []);
  assertEvidenceIsSanitized(safeSummary);
  assertEvidenceIsSanitized(safeTimeline);
  assertEvidenceIsSanitized(safeAccessLog);

  const manifest = {
    schema_version: '1.0',
    deletion_request_id: safeSummary.deletion_request_id,
    correlation_id: safeSummary.correlation_id ?? safeSummary.deletion_request_id,
    environment: safeSummary.environment,
    evidence_version: safeSummary.evidence_version,
    evidence_bundle_path: safeSummary.evidence_bundle_path,
    generated_at: generatedAt,
    data_minimization: 'sanitized metadata only; raw user content excluded',
    files: REQUIRED_EVIDENCE_FILES.filter((name) => name !== 'SHA256SUMS'),
  };

  const files = new Map();
  files.set('manifest.json', jsonFile(manifest));
  files.set('timeline.jsonl', Buffer.from(safeTimeline.map((event) => JSON.stringify(event)).join('\n') + (safeTimeline.length ? '\n' : ''), 'utf8'));
  files.set('state-transitions.csv', buildStateCsv(safeTimeline));
  files.set('mobile-interactions.json', jsonFile(selectEvents(safeTimeline, /^(DELETE_|RESTORE_)/)));
  files.set('provider-revocation.json', jsonFile(selectEvents(safeTimeline, /(PROVIDER|APPLE|GOOGLE|REVOCATION|DISCONNECT)/)));
  files.set('notification-receipts.json', jsonFile(selectEvents(safeTimeline, /(NOTIFICATION|EMAIL|DELIVERY|BOUNCE)/)));
  files.set('inventory-before.json', jsonFile(selectEvents(safeTimeline, /INVENTORY_BEFORE/)));
  files.set('purge-stage-results.json', jsonFile(selectEvents(safeTimeline, /(PURGE_|STORAGE_|AUTH_USER_)/)));
  files.set('inventory-after.json', jsonFile(selectEvents(safeTimeline, /INVENTORY_AFTER/)));
  files.set('residual-verification.json', jsonFile(selectEvents(safeTimeline, /RESIDUAL/)));
  files.set('cross-user-verification.json', jsonFile(selectEvents(safeTimeline, /CROSS_USER/)));
  files.set('retained-records.json', jsonFile(selectEvents(safeTimeline, /(RETAINED|LEGAL_HOLD)/)));
  files.set('system-versions.json', jsonFile(selectEvents(safeTimeline, /(SYSTEM_VERSION|DEPLOYMENT_VERSION)/)));
  files.set('access-log.json', jsonFile(safeAccessLog));
  files.set('README.html', buildReadme(safeSummary, safeTimeline, manifest));

  const checksumLines = [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filename, value]) => `${sha256(value)}  ${filename}`);
  files.set('SHA256SUMS', Buffer.from(`${checksumLines.join('\n')}\n`, 'utf8'));

  for (const filename of REQUIRED_EVIDENCE_FILES) {
    if (!files.has(filename)) throw new Error(`required evidence file missing: ${filename}`);
  }
  return files;
}

export function parseChecksums(value) {
  const entries = new Map();
  for (const rawLine of String(value).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([a-f0-9]{64})\s{2}([^/\\]+)$/.exec(line);
    if (!match) throw new Error(`invalid SHA256SUMS line: ${line}`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

export function verifyEvidenceChecksums(files) {
  const checksumFile = files.get('SHA256SUMS');
  if (!checksumFile) throw new Error('SHA256SUMS is missing');
  const expected = parseChecksums(checksumFile.toString('utf8'));
  const failures = [];
  for (const filename of REQUIRED_EVIDENCE_FILES.filter((name) => name !== 'SHA256SUMS')) {
    const value = files.get(filename);
    if (!value) {
      failures.push({ filename, reason: 'missing' });
      continue;
    }
    const actual = sha256(value);
    if (!SHA256_RE.test(expected.get(filename) ?? '') || expected.get(filename) !== actual) {
      failures.push({ filename, reason: 'checksum_mismatch', expected: expected.get(filename) ?? null, actual });
    }
  }
  return { valid: failures.length === 0, failures };
}

export function verifyEvidenceBackupRestore(sourceFiles, restoredFiles) {
  const failures = [];
  const sourceVerification = verifyEvidenceChecksums(sourceFiles);
  const restoredVerification = verifyEvidenceChecksums(restoredFiles);

  failures.push(...sourceVerification.failures.map((failure) => ({
    ...failure,
    location: 'source',
  })));
  failures.push(...restoredVerification.failures.map((failure) => ({
    ...failure,
    location: 'restored',
  })));

  for (const filename of REQUIRED_EVIDENCE_FILES) {
    const source = sourceFiles.get(filename);
    const restored = restoredFiles.get(filename);
    if (!source || !restored) continue;
    if (!Buffer.from(source).equals(Buffer.from(restored))) {
      failures.push({
        filename,
        location: 'comparison',
        reason: 'byte_mismatch',
        source: sha256(source),
        restored: sha256(restored),
      });
    }
  }

  const sourceManifest = sourceFiles.get('SHA256SUMS');
  const restoredManifest = restoredFiles.get('SHA256SUMS');
  return {
    valid: failures.length === 0,
    failures,
    sourceManifestHash: sourceManifest ? sha256(sourceManifest) : null,
    restoredManifestHash: restoredManifest ? sha256(restoredManifest) : null,
  };
}
