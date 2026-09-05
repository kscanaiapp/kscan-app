import { existsSync, statSync } from 'node:fs';
import { loadImageFile, type DecodedSource } from './codec';
import type { Phase4SourceImageRef, Rejection } from './types';

const MIN_DIMENSION = 40;
const MAX_BYTES = 25 * 1024 * 1024;

export type LoadResult = { ok: true; decoded: DecodedSource } | { ok: false; rejection: Rejection };

/**
 * This session only ever loads local, already-authorized fixture files
 * (`origin: 'local-fixture'`) — see docs/vto-phase4-corpus-discovery.md §5.
 * A future session wiring in `READ_ONLY_REAL_PRODUCT` https sources MUST
 * reuse `supabase/functions/_shared/net/safeRemoteMedia.ts`'s
 * `assertSafeRemoteMediaUrl` validation rules (https-only, no embedded
 * credentials, reject non-public hosts, re-validate every redirect hop,
 * content-type/size caps) rather than re-deriving weaker ones — that
 * function is Deno-only and unreachable from this Node package, so the
 * rules must be ported, not imported, and kept cited so the two do not
 * silently drift apart. Not implemented here because no https source is
 * exercised this session (task section 8/18: no broadened retailer access).
 */
export function loadSourceImage(ref: Phase4SourceImageRef): LoadResult {
  if (ref.origin !== 'local-fixture') {
    return { ok: false, rejection: { code: 'SOURCE_INVALID', message: `unsupported source origin: ${ref.origin}`, stage: 'source_acquisition' } };
  }
  if (!existsSync(ref.ref)) {
    return { ok: false, rejection: { code: 'SOURCE_INVALID', message: `source file not found: ${ref.ref}`, stage: 'source_acquisition' } };
  }
  const stat = statSync(ref.ref);
  if (stat.size > MAX_BYTES) {
    return { ok: false, rejection: { code: 'SOURCE_INVALID', message: `source file exceeds ${MAX_BYTES} bytes`, stage: 'source_acquisition' } };
  }

  let decoded: DecodedSource;
  try {
    decoded = loadImageFile(ref.ref);
  } catch (err) {
    return { ok: false, rejection: { code: 'SOURCE_INVALID', message: `decode failed: ${(err as Error).message}`, stage: 'source_acquisition' } };
  }

  if (decoded.image.width < MIN_DIMENSION || decoded.image.height < MIN_DIMENSION) {
    return { ok: false, rejection: { code: 'SOURCE_TOO_SMALL', message: `${decoded.image.width}x${decoded.image.height} below minimum ${MIN_DIMENSION}px`, stage: 'source_acquisition' } };
  }

  return { ok: true, decoded };
}
