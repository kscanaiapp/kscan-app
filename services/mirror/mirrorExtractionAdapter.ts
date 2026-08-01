// Mirror Selfie extraction adapter (Build 2.5 Step 3).
//
// THE ONE BOUNDARY between the Mirror pipeline and on-device inference.
// Everything above this file is pure TypeScript with no native dependency;
// everything below it is ML Kit pose detection on Android and Apple Vision on
// iOS, inside the existing local Expo module `modules/kscan-pii-native`.
//
// WHAT CROSSES THE BOUNDARY, and nothing else:
//   in   a file:// URI to an app-owned, upright, metadata-free JPEG
//   out  normalized 0..1 person bounds, body landmarks, and a coverage figure
//
// No pixels come back. No path is logged. No coordinate reaches telemetry.
//
// ── CANCELLATION IS ADVISORY, AND THAT IS DESIGNED FOR ──────────────────────
//
// Neither ML Kit's detector nor a Vision request handler can be interrupted
// once processing has begun. Pretending otherwise would be the bug. Instead the
// session holds a monotonic token: `cancel()` marks the token dead immediately
// and returns, and a result that arrives afterwards is DISCARDED by the caller
// — see mirrorExtractionSession.ts, which also deletes any file a late run
// managed to create. The user's cancel is therefore instant and truthful even
// though the inference is still winding down in the background.

import type { NormalizedBounds } from '../../types/mirrorExtraction';

/**
 * The landmark subset BOTH runtimes produce reliably.
 *
 * ML Kit Pose Detection reports 33 landmarks and Apple Vision's body-pose
 * request reports 19. This is the intersection that matters for garment
 * geometry — deliberately not the union, because a region whose edge is
 * defined by a landmark only one platform has would place that edge
 * differently on the two platforms, and the crops would diverge.
 */
export type MirrorLandmarkType =
  | 'nose'
  | 'left_shoulder'
  | 'right_shoulder'
  | 'left_hip'
  | 'right_hip'
  | 'left_knee'
  | 'right_knee'
  | 'left_ankle'
  | 'right_ankle';

export const MIRROR_LANDMARK_TYPES: readonly MirrorLandmarkType[] = [
  'nose',
  'left_shoulder',
  'right_shoulder',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
] as const;

export type MirrorLandmark = {
  type: MirrorLandmarkType;
  /** Normalized to the inference image, 0..1. */
  x: number;
  y: number;
  /** 0..1. Platforms report this differently; both are clamped native-side. */
  confidence: number;
};

export type MirrorDetectedPerson = {
  /** Best available body extent. Region derivation clamps to this. */
  bounds: NormalizedBounds;
  /**
   * Like-for-like extent used ONLY to rank candidates against each other.
   *
   * ML Kit pose detection returns one subject per image, so Android's
   * multi-person signal comes from the bundled face detector. Comparing a
   * pose-derived body box against other people's face boxes would let the posed
   * subject win automatically — including when someone is standing right beside
   * them, the exact case that must stop and ask. Ranking therefore uses one
   * consistent kind of region per platform; see the native contract.
   */
  rankingExtent: NormalizedBounds;
  confidence: number;
  landmarks: MirrorLandmark[];
  /**
   * Fraction of `bounds` the person segmentation mask fills, 0..1.
   *
   * `null` when the platform did not produce a mask. A low value means the
   * bounding box is mostly background — a person at an angle, or a bad box —
   * and is one of the signals that demotes a region to `review`.
   */
  maskCoverage: number | null;
};

export type MirrorDetectionOutcome =
  | {
      kind: 'ok';
      persons: MirrorDetectedPerson[];
      detector: string;
      detectorVersion: string;
      /** Wall-clock inside the native call. Bucketed before it can be emitted. */
      durationMs: number;
    }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'failed'; reason: string };

export type MirrorExtractionAdapter = {
  readonly id: string;
  /** True only when a real on-device runtime is present. */
  isSupported(): Promise<boolean>;
  detectPersons(input: { imageUri: string }): Promise<MirrorDetectionOutcome>;
};

