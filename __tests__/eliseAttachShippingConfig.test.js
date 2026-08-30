/**
 * IOS-001 — the shipping configuration must actually enable the code path the
 * Elise attach surface depends on.
 *
 * THE DEFECT THIS PINS
 *
 * eas.json `production` enabled EXPO_PUBLIC_ELISE_VISUAL_ATTACHMENTS_V1_ENABLED
 * (so the composer's camera/gallery control is mounted and reachable) but did
 * NOT set EXPO_PUBLIC_ELISE_IDENTIFICATION_V2_ENABLED. In
 * hooks/useStyleChatAttachments.ts `addDirectImage`:
 *
 *     const v2Flag = beginEliseV2Session();
 *     let identified = null;
 *     if (v2Flag.enabled) { identified = await identifyDirectImageForStyle(...) }
 *     ...
 *     if (!identified || identified.kind !== 'identified') {
 *       // state: 'failed_retryable', lastErrorCode: 'IDENTIFICATION_REQUIRED'
 *       return { ok: false, message: 'Could not identify this photo.' };
 *     }
 *
 * With the flag absent, `identified` stays null, so EVERY direct photo
 * attachment failed with "Could not identify this photo" — the feature was
 * mounted and broken rather than dark. The `identified?.kind === 'identified'
 * ? ... : 'tops'` fallback below that guard is unreachable for the same reason.
 *
 * WHY THIS TEST SHAPE
 *
 * Every existing attach-first suite asserts source STRUCTURE, and none of them
 * reads eas.json — so a correct-looking source tree passed while the shipped
 * binary could not attach a photo. This is the same defect class that was found
 * on Android and fixed there in its production profile; the two lines carry
 * separate eas.json copies, so fixing one cannot fix the other. A configuration
 * blocker is only catchable by reading the configuration.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');

function easProfiles() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8')).build;
}

function readSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('IOS-001: the production profile enables Elise V2 identification', () => {
  const env = easProfiles().production.env;
  assert.equal(
    env.EXPO_PUBLIC_ELISE_IDENTIFICATION_V2_ENABLED,
    'true',
    'the App Store build must enable the identification path addDirectImage requires',
  );
});

test('IOS-001: any profile mounting the attach surface also enables identification', () => {
  // The real invariant. Mounting the control without the identification flag is
  // the broken combination, whichever profile does it.
  for (const [name, profile] of Object.entries(easProfiles())) {
    const env = profile.env ?? {};
    if (env.EXPO_PUBLIC_ELISE_VISUAL_ATTACHMENTS_V1_ENABLED !== 'true') continue;
    assert.equal(
      env.EXPO_PUBLIC_ELISE_IDENTIFICATION_V2_ENABLED,
      'true',
      `profile "${name}" mounts the Elise attach control but leaves identification disabled, ` +
        'so every photo attachment fails with "Could not identify this photo"',
    );
  }
});

test('IOS-001: the guard that makes the flag load-bearing still exists', () => {
  // If this guard is ever softened into a real flag-off fallback, the coupling
  // above stops being load-bearing and this suite should be revisited rather
  // than left asserting a constraint that no longer protects anything.
  const hook = readSource('hooks/useStyleChatAttachments.ts');
  assert.match(
    hook,
    /if \(!identified \|\| identified\.kind !== 'identified'\)/,
    'addDirectImage still hard-fails any non-identified outcome',
  );
  assert.match(
    hook,
    /const v2Flag = beginEliseV2Session\(\);/,
    'addDirectImage still gates identification on the session flag',
  );
});

test('IOS-001: production never points the client at a non-production backend', () => {
  // Guards the same file against a staging URL arriving with a future edit.
  const env = easProfiles().production.env;
  assert.equal(
    env.EXPO_PUBLIC_SUPABASE_URL,
    'https://wyyuqfdxucjksghsmhry.supabase.co',
    'the App Store build must target the production Supabase project',
  );
});
