/**
 * One Euro Filter — Casiez, Roussel, Vogel, "1€ Filter: A Simple Speed-based
 * Low-pass Filter for Noisy Input in Interactive Systems" (CHI 2012).
 *
 * Section P1-B2: "Begin with a simple proven temporal filter such as One
 * Euro where suitable. Only benchmark alternatives when a specific defect
 * justifies it." This is a direct, from-the-paper implementation — not a
 * novel variant — precisely so its behavior is well understood and any
 * observed defect can be attributed to parameter tuning rather than an
 * implementation bug.
 *
 * One filter instance smooths one scalar signal over time. Landmark
 * filtering (2D points) uses two instances, one per axis — see
 * `bodyFrame.ts`'s consumer in the native pose adapter (not this package;
 * this package only owns the math).
 */

interface LowPassState {
  initialized: boolean;
  hatXPrev: number;
}

function lowPassFilter(state: LowPassState, x: number, alpha: number): number {
  const hatX = state.initialized ? alpha * x + (1 - alpha) * state.hatXPrev : x;
  state.initialized = true;
  state.hatXPrev = hatX;
  return hatX;
}

export interface OneEuroFilterConfig {
  /** Minimum cutoff frequency (Hz). Lower = smoother but more lag at low speed. */
  minCutoff: number;
  /** Speed coefficient. Higher = less lag during fast movement, at the cost of more jitter. */
  beta: number;
  /** Cutoff frequency for the derivative's own low-pass filter (Hz). */
  derivativeCutoff: number;
}

/**
 * Section 29: placeholder pending device/sequence calibration, not a
 * validated production value — see docs/vto-risk-register.md RISK 3.
 * mincutoff=1.0, beta=0.0, dcutoff=1.0 are the paper's own suggested
 * starting defaults for screen-pointer-style signals; landmark tracking
 * may need different values once golden-sequence jitter data exists.
 */
export const DEFAULT_ONE_EURO_CONFIG: OneEuroFilterConfig = {
  minCutoff: 1.0,
  beta: 0.0,
  derivativeCutoff: 1.0,
};

export class OneEuroFilter {
  private readonly config: OneEuroFilterConfig;
  private readonly xFilter: LowPassState = { initialized: false, hatXPrev: 0 };
  private readonly dxFilter: LowPassState = { initialized: false, hatXPrev: 0 };
  private lastTimestampMs: number | null = null;
  private lastX: number | null = null;

  constructor(config: OneEuroFilterConfig = DEFAULT_ONE_EURO_CONFIG) {
    if (config.minCutoff <= 0) throw new RangeError('minCutoff must be > 0');
    if (config.derivativeCutoff <= 0) throw new RangeError('derivativeCutoff must be > 0');
    this.config = config;
  }

  private alpha(cutoffHz: number, samplingPeriodSec: number): number {
    const tau = 1 / (2 * Math.PI * cutoffHz);
    return 1 / (1 + tau / samplingPeriodSec);
  }

  /**
   * @param x raw sample
   * @param timestampMs monotonic capture timestamp in ms (BodyFrame.timestamp)
   */
  filter(x: number, timestampMs: number): number {
    if (this.lastTimestampMs === null) {
      this.lastTimestampMs = timestampMs;
      this.lastX = x;
      this.xFilter.initialized = true;
      this.xFilter.hatXPrev = x;
      return x;
    }

    const dtSec = (timestampMs - this.lastTimestampMs) / 1000;
    // Guard against non-monotonic or zero-delta timestamps (duplicate
    // frames, clock jitter) rather than dividing by zero.
    const samplingPeriodSec = dtSec > 0 ? dtSec : 1 / 60;
    const freqHz = 1 / samplingPeriodSec;

    const dx = (x - (this.lastX ?? x)) * freqHz;
    const edx = lowPassFilter(this.dxFilter, dx, this.alpha(this.config.derivativeCutoff, samplingPeriodSec));

    const cutoff = this.config.minCutoff + this.config.beta * Math.abs(edx);
    const filtered = lowPassFilter(this.xFilter, x, this.alpha(cutoff, samplingPeriodSec));

    this.lastTimestampMs = timestampMs;
    this.lastX = x;
    return filtered;
  }

  reset(): void {
    this.xFilter.initialized = false;
    this.dxFilter.initialized = false;
    this.lastTimestampMs = null;
    this.lastX = null;
  }
}

/** Convenience wrapper: filters a BodyFrame Point2D's u and v independently. */
export class OneEuroPointFilter {
  private readonly u: OneEuroFilter;
  private readonly v: OneEuroFilter;

  constructor(config: OneEuroFilterConfig = DEFAULT_ONE_EURO_CONFIG) {
    this.u = new OneEuroFilter(config);
    this.v = new OneEuroFilter(config);
  }

  filter(point: { u: number; v: number }, timestampMs: number): { u: number; v: number } {
    return {
      u: this.u.filter(point.u, timestampMs),
      v: this.v.filter(point.v, timestampMs),
    };
  }

  reset(): void {
    this.u.reset();
    this.v.reset();
  }
}
