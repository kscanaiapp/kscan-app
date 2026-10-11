/** Private recovery packages. Never upload source bytes to GitHub artifacts. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { planRollback } from './function-bundle-capture.mjs';
import { PRODUCTION_PROJECT_REF, STAGING_PROJECT_REF } from './production-helpers.mjs';

export const RECOVERY_BUCKET = 'production-function-recovery';
// Reviewed Production policy inventory, 2026-10-11: six policies, all scoped to other buckets.
const REVIEWED_STORAGE_POLICIES = '165ac077ff6f873fcbf9cd284b0acbdeef10197f49cb514beba5f9d66aa286a7';
const expected = { productionRef: PRODUCTION_PROJECT_REF, stagingRef: STAGING_PROJECT_REF };
export const recoveryHash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export function verifyRecoveryPolicies(rows) {
  if (!Array.isArray(rows) || rows.length !== 6 || rows.some((row) => row.rls_enabled !== true)) {
    throw new Error('Recovery Storage RLS inventory differs from reviewed authority');
  }
  const canonical = rows.map((row) => ({ policyname: row.policyname, cmd: row.cmd,
    roles: row.roles, qual: row.qual, with_check: row.with_check })).sort((a, b) => a.policyname.localeCompare(b.policyname));
  if (recoveryHash(Buffer.from(JSON.stringify(canonical))) !== REVIEWED_STORAGE_POLICIES) {
    throw new Error('Recovery Storage access policies changed; review required before replacement');
  }
}

/** Uses the existing protected management token. No keys are generated, persisted or logged. */
export async function managedRecoveryStore({ token, anonKey, prepare = false, fetchImpl = fetch }) {
  if (!token) throw new Error('Protected management credential required');
  const endpoint = `https://api.supabase.com/v1/projects/${PRODUCTION_PROJECT_REF}`;
  async function management(route, options = {}) {
    let response;
    try { response = await fetchImpl(`${endpoint}${route}`, { ...options,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error('Protected recovery management request failed'); }
    if (!response.ok) throw new Error('Protected recovery management request denied');
    return response.json();
  }
  const rows = await management('/database/query', { method: 'POST', body: JSON.stringify({
    query: "select policyname, cmd, roles::text as roles, qual, with_check, (select relrowsecurity from pg_class where oid='storage.objects'::regclass) as rls_enabled from pg_policies where schemaname='storage' and tablename='objects' order by policyname",
  }) });
  verifyRecoveryPolicies(rows);
  const keys = await management('/api-keys?reveal=true');
  if (!Array.isArray(keys)) throw new Error('Protected recovery credential inventory unreadable');
  const key = keys.find((row) => row.name === 'service_role')?.api_key ??
    keys.find((row) => row.type === 'secret' && typeof row.api_key === 'string')?.api_key;
  const store = privateRecoveryStore({ key, anonKey, fetchImpl });
  if (prepare) await store.prepareBucket();
  return store;
}

export function packRecovery(manifest, capturePath) {
  const capture = capturePath ? JSON.parse(fs.readFileSync(capturePath, 'utf8')) : null;
  const captureRoot = capturePath ? path.join(path.dirname(capturePath), 'files') : null;
  const plan = planRollback({ manifest, capture, captureRoot, expected });
  if (!plan.action) throw new Error('Recovery capture failed validation; replacement refused');
  if (capture && (capture.live_version !== manifest.prior_version || capture.ezbr_sha256 !== manifest.prior_bundle_hash)) {
    throw new Error('Recovery capture prior-state identity mismatch; replacement refused');
  }
  const portable = { ...manifest, capture_path: capture ? 'capture/capture.json' : null };
  const files = capture ? capture.files.map(({ path: relative }) => ({
    path: relative, bytes: fs.readFileSync(path.join(captureRoot, relative)).toString('base64'),
  })) : [];
  return Buffer.from(JSON.stringify({ schema: 'production-private-recovery-v1', manifest: portable, capture, files }));
}

export function unpackRecovery(bytes, destination, reference) {
  if (recoveryHash(bytes) !== reference.sha256) throw new Error('Private recovery package integrity failed');
  const pkg = JSON.parse(bytes.toString('utf8'));
  if (!/^[a-z0-9][a-z0-9-]*$/.test(reference.function_name || '') || !/^[a-f0-9]{40}$/.test(reference.source_commit || '')) {
    throw new Error('Unsafe private recovery identity');
  }
  if (pkg.schema !== 'production-private-recovery-v1' ||
      pkg.manifest?.target !== PRODUCTION_PROJECT_REF ||
      pkg.manifest?.function_name !== reference.function_name ||
      pkg.manifest?.new_source_commit !== reference.source_commit) {
    throw new Error('Private recovery package identity failed');
  }
  if (!Array.isArray(pkg.files) || pkg.files.length !== (pkg.capture?.file_count ?? 0)) {
    throw new Error('Private recovery file inventory failed');
  }
  // Validate every path before writing anything; refuse duplicates and platform-specific escapes.
  const paths = new Set();
  for (const file of pkg.files) {
    if (!file || typeof file.path !== 'string' || !/^[a-zA-Z0-9_.\/-]+$/.test(file.path) ||
        file.path.startsWith('/') || file.path.split('/').includes('..') || paths.has(file.path) ||
        typeof file.bytes !== 'string') throw new Error('Unsafe private recovery file path');
    paths.add(file.path);
  }
  fs.mkdirSync(destination, { recursive: true });
  const captureRoot = path.join(destination, 'capture', 'files');
  for (const file of pkg.files) {
    const target = path.join(captureRoot, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(file.bytes, 'base64'), { mode: 0o600 });
  }
  const plan = planRollback({ manifest: pkg.manifest, capture: pkg.capture, captureRoot, expected });
  if (!plan.action) throw new Error('Private recovery capture unusable; restoration refused');
  if (pkg.capture && (pkg.capture.live_version !== pkg.manifest.prior_version || pkg.capture.ezbr_sha256 !== pkg.manifest.prior_bundle_hash)) {
    throw new Error('Private recovery prior-state identity mismatch');
  }
  if (pkg.capture) fs.writeFileSync(path.join(destination, 'capture', 'capture.json'), JSON.stringify(pkg.capture), { mode: 0o600 });
  const manifestPath = path.join(destination, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ ...pkg.manifest,
    capture_path: pkg.capture ? path.join(destination, 'capture', 'capture.json') : null,
  }), { mode: 0o600 });
  return { manifestPath, plan };
}

