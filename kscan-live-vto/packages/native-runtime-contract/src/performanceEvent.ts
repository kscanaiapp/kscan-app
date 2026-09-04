/**
 * Performance, adaptive quality, and error/fallback contract — P3-B
 * amendment/original Sections 15, 16, 23, 28, 29, 30.
 *
 * Three concerns kept in one file because they compose directly: a
 * `performanceChanged` event reports the measurements; `AdaptiveQualityLevel`
 * names the manually-selectable response (no automatic policy yet, per
 * Section 16); and the error/fallback contract names what a JS UI is
 * allowed to see when something goes wrong, never a provider-native string.
 */

// ─── performanceChanged event — Section 23/28 ──────────────────────────────

/**
 * The `performanceChanged` event this program's `LiveVTOEventName` union
 * (`@kscan-live-vto/contract`'s `nativeView.ts`) does not yet have a
 * distinct entry for -- today's closest events (`qualityChanged`,
 * `thermalChanged`) each carry one measurement; Section 23 asks for a
 * single event naming performance changes generally. Defined here rather
 * than by editing `nativeView.ts` directly, because the Hard Build Gate is
 * closed this session (see docs/vto-phase3b-native-build-handoff.md) and a
 * native/Swift/Kotlin mirroring update for a changed event surface belongs
 * with the first native build attempt that can actually verify it compiles,
 * not before.
 */
export interface PerformanceChangedEventPayload {
  frameCadenceHz: number | null;
  perceptionLatencyMs: number | null;
  renderLatencyMs: number | null;
  droppedFrameRatio: number | null;
  queueDepth: number | null;
  qualityLevel: AdaptiveQualityLevel;
}

// ─── Structured performance record — Section 15 ────────────────────────────

export const PERFORMANCE_METRICS = [
  'frame_cadence_hz',
  'perception_latency_ms',
  'render_latency_ms',
  'dropped_frame_ratio',
  'queue_depth',
  'memory_bytes',
  'session_duration_ms',
] as const;
export type PerformanceMetric = (typeof PERFORMANCE_METRICS)[number];

/** Minimum schema, verbatim field set from amendment Section 15. */
export interface PerformanceRecord {
  timestamp: number;
  platform: 'ios' | 'android';
  session_id: string;
  metric: PerformanceMetric;
  value: number;
  unit: string;
  frame_source: string; // FrameSource, kept as a plain string here to avoid a frameSource.ts <-> performanceEvent.ts import cycle risk
  perception_provenance: string; // PerceptionProvenance, same reasoning
  quality_level: AdaptiveQualityLevel;
}

/**
 * "Emulator numbers must remain labeled: 'NON-PHYSICAL RUNTIME DATA'"
 * (amendment Section 15) / "EMULATOR PERFORMANCE — NOT DEVICE PERFORMANCE"
 * (original Section 28's near-identical rule, inherited from Phase 1-2's
 * own emulator-native validation lane). One label, reused for both, so a
 * report never has to choose between two similar-but-not-identical strings.
 */
export const NON_PHYSICAL_RUNTIME_DATA_LABEL = 'NON-PHYSICAL RUNTIME DATA — EMULATOR/SIMULATOR, NOT DEVICE PERFORMANCE';

export interface PerformanceDistributionSummary {
  metric: PerformanceMetric;
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
}

/** count/min/max/mean "where statistically meaningful" -- an empty or
 *  single-sample series still returns a shape (count says why there's
 *  nothing more), never throws. */
export function summarizePerformanceRecords(
  records: readonly PerformanceRecord[],
  metric: PerformanceMetric,
): PerformanceDistributionSummary {
  const values = records.filter((r) => r.metric === metric).map((r) => r.value);
  if (values.length === 0) return { metric, count: 0, min: null, max: null, mean: null };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { metric, count: values.length, min, max, mean: sum / values.length };
}

// ─── Adaptive quality — Section 16, manual selection only ──────────────────

export const ADAPTIVE_QUALITY_LEVELS = ['FULL', 'REDUCED', 'MINIMAL', 'FALLBACK'] as const;
export type AdaptiveQualityLevel = (typeof ADAPTIVE_QUALITY_LEVELS)[number];

/**
 * "Do not implement automatic performance-triggered downgrade policies
 * yet... The actual downgrade policy awaits physical-device performance
 * evidence." This function is deliberately the ONLY quality-level mutator
 * this package exposes, and it takes no measurement input at all -- there
 * is structurally no way to wire a performance number into an automatic
 * level change through this contract. A caller (test harness, manual QA
 * toggle) selects a level directly.
 */
export function selectAdaptiveQualityLevel(requested: AdaptiveQualityLevel): AdaptiveQualityLevel {
  if (!(ADAPTIVE_QUALITY_LEVELS as readonly string[]).includes(requested)) {
    throw new RangeError(`Unknown adaptive quality level: ${String(requested)}`);
  }
  return requested;
}

/** Candidate knobs each level could plausibly affect -- architecture only,
 *  per Section 29's "build the architecture needed for later quality
 *  degradation... do not invent final device thresholds yet." No numeric
 *  value is attached to any knob here. */
export const ADAPTIVE_QUALITY_KNOBS = [
  'segmentationCadence',
  'realismEffects',
  'shadowContactCues',
  'renderResolution',
  'lightingAnalysis',
] as const;
export type AdaptiveQualityKnob = (typeof ADAPTIVE_QUALITY_KNOBS)[number];

// ─── Error / fallback UX contract — Section 30 ──────────────────────────────

export const RUNTIME_ERROR_STATES = [
  'CAMERA_UNAVAILABLE',
  'TRACKING_UNAVAILABLE',
  'GARMENT_UNAVAILABLE',
  'DEVICE_LIMITED',
  'PHOTOREAL_UNAVAILABLE',
] as const;
export type RuntimeErrorState = (typeof RUNTIME_ERROR_STATES)[number];

export interface RuntimeErrorEvent {
  state: RuntimeErrorState;
  /** User-facing copy candidate only -- never provider/ML-native text. */
  message: string;
  recoverable: boolean;
}

/**
 * Every provider-native or ML-native error string a real implementation
 * will eventually encounter (an AVFoundation error code, a Vision/
 * MediaPipe error, a CameraX exception) must be mapped through this
 * function rather than surfaced directly -- "Do not expose provider-native
 * or ML-native error strings directly." The `nativeDetail` parameter exists
 * so a native caller can still LOG the real error server-side/on-device;
 * it is never included in the returned `RuntimeErrorEvent`.
 */
export function toRuntimeErrorEvent(
  state: RuntimeErrorState,
  message: string,
  recoverable: boolean,
  _nativeDetail?: string,
): RuntimeErrorEvent {
  return { state, message, recoverable };
}
