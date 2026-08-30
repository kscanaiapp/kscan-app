/**
 * Server-side VTO operational logging.
 *
 * A thin, allowlisted wrapper over the shared logEvent so that "what may be
 * logged" is a closed set defined in one place rather than a habit each call
 * site has to remember. Anything not in VTO_LOG_FIELDS is dropped.
 *
 * NEVER LOGGED: the person image or its base64, the garment image bytes, any
 * signed URL, a raw provider response, a provider credential, a full user id,
 * or a prompt. The user is identified only by shortUserId (first 8 chars),
 * matching the account-deletion functions' existing convention.
 *
 * The fields that ARE recorded exist so cost, latency, retry overhead and
 * failure mix can be estimated once a real provider is attached (spec 28) --
 * that is a measurement need, not a tracking one, and none of it describes
 * the person in the photo.
 */

import { logEvent } from '../_shared/deletion/common.ts';

export const VTO_LOG_FIELDS = [
  'uid',
  'requestId',
  'origin',
  'provider',
  'slot',
  'category',
  'failureCode',
  'providerDetail',
  'latencyMs',
  'inputBucket',
  'outputBucket',
  'outputBytes',
  'stage',
] as const;

export type VtoLogField = (typeof VTO_LOG_FIELDS)[number];

const FIELD_SET = new Set<string>(VTO_LOG_FIELDS);

/** Coarse dimension bucket, mirroring services/vto/vtoTelemetry.ts. Lossy on
 *  purpose: an exact pixel size is a weak fingerprint of one photo. */
export function dimensionBucket(width: unknown, height: unknown): string {
  const w = typeof width === 'number' && Number.isFinite(width) ? width : 0;
  const h = typeof height === 'number' && Number.isFinite(height) ? height : 0;
  const longest = Math.max(w, h);
  if (longest <= 0) return 'unknown';
  if (longest <= 512) return 'le512';
  if (longest <= 1024) return 'le1024';
  if (longest <= 2048) return 'le2048';
  return 'gt2048';
}

/** Bucket for a base64 payload's character count, so payload growth is
 *  observable without recording anything about the payload itself. */
export function payloadBucket(chars: number): string {
  if (!Number.isFinite(chars) || chars <= 0) return 'unknown';
  if (chars <= 150_000) return 'le150k';
  if (chars <= 400_000) return 'le400k';
  if (chars <= 900_000) return 'le900k';
  return 'gt900k';
}

export function logVtoEvent(event: string, fields: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELD_SET.has(key)) continue;
    if (value === undefined) continue;
    safe[key] = value;
  }
  logEvent(event, safe);
}