// ── Normalization helpers, applied to EVERY adapter's output ────────────────

function clamp01(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Force a rect inside the unit square without changing which pixels it names.
 *
 * A detector may report a box that runs off the frame — a person cropped by the
 * image edge is the normal case, not an error. Clamping the EDGES rather than
 * rejecting the box keeps that person.
 */
export function normalizeBounds(raw: unknown): NormalizedBounds | null {
  const source = raw as Partial<NormalizedBounds>;
  if (!source || typeof source !== 'object') return null;
  const x0 = clamp01(source.x);
  const y0 = clamp01(source.y);
  const x1 = clamp01(Number(source.x) + Number(source.width));
  const y1 = clamp01(Number(source.y) + Number(source.height));
  const width = x1 - x0;
  const height = y1 - y0;
  if (!(width > 0) || !(height > 0)) return null;
  return { x: x0, y: y0, width, height };
}

/**
 * Coerce whatever the bridge delivered into the declared shape.
 *
 * Runs on every adapter including the native one. A native module is a trusted
 * component, but it is also the component most likely to change shape under a
 * platform upgrade, and a NaN coordinate reaching the crop stage would produce
 * a garbage crop rather than a loud failure.
 */
export function normalizeDetectedPerson(raw: unknown): MirrorDetectedPerson | null {
  const source = raw as any;
  if (!source || typeof source !== 'object') return null;
  const bounds = normalizeBounds(source.bounds);
  if (!bounds) return null;

  const seen = new Set<MirrorLandmarkType>();
  const landmarks: MirrorLandmark[] = [];
  const rawLandmarks = Array.isArray(source.landmarks) ? source.landmarks : [];
  for (const entry of rawLandmarks) {
    const type = entry?.type;
    if (!MIRROR_LANDMARK_TYPES.includes(type)) continue;
    // First occurrence wins, so a duplicated joint cannot silently move an edge.
    if (seen.has(type)) continue;
    const x = Number(entry?.x);
    const y = Number(entry?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    seen.add(type);
    landmarks.push({ type, x: clamp01(x), y: clamp01(y), confidence: clamp01(entry?.confidence) });
  }

  // Stable order regardless of what the platform emitted, so downstream
  // geometry is reproducible across platforms.
  landmarks.sort(
    (a, b) => MIRROR_LANDMARK_TYPES.indexOf(a.type) - MIRROR_LANDMARK_TYPES.indexOf(b.type),
  );

  const maskCoverage =
    source.maskCoverage === null || source.maskCoverage === undefined
      ? null
      : clamp01(source.maskCoverage);

  // A runtime that omits the ranking extent falls back to the body bounds. That
  // is correct for any platform where the two are the same region (iOS), and is
  // the only safe default for a future one.
  const rankingExtent = normalizeBounds(source.rankingExtent) ?? bounds;

  return { bounds, rankingExtent, confidence: clamp01(source.confidence), landmarks, maskCoverage };
}

// ── Native adapter ──────────────────────────────────────────────────────────

/**
 * Bind the real runtime.
 *
 * The module is imported LAZILY and inside a try. `requireNativeModule` throws
 * when the module is absent from the running binary — which is exactly the
 * state of every build that has not been recompiled since this branch — and an
 * unguarded import at module scope would crash the Closet screen on import
 * rather than degrade to `unsupported`.
 */
export function createNativeMirrorExtractionAdapter(
  deps: { loadModule?: () => any } = {},
): MirrorExtractionAdapter {
  const loadModule =
    deps.loadModule ??
    (() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('../../modules/kscan-pii-native');
    });

  let cached: any;
  let attempted = false;

  function module(): any {
    if (!attempted) {
      attempted = true;
      try {
        cached = loadModule();
      } catch {
        cached = null;
      }
    }
    return cached;
  }

  return {
    id: 'native',

    async isSupported(): Promise<boolean> {
      const mod = module();
      if (!mod || typeof mod.getExtractionCapabilities !== 'function') return false;
      try {
        const caps = await mod.getExtractionCapabilities();
        return caps?.personDetectionSupported === true;
      } catch {
        return false;
      }
    },

    async detectPersons({ imageUri }): Promise<MirrorDetectionOutcome> {
      const mod = module();
      if (!mod || typeof mod.detectPersonRegions !== 'function') {
        return { kind: 'unsupported', reason: 'native_module_absent' };
      }
      let raw: any;
      try {
        raw = await mod.detectPersonRegions({ imageUri });
      } catch {
        return { kind: 'failed', reason: 'native_call_threw' };
      }

      if (raw?.status === 'unsupported') {
        return { kind: 'unsupported', reason: 'runtime_reports_unsupported' };
      }
      if (raw?.status === 'failed') {
        // The native failure reason is bounded (NativeExtractionErrorCode) and
        // is carried as a code, never as an exception message.
        return { kind: 'failed', reason: String(raw?.errorCode ?? 'DETECTION_FAILED') };
      }
      if (raw?.status !== 'success' && raw?.status !== 'no_person') {
        return { kind: 'failed', reason: 'unrecognized_native_status' };
      }

      const persons = (Array.isArray(raw?.persons) ? raw.persons : [])
        .map(normalizeDetectedPerson)
        .filter(Boolean) as MirrorDetectedPerson[];

      return {
        kind: 'ok',
        persons,
        detector: String(raw?.detectorImplementation ?? 'unknown'),
        detectorVersion: String(raw?.detectorVersion ?? ''),
        durationMs: Number(raw?.totalDurationMs) || 0,
      };
    },
  };
}

/**
 * Adapter used when no runtime is present.
 *
 * Returns `unsupported`, never an empty success. The difference matters: an
 * empty success would be reported to the user as "no person in this photo",
 * blaming their photograph for a missing binary.
 */
export const unsupportedMirrorExtractionAdapter: MirrorExtractionAdapter = {
  id: 'unsupported',
  async isSupported() {
    return false;
  },
  async detectPersons() {
    return { kind: 'unsupported', reason: 'no_extraction_runtime_in_this_build' };
  },
};

/**
 * Controlled adapter for unit and integration tests.
 *
 * IT PROVES ORCHESTRATION AND NOTHING ELSE. It cannot demonstrate that
 * extraction works — that requires the real runtime on a real device, and no
 * verdict in this build may be based on it. It exists so the session lifecycle,
 * person resolution, ordering, dedup, cleanup, telemetry and domain separation
 * can be tested deterministically and without a device.
 */
export function createControlledMirrorExtractionAdapter(config: {
  persons?: unknown[];
  outcome?: 'ok' | 'unsupported' | 'failed';
  /** Resolves only when the returned release() is called. */
  deferred?: boolean;
  onDetect?: (imageUri: string) => void;
}): MirrorExtractionAdapter & { release: () => void; callCount: () => number } {
  let pending: (() => void) | null = null;
  let calls = 0;

  return {
    id: 'controlled',
    async isSupported() {
      return (config.outcome ?? 'ok') !== 'unsupported';
    },
    async detectPersons({ imageUri }): Promise<MirrorDetectionOutcome> {
      calls += 1;
      config.onDetect?.(imageUri);
      if (config.deferred) {
        await new Promise<void>((resolve) => {
          pending = resolve;
        });
      }
      const outcome = config.outcome ?? 'ok';
      if (outcome === 'unsupported') {
        return { kind: 'unsupported', reason: 'controlled' };
      }
      if (outcome === 'failed') {
        return { kind: 'failed', reason: 'controlled' };
      }
      return {
        kind: 'ok',
        persons: (config.persons ?? []).map(normalizeDetectedPerson).filter(Boolean) as MirrorDetectedPerson[],
        detector: 'controlled',
        detectorVersion: '0',
        durationMs: 0,
      };
    },
    release() {
      pending?.();
      pending = null;
    },
    callCount() {
      return calls;
    },
  };
}
