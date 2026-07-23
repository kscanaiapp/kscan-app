const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('client restore invokes restore-account and resend endpoints', () => {
  const service = read('services/accountDeletion.js');
  assert.match(service, /restoreAccountWithToken/);
  assert.match(service, /functions\.invoke\('restore-account'/);
  assert.match(service, /functions\.invoke\('resend-restoration-email'/);
  assert.match(service, /trimmed\.length < 32/);
});

test('app restore route exists and is public in routing guard', () => {
  assert.equal(fs.existsSync(path.join(root, 'app', 'account', 'restore.tsx')), true);
  const guard = read('services/routingGuard.js');
  assert.match(guard, /\/account\/restore/);
  assert.match(guard, /LIMITED_ACCOUNT_ROUTES/);
});

test('privacy copy describes immediate deactivation and restoration email', () => {
  const privacy = read('app/privacy.tsx');
  assert.match(privacy, /deactivated immediately/i);
  assert.match(privacy, /restoration link/i);
});

test('resend sends email before rotating token hash', () => {
  const source = read('supabase/functions/resend-restoration-email/index.ts');
  const sendIdx = source.indexOf('sendRestorationEmail');
  const rotateIdx = source.indexOf('rotate_restoration_token_by_email');
  assert.ok(sendIdx > 0 && rotateIdx > sendIdx);
  assert.match(source, /peek_restoration_resend_by_email/);
});

test('worker storage delete fails closed and paginates', () => {
  const source = read('supabase/functions/process-account-deletions/index.ts');
  assert.match(source, /storage list failed/);
  assert.match(source, /offset \+= limit/);
  assert.match(source, /retainedReferenced/);
  // P1-2/P2-4: pagination + fail-closed listing now live in the shared
  // listPrefixPaths helper (used by both the live delete path and the
  // dry-run enumerator), not inlined in deleteOwnedStorage itself.
  const listFn = source.slice(
    source.indexOf('async function listPrefixPaths'),
    source.indexOf('async function collectReferencedStoragePaths'),
  );
  assert.match(listFn, /throw new Error\(`storage list failed/);
  // Live delete path must throw on a reference-check failure (fail closed);
  // dry-run enumerate may still mark list_error instead of throwing.
  const deleteFn = source.slice(source.indexOf('async function deleteOwnedStorage'), source.indexOf('async function enumerateOwnedStorage'));
  assert.doesNotMatch(deleteFn, /status: 'list_error'/);
  const refFn = source.slice(
    source.indexOf('async function collectReferencedStoragePaths'),
    source.indexOf('async function deleteOwnedStorage'),
  );
  assert.match(refFn, /throw new Error\(`reference check failed/);
});

test('security hardening migration drops client insert and adds device sessions', () => {
  const migration = read(
    'supabase/migrations/20260723021145_account_deletion_security_hardening.sql',
  );
  assert.match(migration, /drop policy if exists "Users can insert own deletion requests"/i);
  assert.match(migration, /user_device_sessions/);
  assert.match(migration, /smart_glasses/);
  assert.match(migration, /peek_restoration_resend_by_email/);
  assert.match(migration, /set search_path = public/);
  assert.match(migration, /pending_deletion/);
});

test('handle-user-deletion fails closed when profile deactivation fails', () => {
  const source = read('supabase/functions/handle-user-deletion/index.ts');
  assert.match(source, /PROFILE_DEACTIVATION_FAILED/);
  assert.match(source, /Unable to deactivate account/);
  assert.match(source, /upgradedFromLegacy|legacy_pending_upgrade/);
});

test('restore-account unbans user and revokes sessions again', () => {
  const source = read('supabase/functions/restore-account/index.ts');
  assert.match(source, /ban_duration: 'none'/);
  assert.match(source, /revoke_user_sessions/);
});

test('privacy export and correction reject deactivated accounts', () => {
  const exportSource = read('supabase/functions/privacy-data-export/index.ts');
  const correctionSource = read('supabase/functions/privacy-correction-request/index.ts');
  assert.match(exportSource, /ACCOUNT_DEACTIVATED/);
  assert.match(correctionSource, /ACCOUNT_DEACTIVATED/);
});

test('worker auth uses constant-time compare and omits claim detail from clients', () => {
  const source = read('supabase/functions/process-account-deletions/index.ts');
  assert.match(source, /mismatch \|=/);
  assert.doesNotMatch(source, /detail: detail\.slice/);
});
