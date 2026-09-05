import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writePngFile } from './codec';
import type { RgbaImage } from './pixels';
import type { Phase4AssetManifest } from './types';

export interface PersistResult {
  written: boolean;
  skippedIdempotent: boolean;
  staleMarked: string[];
}

function assetDir(outputRoot: string, assetId: string): string {
  return join(outputRoot, assetId);
}

/** Scans every previously written bundle. Small-N local directory scan — adequate for this lane's batch sizes (task section 41: "a local batch runner is sufficient"). */
export function scanExistingManifests(outputRoot: string): Phase4AssetManifest[] {
  if (!existsSync(outputRoot)) return [];
  const manifests: Phase4AssetManifest[] = [];
  for (const entry of readdirSync(outputRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(outputRoot, entry.name, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    try {
      manifests.push(JSON.parse(readFileSync(manifestPath, 'utf8')) as Phase4AssetManifest);
    } catch {
      // Corrupt/partial manifest from an interrupted run — skip, don't crash the batch.
    }
  }
  return manifests;
}

/**
 * Idempotent, staleness-aware persistence (task sections 28-30):
 *  - Re-running the same source + same pipeline/contract version for the
 *    same asset id is a no-op (`skippedIdempotent: true`), never a
 *    duplicate.
 *  - Any OTHER currently-CURRENT asset for the same product+variant gets
 *    retroactively marked STALE — an old asset can never silently remain
 *    "current" once a new source image/pipeline run supersedes it.
 */
export function persistAsset(
  outputRoot: string,
  manifest: Phase4AssetManifest,
  texture: RgbaImage | null,
  alphaMask: RgbaImage | null,
  opts: { force?: boolean } = {},
): PersistResult {
  const dir = assetDir(outputRoot, manifest.assetId);
  const manifestPath = join(dir, 'manifest.json');

  let skippedIdempotent = false;
  if (existsSync(manifestPath) && !opts.force) {
    try {
      const existing = JSON.parse(readFileSync(manifestPath, 'utf8')) as Phase4AssetManifest;
      if (
        existing.source.sha256 === manifest.source.sha256 &&
        existing.pipelineVersion === manifest.pipelineVersion &&
        existing.contractVersion === manifest.contractVersion &&
        existing.status !== 'STALE'
      ) {
        skippedIdempotent = true;
      }
    } catch {
      // Corrupt existing file — proceed to overwrite.
    }
  }

  const staleMarked: string[] = [];
  const all = scanExistingManifests(outputRoot);
  for (const other of all) {
    if (other.assetId === manifest.assetId) continue;
    if (
      other.productIdentity.productRef === manifest.productIdentity.productRef &&
      other.productIdentity.variantId === manifest.productIdentity.variantId &&
      other.status === 'CURRENT'
    ) {
      other.status = 'STALE';
      writeFileSync(join(assetDir(outputRoot, other.assetId), 'manifest.json'), JSON.stringify(other, null, 2));
      staleMarked.push(other.assetId);
    }
  }

  if (skippedIdempotent) {
    return { written: false, skippedIdempotent: true, staleMarked };
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  if (texture) writePngFile(join(dir, 'texture.png'), texture);
  if (alphaMask) writePngFile(join(dir, 'alpha.png'), alphaMask);

  return { written: true, skippedIdempotent: false, staleMarked };
}
