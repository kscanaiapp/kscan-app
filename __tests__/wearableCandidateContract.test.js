const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const edge = readFileSync(join(root, 'supabase/functions/wearable-bridge/index.ts'), 'utf8');
const migration = readFileSync(join(root, 'supabase/migrations/20260815015710_google_xr_wearable_sessions.sql'), 'utf8');
const sanitizer = readFileSync(join(root, 'services/privacyImageSanitizer.js'), 'utf8');
const nativeSanitizer = readFileSync(join(root, 'android/app/src/main/java/com/kscanai/app/privacy/KScanPrivacySanitizerModule.kt'), 'utf8');
const auth = readFileSync(join(root, 'contexts/AuthSessionContext.tsx'), 'utf8');

describe('Google XR wearable candidate security contract', () => {
  it('stores only hashed pairing and session secrets', () => {
    assert.match(migration, /pairing_secret_hash text not null/);
    assert.match(migration, /token_hash text not null unique/);
    assert.doesNotMatch(migration, /\brefresh_token\b|\baccess_token\b/);
    assert.match(edge, /sha256\(token\)/);
  });

  it('enables RLS and revokes direct client access on every wearable table', () => {
    for (const table of ['wearable_pairings', 'wearable_sessions', 'wearable_messages', 'wearable_results', 'wearable_actions']) {
      assert.ok(migration.includes(`alter table public.${table} enable row level security`));
      assert.ok(migration.includes(`revoke all on table public.${table} from anon, authenticated`));
    }
  });

  it('enforces bounded result-only frames', () => {
    assert.match(edge, /MAX_FRAME_BYTES = 65_536/);
    assert.match(edge, /containsForbiddenContent/);
    assert.match(edge, /data:image/);
    assert.match(migration, /octet_length\(frame::text\) <= 65536/);
  });

  it('wearable privacy is native, local and fail closed', () => {
    assert.match(nativeSanitizer, /FaceDetection\.getClient/);
    assert.match(nativeSanitizer, /Canvas\(mutable\)/);
    assert.match(nativeSanitizer, /Bitmap\.CompressFormat\.JPEG/);
    assert.doesNotMatch(nativeSanitizer, /FileOutputStream|writeAsString|upload/);
    assert.match(sanitizer, /requireFaceMasking/);
    assert.match(sanitizer, /throw Object\.assign/);
    assert.doesNotMatch(sanitizer, /return input;\s*\/\/.*fallback/);
  });

  it('phone sign-out attempts server-side wearable revocation first', () => {
    const revokeIndex = auth.indexOf('await revokeAllWearableSessions()');
    const signOutIndex = auth.indexOf('await supabase.auth.signOut()', revokeIndex);
    assert.ok(revokeIndex > 0 && signOutIndex > revokeIndex);
  });

  it('result writes enforce ownership and reject stale revisions', () => {
    assert.match(edge, /existingResult\.user_id !== userId \|\| existingResult\.session_id !== session\.id/);
    assert.match(edge, /throw new Error\("STALE_REVISION"\)/);
    assert.doesNotMatch(edge, /onConflict: "id"/);
  });

  it('action ids are single-purpose and require a live session', () => {
    assert.match(edge, /throw new Error\("ACTION_CONFLICT"\)/);
    const actionBlock = edge.slice(edge.indexOf('case "phone.action"'));
    assert.ok(actionBlock.indexOf('SESSION_INVALID') < actionBlock.indexOf('wearable_actions'));
  });

  it('save persists to the canonical saved_scans library with wearable source', () => {
    assert.match(edge, /from\("saved_scans"\)\.insert/);
    assert.match(edge, /source: "wearable"/);
    assert.match(edge, /metadata->>wearableResultId/);
  });

  it('pairing challenge guesses are throttled per user', () => {
    assert.match(edge, /MAX_PAIR_ATTEMPTS_PER_WINDOW = 10/);
    assert.match(edge, /throttlePairAttempt\(admin, userId, "pair\.approve"\)/);
    assert.match(edge, /PAIR_RATE_LIMITED/);
    const hardening = readFileSync(join(root, 'supabase/migrations/20260819030000_wearable_security_hardening.sql'), 'utf8');
    assert.match(hardening, /create table public\.wearable_auth_attempts/);
    assert.match(hardening, /revoke all on table public\.wearable_auth_attempts from anon, authenticated/);
  });
});
