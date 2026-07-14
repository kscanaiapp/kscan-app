import assert from 'node:assert/strict';
import { StylistSpeechError } from './types.ts';
import {
  APPROVED_SPEAKING_STYLIST_IDS,
  resolveServerVoiceProfile,
} from './voiceProfiles.ts';

Deno.test('server allowlist maps all ten approved portrait IDs explicitly', () => {
  assert.equal(APPROVED_SPEAKING_STYLIST_IDS.length, 10);
  APPROVED_SPEAKING_STYLIST_IDS.forEach((id, index) => {
    assert.equal(id, `stylist_portrait_${String(index + 1).padStart(2, '0')}`);
    assert.equal(
      resolveServerVoiceProfile(id),
      (index + 1) % 2 === 1 ? 'feminine' : 'masculine',
    );
  });
});

Deno.test('server allowlist rejects silent and unsupported IDs', () => {
  assert.throws(
    () => resolveServerVoiceProfile('elise_default'),
    (error) => error instanceof StylistSpeechError && error.code === 'STYLIST_SILENT',
  );
  assert.throws(
    () => resolveServerVoiceProfile('stylist_portrait_11'),
    (error) => error instanceof StylistSpeechError && error.code === 'STYLIST_UNSUPPORTED',
  );
});
