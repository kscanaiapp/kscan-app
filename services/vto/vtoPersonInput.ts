/**
 * Person-image intake for VTO.
 *
 * PRIVACY POSTURE (honest, not aspirational):
 *   - The user explicitly picks the photo for THIS operation. Nothing is
 *     auto-selected -- not the profile avatar, not the Elise avatar, not a
 *     Closet photo, not a previous try-on.
 *   - The picked image is re-encoded through prepareImageForPrivacyUpload,
 *     which genuinely strips EXIF/metadata by producing a fresh JPEG
 *     derivative. That is the ONLY privacy claim this path earns.
 *   - It does NOT mask faces. A recognizable image of the user reaches the
 *     generation provider. This is not zero-knowledge and must never be
 *     described as such (see docs/vto-foundation.md).
 *   - The derivative lives in the app cache for the duration of the
 *     operation and is deleted by releaseVtoPersonInput. K Scan writes no
 *     durable copy, no history row, and no Storage object.
 *
 * services/privacyImageSanitizer.js is deliberately NOT used here: it is a
 * passthrough that returns its input unchanged, so it would give the
 * appearance of sanitation without performing any.
 */

import * as ImagePicker from 'expo-image-picker';

import {
  cleanupSanitizedImage,
  compressSanitizedImageForAnalysis,
  prepareImageForPrivacyUpload,
  PrivacyPrepareError,
} from '../privacyImageUpload';
import type { VtoPersonInput } from '../../types/vto';

/** Working resolution handed to the provider. Bounded for payload safety and
 *  latency, not copied from any vendor's documented limit. */
export const VTO_PERSON_MAX_DIMENSION = 1024;
export const VTO_PERSON_JPEG_QUALITY = 0.8;

/** Transport bound on the base64 person payload (~1.5 MB of image bytes).
 *  A generous safety ceiling: it exists to reject absurd payloads, not to
 *  encode a provider's requirement. The server enforces the same bound. */
export const VTO_PERSON_PAYLOAD_MAX_CHARS = 2_000_000;

export const VTO_PERSON_SANITIZER_MODE = 'metadata-stripped-reencode' as const;

export type VtoPersonPickOutcome =
  | { ok: true; person: VtoPersonInput }
  | { ok: false; reason: 'cancelled' | 'permission_denied' | 'invalid_person_input' };

type Picker = Pick<
  typeof ImagePicker,
  'requestMediaLibraryPermissionsAsync' | 'launchImageLibraryAsync'
>;

/**
 * Opens the photo library and returns a sanitized, ephemeral person input.
 * Cancellation is a no-op outcome, never an error state.
 */
export async function pickVtoPersonInput(
  deps?: {
    picker?: Picker;
    prepare?: typeof prepareImageForPrivacyUpload;
  },
): Promise<VtoPersonPickOutcome> {
  const picker = deps?.picker ?? ImagePicker;
  const prepare = deps?.prepare ?? prepareImageForPrivacyUpload;

  const permission = await picker.requestMediaLibraryPermissionsAsync();
  if (permission?.status !== 'granted') {
    return { ok: false, reason: 'permission_denied' };
  }

  const picked = await picker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 1,
    allowsEditing: false,
    allowsMultipleSelection: false,
  });
  if (picked?.canceled || !picked?.assets?.[0]?.uri) {
    return { ok: false, reason: 'cancelled' };
  }

  try {
    const prepared = await prepare(picked.assets[0].uri, {
      maxDimension: VTO_PERSON_MAX_DIMENSION,
      quality: VTO_PERSON_JPEG_QUALITY,
    });
    if (!prepared.policy.metadataStripped) {
      // The sanitizer must not be believed on its own say-so: if it reports
      // it did not strip metadata, the image does not leave the device.
      await cleanupSanitizedImage(prepared.sanitizedUri);
      return { ok: false, reason: 'invalid_person_input' };
    }
    return {
      ok: true,
      person: {
        source: 'photo_library',
        sanitizedUri: prepared.sanitizedUri,
        width: prepared.width ?? null,
        height: prepared.height ?? null,
        metadataStripped: true,
        sanitizerVersion: prepared.policy.sanitizerVersion,
      },
    };
  } catch (err) {
    if (err instanceof PrivacyPrepareError) {
      return { ok: false, reason: 'invalid_person_input' };
    }
    return { ok: false, reason: 'invalid_person_input' };
  }
}

export type VtoPersonPayloadOutcome =
  | { ok: true; dataUri: string; transientUri: string }
  | { ok: false; reason: 'invalid_person_input' };

/**
 * Produces the transient transport payload for a sanitized person image.
 * The base64 exists for the duration of one request and is never persisted,
 * logged, or attached to any other K Scan surface.
 */
export async function buildVtoPersonPayload(
  person: VtoPersonInput,
  deps?: { compress?: typeof compressSanitizedImageForAnalysis },
): Promise<VtoPersonPayloadOutcome> {
  const compress = deps?.compress ?? compressSanitizedImageForAnalysis;
  try {
    const { base64, uri } = await compress(person.sanitizedUri, {
      width: VTO_PERSON_MAX_DIMENSION,
      quality: VTO_PERSON_JPEG_QUALITY,
    });
    if (typeof base64 !== 'string' || base64.length > VTO_PERSON_PAYLOAD_MAX_CHARS) {
      return { ok: false, reason: 'invalid_person_input' };
    }
    return { ok: true, dataUri: base64, transientUri: uri };
  } catch {
    return { ok: false, reason: 'invalid_person_input' };
  }
}

/** Deletes every cache derivative created for one VTO operation. Safe to call
 *  more than once and on partially-built inputs. */
export async function releaseVtoPersonInput(
  ...uris: Array<string | null | undefined>
): Promise<void> {
  for (const uri of uris) {
    if (uri) await cleanupSanitizedImage(uri);
  }
}
