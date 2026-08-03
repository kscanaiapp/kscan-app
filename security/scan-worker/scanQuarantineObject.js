'use strict';

// Secure Image Ingestion Gate — Phase 5/8/10 orchestration: takes one object
// sitting in the private `image-ingestion-quarantine` bucket, runs it through
// the ingestion gate (security/ingestion-gate/gate.js), and either promotes
// the re-encoded output to `image-ingestion-clean` with a CLEAN verdict row,
// or deletes it and records a rejection -- never both keeping the bytes AND
// marking them rejected, and never leaving quarantine bytes around after a
// terminal verdict.
//
// All Supabase/storage access is injected (see `defaultDeps` at the bottom)
// so this module's decision logic is unit-testable with plain fakes -- no
// live Supabase project required. `runScanWorker` in this file's CLI section
// is the only place that wires up the real service-role client.

const { runIngestionGate, VERDICTS } = require('../ingestion-gate/gate');
const { sha256Hex } = require('../ingestion-gate/hashing');
const { getFormatById, loadPolicy } = require('../ingestion-gate/policy');

const DEFAULT_CLEAN_VERDICT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_REJECTED_VERDICT_TTL_MS = 24 * 60 * 60 * 1000; // ops-review window, bytes already gone
const DEFAULT_MAX_UPLOADS_PER_WINDOW = 30; // per user, per RATE_LIMIT_WINDOW_MS
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_TRANSIENT_RETRIES = 3; // SCANNER_UNAVAILABLE/SCAN_TIMEOUT attempts before giving up

// ── Pure decision helpers (unit-tested directly) ───────────────────────────

function isTransientVerdict(verdict) {
  return verdict === VERDICTS.SCANNER_UNAVAILABLE || verdict === VERDICTS.SCAN_TIMEOUT;
}

