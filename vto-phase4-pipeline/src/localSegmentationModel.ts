import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { SegmentationPath } from './segmentationBenchmark';

/**
 * Phase 4.2 §29-§30 — PATH B: the single local segmentation model candidate.
 *
 * This module is a GOVERNED LOADING POINT, not a model. It exists so that
 * "we evaluated a local model" and "we shipped a local model" are separate,
 * auditable events, and so that no model can enter the pipeline without its
 * provenance being stated and its weights verified.
 *
 * §29 requires, for any actual candidate: exact model, exact version,
 * license, weights license, provenance, repository/source, checksum,
 * runtime, dependency size, CPU/memory requirements, CI compatibility, and
 * commercial-use implications. None of that may be asserted from memory —
 * §29 says explicitly "Do not claim permissive licensing without
 * verification." So this loader refuses to run a model whose provenance
 * block is not filled in AND whose weights do not hash to the declared
 * checksum.
 *
 * §30 boundaries, enforced structurally:
 *   - The model is loaded from a LOCAL FILE ONLY. There is no download code
 *     in this module, so a runtime model download cannot occur.
 *   - There is no network client here at all, so no third-party segmentation
 *     API can be called. `EXTERNAL SEGMENTATION CALLS: 0` is a property of
 *     the code, not a promise.
 *   - Nothing here is reachable from the app bundle; this package is
 *     local/batch tooling only.
 *
 * CURRENT STATE: no model is installed. `loadLocalSegmentationModel()`
 * returns `available: false` and the benchmark records PATH A only. See
 * docs/vto-phase4-2-segmentation-benchmark.md for the evidence behind that
 * decision — it is a measured conclusion about headroom, not an omission.
 */

export interface ModelProvenance {
  installed: true;
  /** e.g. "U^2-Net" / "BiRefNet" / "RMBG-1.4". */
  model: string;
  /** Exact released version or commit. */
  version: string;
  /** License of the CODE. */
  codeLicense: string;
  /** License of the WEIGHTS — frequently different from the code license, and frequently non-commercial. */
  weightsLicense: string;
  /** Where the weights were obtained from. */
  provenanceUrl: string;
  /** Upstream repository. */
  repositoryUrl: string;
  /** sha256 of the weights file, verified at load. */
  weightsSha256: string;
  weightsBytes: number;
  /** e.g. "onnxruntime-node 1.x, CPU EP". */
  runtime: string;
  approximateMemoryMb: number;
  ciCompatible: boolean;
  /** Explicit, verified statement — never assumed. */
  commercialUseImplications: string;
}

export type LocalSegmentationModelLoad =
  | { available: true; path: SegmentationPath; provenance: ModelProvenance }
  | { available: false; reason: string };

/**
 * Where an installed model would declare itself. Deliberately an env var
 * rather than a checked-in path: installing a model must be a deliberate,
 * visible operator action, never something a checkout silently acquires.
 */
const MODEL_MANIFEST_ENV = 'VTO_PHASE4_LOCAL_SEG_MODEL_MANIFEST';

interface ModelManifestFile {
  provenance: Omit<ModelProvenance, 'installed'>;
  /** Path to the weights file, resolved relative to the manifest. */
  weightsPath: string;
  /** Path to a CommonJS module exporting `segment(image) => SegmentationMask | null`. */
  adapterPath: string;
}

export async function loadLocalSegmentationModel(): Promise<LocalSegmentationModelLoad> {
  const manifestPath = process.env[MODEL_MANIFEST_ENV];
  if (!manifestPath) {
    return {
      available: false,
      reason:
        'No local segmentation model is installed (' +
        MODEL_MANIFEST_ENV +
        ' is unset). PATH B is not evaluated. See docs/vto-phase4-2-segmentation-benchmark.md for the measured headroom evidence behind that decision.',
    };
  }
  if (!existsSync(manifestPath)) {
    return { available: false, reason: 'Model manifest declared but not found at ' + manifestPath + ' — refusing to proceed rather than silently skipping PATH B.' };
  }

  let manifest: ModelManifestFile;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ModelManifestFile;
  } catch (err) {
    return { available: false, reason: 'Model manifest is not readable JSON: ' + (err as Error).message };
  }

  // §29: every provenance field must be present and non-empty. A blank
  // license field is treated as UNVERIFIED, never as permissive.
  const required: (keyof Omit<ModelProvenance, 'installed'>)[] = [
    'model',
    'version',
    'codeLicense',
    'weightsLicense',
    'provenanceUrl',
    'repositoryUrl',
    'weightsSha256',
    'runtime',
    'commercialUseImplications',
  ];
  const missing = required.filter((k) => {
    const v = manifest.provenance?.[k];
    return v === undefined || v === null || String(v).trim() === '';
  });
  if (missing.length > 0) {
    return {
      available: false,
      reason:
        'Model manifest is missing required §29 provenance fields: ' +
        missing.join(', ') +
        '. An unverified license is treated as UNVERIFIED, never as permissive — refusing to load.',
    };
  }

  if (!existsSync(manifest.weightsPath)) {
    return { available: false, reason: 'Declared weights file not found: ' + manifest.weightsPath };
  }
  const weights = readFileSync(manifest.weightsPath);
  const actualSha = createHash('sha256').update(weights).digest('hex');
  if (actualSha !== manifest.provenance.weightsSha256) {
    return {
      available: false,
      reason:
        'Weights checksum mismatch — declared ' +
        manifest.provenance.weightsSha256 +
        ', actual ' +
        actualSha +
        '. Refusing to run unverified weights.',
    };
  }

  let adapter: { segment?: SegmentationPath['segment'] };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    adapter = require(manifest.adapterPath) as { segment?: SegmentationPath['segment'] };
  } catch (err) {
    return { available: false, reason: 'Model adapter failed to load: ' + (err as Error).message };
  }
  if (typeof adapter.segment !== 'function') {
    return { available: false, reason: 'Model adapter does not export a segment(image) function.' };
  }

  const provenance: ModelProvenance = {
    installed: true,
    ...manifest.provenance,
    weightsBytes: weights.length,
    weightsSha256: actualSha,
  };

  return {
    available: true,
    provenance,
    path: {
      id: 'local-model:' + provenance.model + '@' + provenance.version,
      version: provenance.version + '+sha256:' + actualSha.slice(0, 16),
      kind: 'local-model',
      segment: adapter.segment,
    },
  };
}
