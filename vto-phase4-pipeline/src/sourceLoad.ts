import { existsSync, statSync } from 'node:fs';
import { DecodeError, decodeImageBytes, loadImageFile, type DecodedSource } from './codec';
import { resolveSafeRemoteMedia } from './remoteMediaGuard';
import type { Phase4SourceImageRef, Rejection, SystemError } from './types';

const MIN_DIMENSION = 40;
const MAX_BYTES = 25 * 1024 * 1024;
/** Bound on the actual GET (network timeout only — byte cap is enforced by resolveSafeRemoteMedia's HEAD probe plus a post-fetch check below). */
const FETCH_TIMEOUT_MS = 20_000;

export type LoadResult =
  | { ok: true; decoded: DecodedSource }
  | { ok: false; kind: 'rejected'; rejection: Rejection }
  | { ok: false; kind: 'systemError'; systemError: SystemError };

function decodeErrorToSystemError(err: DecodeError, stage: 'source_acquisition' = 'source_acquisition'): SystemError {
  return { code: err.code, message: err.message, stage, ...(err.format ? { format: err.format } : {}) };
}

/**
 * Local, already-authorized fixture files only (`origin: 'local-fixture'`)
 * — see docs/vto-phase4-corpus-discovery.md §5.
 */
async function loadLocalFixture(ref: Phase4SourceImageRef): Promise<LoadResult> {
  if (!existsSync(ref.ref)) {
    return { ok: false, kind: 'systemError', systemError: { code: 'SOURCE_FETCH_FAILED', message: `source file not found: ${ref.ref}`, stage: 'source_acquisition' } };
  }
  const stat = statSync(ref.ref);
  if (stat.size > MAX_BYTES) {
    return { ok: false, kind: 'systemError', systemError: { code: 'DECODE_FAILED', message: `source file exceeds ${MAX_BYTES} bytes`, stage: 'source_acquisition' } };
  }

  let decoded: DecodedSource;
  try {
    decoded = await loadImageFile(ref.ref);
  } catch (err) {
    if (err instanceof DecodeError) {
      return { ok: false, kind: 'systemError', systemError: decodeErrorToSystemError(err) };
    }
    return { ok: false, kind: 'systemError', systemError: { code: 'DECODE_FAILED', message: `decode failed: ${(err as Error).message}`, stage: 'source_acquisition' } };
  }

  if (decoded.image.width < MIN_DIMENSION || decoded.image.height < MIN_DIMENSION) {
    return { ok: false, kind: 'rejected', rejection: { code: 'SOURCE_TOO_SMALL', message: `${decoded.image.width}x${decoded.image.height} below minimum ${MIN_DIMENSION}px`, stage: 'source_acquisition' } };
  }

  return { ok: true, decoded };
}

/**
 * Real-corpus https source (Phase 4.1 addendum — Gate E unblock). Every URL
 * is validated by `remoteMediaGuard.ts` (a cited, faithful port of
 * `supabase/functions/_shared/net/safeRemoteMedia.ts`) BEFORE any request
 * is made, including a manual-redirect HEAD probe so a redirect to a
 * private/non-public host is rejected rather than followed.
 *
 * Byte-cap note: `resolveSafeRemoteMedia`'s HEAD probe enforces the
 * declared `Content-Length` against `REMOTE_MEDIA_MAX_BYTES`, and the GET
 * below re-checks the actual downloaded byte count afterward as
 * defense-in-depth (a lying/absent Content-Length is possible). True
 * incrementally-aborting streaming was not implemented: every URL passed
 * here originates from this lane's own controlled Commerce query — never
 * from arbitrary caller/user input — so a bounded post-fetch check is a
 * proportionate, explicitly-scoped tradeoff, not a general-purpose SSRF/DoS
 * control (see remoteMediaGuard.ts's own header for that boundary).
 */
async function fetchRemoteSource(ref: Phase4SourceImageRef): Promise<LoadResult> {
  const resolved = await resolveSafeRemoteMedia(ref.ref, { fetch, maxRedirects: 3 });
  if (!resolved.ok) {
    return { ok: false, kind: 'systemError', systemError: { code: 'SOURCE_FETCH_FAILED', message: `blocked/unreachable: ${resolved.reason}`, stage: 'source_acquisition' } };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let bytes: Buffer;
  try {
    const response = await fetch(resolved.url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      return { ok: false, kind: 'systemError', systemError: { code: 'SOURCE_FETCH_FAILED', message: `upstream returned ${response.status}`, stage: 'source_acquisition' } };
    }
    const arrayBuffer = await response.arrayBuffer();
    bytes = Buffer.from(arrayBuffer);
  } catch (err) {
    return { ok: false, kind: 'systemError', systemError: { code: 'SOURCE_FETCH_FAILED', message: `fetch failed: ${(err as Error).message}`, stage: 'source_acquisition' } };
  } finally {
    clearTimeout(timeout);
  }

  if (bytes.length > MAX_BYTES) {
    return { ok: false, kind: 'systemError', systemError: { code: 'DECODE_FAILED', message: `fetched ${bytes.length} bytes, exceeds ${MAX_BYTES} byte cap`, stage: 'source_acquisition' } };
  }

  let decoded: DecodedSource;
  try {
    decoded = await decodeImageBytes(bytes);
  } catch (err) {
    if (err instanceof DecodeError) {
      return { ok: false, kind: 'systemError', systemError: decodeErrorToSystemError(err) };
    }
    return { ok: false, kind: 'systemError', systemError: { code: 'DECODE_FAILED', message: `decode failed: ${(err as Error).message}`, stage: 'source_acquisition' } };
  }

  if (decoded.image.width < MIN_DIMENSION || decoded.image.height < MIN_DIMENSION) {
    return { ok: false, kind: 'rejected', rejection: { code: 'SOURCE_TOO_SMALL', message: `${decoded.image.width}x${decoded.image.height} below minimum ${MIN_DIMENSION}px`, stage: 'source_acquisition' } };
  }

  return { ok: true, decoded };
}

export async function loadSourceImage(ref: Phase4SourceImageRef): Promise<LoadResult> {
  if (ref.origin === 'local-fixture') return loadLocalFixture(ref);
  if (ref.origin === 'https-fetch') return fetchRemoteSource(ref);
  return { ok: false, kind: 'systemError', systemError: { code: 'INVALID_INPUT', message: `unsupported source origin: ${(ref as Phase4SourceImageRef).origin}`, stage: 'source_acquisition' } };
}