export function privateRecoveryStore({ key, anonKey, fetchImpl = fetch } = {}) {
  if (!key || !anonKey || key === anonKey) throw new Error('Protected recovery Storage credential is missing or invalid');
  const base = `https://${PRODUCTION_PROJECT_REF}.supabase.co/storage/v1`;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  async function request(route, options = {}) {
    // Never include response bodies or fetch errors in logs: they can contain credentials/source.
    try { return await fetchImpl(`${base}${route}`, { ...options, signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error('Private recovery Storage request failed'); }
  }
  function objectRoute(reference) {
    if (reference.bucket !== RECOVERY_BUCKET || !/^controlled\/[0-9]+-[0-9]+\/[a-f0-9]{40}\.json$/.test(reference.object)) {
      throw new Error('Invalid private recovery reference');
    }
    return `${RECOVERY_BUCKET}/${reference.object}`;
  }
  async function requirePrivateBucket() {
    const response = await request(`/bucket/${RECOVERY_BUCKET}`, { headers });
    if (!response.ok) throw new Error('Restricted private recovery bucket is unavailable');
    const bucket = await response.json();
    if (bucket.id !== RECOVERY_BUCKET || bucket.public !== false) throw new Error('Recovery bucket must be private');
  }
  async function prepareBucket() {
    const response = await request(`/bucket/${RECOVERY_BUCKET}`, { headers });
    if (!response.ok) {
      // Storage can report a missing bucket as 400 or 404. Never treat a denial as absence.
      let missing = response.status === 404;
      if (response.status === 400) {
        const error = await response.json();
        missing = error.message === 'Bucket not found' || error.error === 'Bucket not found';
      }
      if (!missing) throw new Error('Restricted private recovery bucket unavailable');
      const created = await request('/bucket', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: RECOVERY_BUCKET, name: RECOVERY_BUCKET, public: false,
          file_size_limit: 20971520, allowed_mime_types: ['application/json'] }),
      });
      if (!created.ok) throw new Error('Private recovery bucket preparation failed');
    }
    await requirePrivateBucket();
  }
  async function download(reference) {
    await requirePrivateBucket();
    const route = objectRoute(reference);
    const response = await request(`/object/authenticated/${route}`, { headers });
    if (!response.ok) throw new Error('Private recovery download failed');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (recoveryHash(bytes) !== reference.sha256) throw new Error('Private recovery download integrity failed');
    return bytes;
  }
  async function upload(bytes, reference) {
    await requirePrivateBucket();
    const route = objectRoute(reference);
    const response = await request(`/object/${route}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'x-upsert': 'false' }, body: bytes,
    });
    if (!response.ok) throw new Error('Private recovery upload failed; replacement refused');
    const verified = await download(reference);
    // Public and publishable-key access must both be denied before deployment.
    for (const [suffix, publicHeaders] of [
      [`/object/public/${route}`, {}],
      [`/object/authenticated/${route}`, { apikey: anonKey, Authorization: `Bearer ${anonKey}` }],
    ]) {
      const denied = await request(suffix, { headers: publicHeaders });
      if (![400, 401, 403, 404].includes(denied.status)) throw new Error('Recovery confidentiality check failed');
    }
    const pointer = await request(`/object/${route.replace(/\.json$/, '.reference.json')}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'x-upsert': 'false' },
      body: JSON.stringify(reference),
    });
    if (!pointer.ok) throw new Error('Private interruption recovery reference could not be preserved');
    return verified;
  }
  async function readReference({ runId, attempt, sourceCommit }) {
    const object = `controlled/${runId}-${attempt}/${sourceCommit}.json`;
    const route = objectRoute({ bucket: RECOVERY_BUCKET, object });
    await requirePrivateBucket();
    const response = await request(`/object/authenticated/${route.replace(/\.json$/, '.reference.json')}`, { headers });
    if (!response.ok) throw new Error('Private interruption recovery reference unavailable');
    const reference = await response.json();
    if (reference.object !== object || reference.source_commit !== sourceCommit) throw new Error('Recovery reference identity mismatch');
    return reference;
  }
  return { upload, download, readReference, prepareBucket };
}

/** Any attempted replacement, including ambiguous CLI failure, needs recovery. */
export async function recoverAfterFailure({ attempted, operation, recover, record }) {
  try { return await operation(); }
  catch {
    if (!attempted()) throw new Error('Deployment refused before replacement');
    let restored = false;
    try { await recover(); restored = true; } catch { /* Explicit critical result below. */ }
    const result = { ok: false, rollback_required: true, rollback_attempted: true, rollback_succeeded: restored,
      critical_recovery_failure: !restored,
      next_action: restored ? 'Review failed validation before a new governed promotion' :
        'CRITICAL: stop promotions; use the private recovery reference with the protected recovery workflow',
    };
    record(result);
    throw new Error(restored ? 'Deployment failed; original bundle restored' : 'CRITICAL: deployment failed and recovery failed; stop promotions');
  }
}