// recentCount: number of verdict rows already created by this user within
// RATE_LIMIT_WINDOW_MS (query is the caller's responsibility -- see
// queryRecentVerdictCount in defaultDeps).
function checkRateLimit(recentCount, maxPerWindow = DEFAULT_MAX_UPLOADS_PER_WINDOW) {
  if (recentCount >= maxPerWindow) {
    return { allowed: false, retryAfterSeconds: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

// existingCleanVerdict: the most recent CLEAN verdict row for this
// user+sha256Original, or null. Returns it only if still unexpired --
// "do not repeatedly rescan identical clean bytes ... when a valid unexpired
// verdict exists," and reusing the SAME clean_object_id also means duplicate
// hashes never create additional stored copies.
function findReusableCleanVerdict(existingCleanVerdict, now = Date.now()) {
  if (!existingCleanVerdict) return null;
  if (existingCleanVerdict.verdict !== VERDICTS.CLEAN) return null;
  if (!existingCleanVerdict.clean_object_id) return null;
  const expiresAt = existingCleanVerdict.expires_at ? new Date(existingCleanVerdict.expires_at).getTime() : 0;
  if (expiresAt <= now) return null;
  return existingCleanVerdict;
}

// Deterministic, server-controlled key -- never derived from the client's
// filename. Content-addressed (sha256 of the CANONICAL bytes) so identical
// re-encoded output for the same user always lands on the same object,
// which is itself a duplicate-storage guard independent of the DB-level
// dedup above.
function buildCleanObjectKey(userId, sha256Canonical, formatPolicy) {
  const ext = formatPolicy.expectedExtensions[0];
  return `${userId}/${sha256Canonical}${ext}`;
}

function transientRetryCount(priorVerdictRowsForObject) {
  return priorVerdictRowsForObject.filter((row) => isTransientVerdict(row.verdict)).length;
}

// ── Orchestration ───────────────────────────────────────────────────────────

// deps: {
//   downloadQuarantineObject(objectId) -> Promise<Buffer>
//   deleteQuarantineObject(objectId) -> Promise<void>
//   uploadCleanObject(objectKey, buffer, mimeType) -> Promise<void>
//   queryRecentVerdictCount(userId, sinceMs) -> Promise<number>
//   findExistingCleanVerdict(userId, sha256Original) -> Promise<verdictRow|null>
//   findPriorVerdictRowsForObject(quarantineObjectId) -> Promise<verdictRow[]>
//   insertVerdict(row) -> Promise<void>
//   runIngestionGate -> function (defaults to the real gate; injectable for tests)
// }
// input: { quarantineObjectId, userId, requestId, declaredMimeType, scanEnabled, scannerOptions, policy }
async function processQuarantineObject(deps, input) {
  const policy = input.policy || loadPolicy();
  const now = Date.now();

  const recentCount = await deps.queryRecentVerdictCount(input.userId, now - RATE_LIMIT_WINDOW_MS);
  const rateLimit = checkRateLimit(recentCount, input.maxUploadsPerWindow);
  if (!rateLimit.allowed) {
    return { outcome: 'DEFERRED_RATE_LIMITED', retryAfterSeconds: rateLimit.retryAfterSeconds };
  }

  const buffer = await deps.downloadQuarantineObject(input.quarantineObjectId);
  const sha256Original = sha256Hex(buffer);

  const reusable = findReusableCleanVerdict(await deps.findExistingCleanVerdict(input.userId, sha256Original), now);
  if (reusable) {
    await deps.insertVerdict({
      user_id: input.userId,
      quarantine_object_id: input.quarantineObjectId,
      clean_object_id: reusable.clean_object_id,
      request_id: input.requestId || null,
      sha256_original: sha256Original,
      sha256_canonical: reusable.sha256_canonical,
      detected_format: reusable.detected_format,
      width: reusable.width,
      height: reusable.height,
      compressed_bytes: reusable.compressed_bytes,
      scanner_engine: 'reused_prior_verdict',
      scanner_signature_version: null,
      scanned_at: null,
      verdict: VERDICTS.CLEAN,
      rejection_category: null,
      expires_at: reusable.expires_at,
    });
    await deps.deleteQuarantineObject(input.quarantineObjectId);
    return { outcome: 'CLEAN_REUSED', cleanObjectId: reusable.clean_object_id };
  }

  const runGate = deps.runIngestionGate || runIngestionGate;
  const gateResult = await runGate(buffer, {
    policy,
    declaredMimeType: input.declaredMimeType,
    scanEnabled: input.scanEnabled,
    scannerOptions: input.scannerOptions,
    requestId: input.requestId,
  });

  if (!gateResult.ok) {
    if (isTransientVerdict(gateResult.verdict)) {
      const priorRows = await deps.findPriorVerdictRowsForObject(input.quarantineObjectId);
      const retries = transientRetryCount(priorRows);
      const giveUp = retries + 1 >= MAX_TRANSIENT_RETRIES;

      await deps.insertVerdict({
        user_id: input.userId,
        quarantine_object_id: input.quarantineObjectId,
        clean_object_id: null,
        request_id: input.requestId || null,
        sha256_original: sha256Original,
        sha256_canonical: null,
        detected_format: null,
        width: null,
        height: null,
        compressed_bytes: buffer.length,
        scanner_engine: input.scanEnabled ? 'clamav' : 'not_run',
        scanner_signature_version: null,
        scanned_at: null,
        verdict: gateResult.verdict,
        rejection_category: gateResult.verdict,
        expires_at: new Date(now + DEFAULT_REJECTED_VERDICT_TTL_MS).toISOString(),
      });

      if (giveUp) {
        await deps.deleteQuarantineObject(input.quarantineObjectId);
        return { outcome: 'TRANSIENT_GIVEUP', verdict: gateResult.verdict };
      }
      // Leave the quarantine object in place for a future retry attempt.
      return { outcome: 'TRANSIENT_RETRY_SCHEDULED', verdict: gateResult.verdict, attempt: retries + 1 };
    }

    // Terminal rejection: record the verdict, never retain the bytes.
    await deps.insertVerdict({
      user_id: input.userId,
      quarantine_object_id: input.quarantineObjectId,
      clean_object_id: null,
      request_id: input.requestId || null,
      sha256_original: sha256Original,
      sha256_canonical: null,
      detected_format: null,
      width: null,
      height: null,
      compressed_bytes: buffer.length,
      scanner_engine: input.scanEnabled ? 'clamav' : 'not_run',
      scanner_signature_version: null,
      scanned_at: input.scanEnabled ? new Date(now).toISOString() : null,
      verdict: gateResult.verdict,
      rejection_category: gateResult.verdict,
      expires_at: new Date(now + DEFAULT_REJECTED_VERDICT_TTL_MS).toISOString(),
    });
    await deps.deleteQuarantineObject(input.quarantineObjectId);
    return { outcome: 'REJECTED', verdict: gateResult.verdict };
  }

  // CLEAN.
  const formatPolicy = getFormatById(policy, gateResult.detectedFormat);
  const cleanObjectKey = buildCleanObjectKey(input.userId, gateResult.sha256Canonical, formatPolicy);

  await deps.uploadCleanObject(cleanObjectKey, gateResult.canonicalBuffer, gateResult.canonicalMimeType);

  await deps.insertVerdict({
    user_id: input.userId,
    quarantine_object_id: input.quarantineObjectId,
    clean_object_id: cleanObjectKey,
    request_id: input.requestId || null,
    sha256_original: gateResult.sha256Original,
    sha256_canonical: gateResult.sha256Canonical,
    detected_format: gateResult.detectedFormat,
    width: gateResult.width,
    height: gateResult.height,
    compressed_bytes: gateResult.canonicalBuffer.length,
    scanner_engine: input.scanEnabled ? 'clamav' : 'not_run',
    scanner_signature_version: input.scannerSignatureVersion || null,
    scanned_at: input.scanEnabled ? new Date(now).toISOString() : null,
    verdict: VERDICTS.CLEAN,
    rejection_category: null,
    expires_at: new Date(now + DEFAULT_CLEAN_VERDICT_TTL_MS).toISOString(),
  });

  await deps.deleteQuarantineObject(input.quarantineObjectId);

  return { outcome: 'CLEAN', cleanObjectId: cleanObjectKey };
}

// ── Real Supabase-backed deps + CLI entrypoint ─────────────────────────────
// Not exercised by unit tests (no live project needed); used only when this
// file is run directly (`npm run scan-worker:run`).

function buildSupabaseDeps(supabase) {
  const QUARANTINE_BUCKET = 'image-ingestion-quarantine';
  const CLEAN_BUCKET = 'image-ingestion-clean';

  return {
    async downloadQuarantineObject(objectId) {
      const { data, error } = await supabase.storage.from(QUARANTINE_BUCKET).download(objectId);
      if (error) throw new Error(`download failed: ${error.message}`);
      return Buffer.from(await data.arrayBuffer());
    },
    async deleteQuarantineObject(objectId) {
      const { error } = await supabase.storage.from(QUARANTINE_BUCKET).remove([objectId]);
      if (error) throw new Error(`quarantine delete failed: ${error.message}`);
    },
    async uploadCleanObject(objectKey, buffer, mimeType) {
      const { error } = await supabase.storage.from(CLEAN_BUCKET).upload(objectKey, buffer, {
        contentType: mimeType,
        upsert: false, // never overwrite an existing clean object in place
      });
      if (error && !String(error.message).includes('already exists')) {
        throw new Error(`clean upload failed: ${error.message}`);
      }
    },
    async queryRecentVerdictCount(userId, sinceEpochMs) {
      const { count, error } = await supabase
        .from('image_scan_verdicts')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', new Date(sinceEpochMs).toISOString());
      if (error) throw new Error(`rate-limit query failed: ${error.message}`);
      return count || 0;
    },
    async findExistingCleanVerdict(userId, sha256Original) {
      const { data, error } = await supabase
        .from('image_scan_verdicts')
        .select('*')
        .eq('user_id', userId)
        .eq('sha256_original', sha256Original)
        .eq('verdict', VERDICTS.CLEAN)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`dedup query failed: ${error.message}`);
      return data;
    },
    async findPriorVerdictRowsForObject(quarantineObjectId) {
      const { data, error } = await supabase
        .from('image_scan_verdicts')
        .select('verdict')
        .eq('quarantine_object_id', quarantineObjectId);
      if (error) throw new Error(`retry-count query failed: ${error.message}`);
      return data || [];
    },
    async insertVerdict(row) {
      const { error } = await supabase.from('image_scan_verdicts').insert(row);
      if (error) throw new Error(`verdict insert failed: ${error.message}`);
    },
  };
}

async function runScanWorker(quarantineObjectId, userId, options = {}) {
  const { createClient } = require('@supabase/supabase-js');
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const deps = buildSupabaseDeps(supabase);
  return processQuarantineObject(deps, {
    quarantineObjectId,
    userId,
    scanEnabled: process.env.IMAGE_SCANNER_ENABLED === 'true',
    ...options,
  });
}

if (require.main === module) {
  const [, , quarantineObjectId, userId] = process.argv;
  if (!quarantineObjectId || !userId) {
    console.error('Usage: node security/scan-worker/scanQuarantineObject.js <quarantineObjectId> <userId>');
    process.exit(1);
  }
  runScanWorker(quarantineObjectId, userId)
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((err) => {
      console.error('scan worker failed:', err.message);
      process.exit(1);
    });
}

module.exports = {
  processQuarantineObject,
  checkRateLimit,
  findReusableCleanVerdict,
  buildCleanObjectKey,
  transientRetryCount,
  isTransientVerdict,
  buildSupabaseDeps,
  runScanWorker,
  DEFAULT_MAX_UPLOADS_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
  MAX_TRANSIENT_RETRIES,
};
