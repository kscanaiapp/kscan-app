/**
 * Request material for the `user_supplied_garment` staging probe.
 *
 * This is the harness's mirror of what the app sends when a customer taps
 * "TRY IT ON" under a photo they gave Elise: a bounded inline JPEG plus the
 * fingerprint it was offered for (supabase/functions/vto-generate/
 * vtoUserSuppliedGarment.ts is the authority; the bounds below are pinned to
 * vtoContract.ts by __tests__/vtoE2eUserGarmentProbe.test.js, so a contract
 * change that this file does not follow is a failing test, not a silently
 * stale probe).
 *
 * TWO KINDS OF GARMENT, AND WHY.
 *
 *   - The COMMITTED fixture (fixtures/user-garment.jpg): a real, decodable,
 *     procedurally drawn JPEG with no person, no brand and no customer data.
 *     It is the only garment that may ever accompany a request that can reach
 *     the provider.
 *
 *   - JPEG-SHAPED filler built here to an exact byte length. It satisfies the
 *     server's structural checks (start-of-image marker, canonical encoding,
 *     recomputed hash) and nothing else, so the size boundaries can be probed
 *     to the byte. It is not an image and must never be dispatched: every
 *     request that carries it is refused before the provider by construction
 *     (see lib/userGarmentProbe.mjs::assertCannotReachProvider).
 *
 * Nothing in this module logs or returns payload bytes as evidence; the
 * evidence view carries sizes and the fixture's fingerprint only.
 */
'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const USER_GARMENT_SOURCE_TYPE = 'user_supplied_garment';
export const USER_GARMENT_HASH_VERSION = 'sha256-normalized-v1';
export const USER_GARMENT_MEDIA_PREFIX = 'data:image/jpeg;base64,';

/** Mirrors of supabase/functions/vto-generate/vtoContract.ts. */
export const GARMENT_PAYLOAD_MAX_CHARS = 3_000_000;
export const INLINE_GARMENT_MIN_BYTES = 1024;
export const INLINE_GARMENT_MAX_BYTES = 2_250_000;
export const PERSON_PAYLOAD_MAX_CHARS = 2_000_000;
export const REQUEST_ENVELOPE_MAX_CHARS = 8_192;
/** Ceiling for a request that does not name the inline garment source. */
export const LEGACY_BODY_MAX_CHARS = PERSON_PAYLOAD_MAX_CHARS + REQUEST_ENVELOPE_MAX_CHARS;
/** Ceiling for a request that does. */
export const INLINE_BODY_MAX_CHARS = LEGACY_BODY_MAX_CHARS + GARMENT_PAYLOAD_MAX_CHARS;

/** The largest garment whose data URI still fits the encoded bound. Base64 is
 *  4 characters per 3 bytes, so the encoded bound is the binding one: a garment
 *  at the decoded byte bound would already be 23 characters over it. */
export const LARGEST_ENCODABLE_GARMENT_BYTES =
  Math.floor((GARMENT_PAYLOAD_MAX_CHARS - USER_GARMENT_MEDIA_PREFIX.length) / 4) * 3;

const FIXTURE_IMAGE_URL = new URL('../fixtures/user-garment.jpg', import.meta.url);
const FIXTURE_RECORD_URL = new URL('../fixtures/user-garment.fixture.json', import.meta.url);

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * The garment a request carries, derived from bytes exactly the way the app
 * derives it: canonical Base64, and a fingerprint over that Base64 TEXT.
 */
export function userGarmentFromBytes(bytes) {
  const buffer = Buffer.from(bytes);
  const base64 = buffer.toString('base64');
  const contentHash = sha256Hex(base64);
  return {
    byteLength: buffer.byteLength,
    base64,
    contentHash,
    dataUri: `${USER_GARMENT_MEDIA_PREFIX}${base64}`,
    source: {
      type: USER_GARMENT_SOURCE_TYPE,
      contentHash,
      contentHashVersion: USER_GARMENT_HASH_VERSION,
    },
  };
}

/**
 * Deterministic bytes of an exact length that begin like a JPEG. Structure
 * only: enough for the server's garment checks, never a picture.
 */
