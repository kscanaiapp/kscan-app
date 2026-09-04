/**
 * Client-side mirror of vto-generate's idempotency key derivation
 * (supabase/functions/vto-generate/vtoReservation.ts::buildVtoIdempotencyKey),
 * so the harness can independently compute the exact key a request will
 * reserve under and query public.vto_generation_requests for it as
 * evidence, without ever seeing the server's own digest step.
 *
 * MUST stay byte-for-byte in agreement with the server implementation:
 * sha256 hex digest, same field order, same '|' join, same 'default'
 * fallback for an absent/invalid requestGeneration.
 */
'use strict';

import crypto from 'node:crypto';

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

const REQUEST_GENERATION_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

export function computeVtoIdempotencyKey({ userId, productRef, garmentImageUrl, personDataUri, requestGeneration }) {
  const personDigest = sha256Hex(personDataUri);
  const generation = typeof requestGeneration === 'string' && REQUEST_GENERATION_PATTERN.test(requestGeneration.trim())
    ? requestGeneration.trim()
    : 'default';
  return sha256Hex([userId, productRef, garmentImageUrl, personDigest, generation].join('|'));
}