export function jpegShapedBytes(byteLength, seedLabel) {
  if (!Number.isInteger(byteLength) || byteLength < 4) {
    throw new Error('jpegShapedBytes needs an integer length of at least 4');
  }
  const out = Buffer.alloc(byteLength);
  let block = crypto.createHash('sha256').update(`kscan-vto-user-garment-filler:${seedLabel}`).digest();
  for (let offset = 0; offset < byteLength; offset += block.length) {
    block.copy(out, offset, 0, Math.min(block.length, byteLength - offset));
    block = crypto.createHash('sha256').update(block).digest();
  }
  out[0] = 0xff; out[1] = 0xd8; out[2] = 0xff; out[3] = 0xe0;
  return out;
}

/** A person-shaped data URI of an EXACT character length. Like the filler
 *  garment, it is structure for size probes and is never dispatched. */
export function personShapedDataUri(totalChars, seedLabel) {
  const prefix = USER_GARMENT_MEDIA_PREFIX;
  const base64Chars = totalChars - prefix.length;
  if (base64Chars < 4 || base64Chars % 4 !== 0) {
    throw new Error('personShapedDataUri needs a length whose Base64 part is a positive multiple of 4');
  }
  return `${prefix}${jpegShapedBytes((base64Chars / 4) * 3, `person:${seedLabel}`).toString('base64')}`;
}

/**
 * Loads the committed synthetic garment and REFUSES to return it unless it is
 * byte-for-byte the file its record describes. A fixture that was swapped,
 * re-encoded or truncated must not be what a paid request sends.
 */
export function loadCommittedUserGarment(fsImpl = fs) {
  const record = JSON.parse(fsImpl.readFileSync(fileURLToPath(FIXTURE_RECORD_URL), 'utf8'));
  const bytes = fsImpl.readFileSync(fileURLToPath(FIXTURE_IMAGE_URL));
  const garment = userGarmentFromBytes(bytes);
  if (garment.byteLength !== record.byteLength
    || sha256Hex(bytes) !== record.sha256OfBytes
    || garment.contentHash !== record.contentHash) {
    throw new Error('committed user-garment fixture does not match its record (fixtures/user-garment.fixture.json)');
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new Error('committed user-garment fixture is not a JPEG');
  }
  return { ...garment, category: record.category, width: record.width, height: record.height, committed: true };
}

/** The request body the app sends for this source. Only these garment fields
 *  exist on the wire: no URL, no product reference, no device-local id. */
export function buildUserGarmentBody({
  requestId, origin, garment, category, personDataUri, requestGeneration, extra = {},
}) {
  const body = {
    requestId,
    origin,
    garment: { source: garment.source, dataUri: garment.dataUri, category },
    requestGeneration,
    ...extra,
  };
  if (personDataUri !== undefined) body.person = { dataUri: personDataUri };
  return body;
}

/**
 * Pads a body with one ignored field so its serialized length is EXACTLY
 * `targetChars`. The server reads only the fields it names, so the padding
 * changes the size of the request and nothing about what it asks for.
 */
export function padBodyToChars(body, targetChars) {
  const base = JSON.stringify({ ...body, probePadding: '' });
  const missing = targetChars - base.length;
  if (missing < 0) throw new Error(`body is already ${base.length} chars, over the ${targetChars} target`);
  const padded = { ...body, probePadding: 'x'.repeat(missing) };
  if (JSON.stringify(padded).length !== targetChars) {
    throw new Error('padBodyToChars did not land on the requested length');
  }
  return padded;
}

/** The reservation identity vto-generate derives for this source: the
 *  server builds both parts from the recomputed hash, never from the caller. */
export function userGarmentReservationIdentity(contentHash) {
  return {
    productRef: `${USER_GARMENT_SOURCE_TYPE}:${contentHash}`,
    garmentImageUrl: `${USER_GARMENT_SOURCE_TYPE}/${USER_GARMENT_HASH_VERSION}/${contentHash}`,
  };
}

/** Evidence-only view: sizes and the fingerprint, never bytes. */
export function userGarmentEvidence(garment) {
  return {
    committedFixture: garment.committed === true,
    byteLength: garment.byteLength,
    encodedChars: garment.dataUri.length,
    contentHash: garment.contentHash,
    contentHashVersion: USER_GARMENT_HASH_VERSION,
  };
}
