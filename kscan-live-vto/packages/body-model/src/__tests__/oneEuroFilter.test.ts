import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OneEuroFilter, OneEuroPointFilter, DEFAULT_ONE_EURO_CONFIG } from '../oneEuroFilter';

test('OneEuroFilter passes the first sample through unchanged (no history to smooth against)', () => {
  const filter = new OneEuroFilter();
  assert.equal(filter.filter(0.42, 0), 0.42);
});

test('OneEuroFilter holds steady on a constant signal', () => {
  const filter = new OneEuroFilter();
  let last = filter.filter(1.0, 0);
  for (let t = 16; t <= 320; t += 16) {
    last = filter.filter(1.0, t);
  }
  assert.ok(Math.abs(last - 1.0) < 1e-9);
});

test('OneEuroFilter reduces jitter variance relative to the raw noisy signal', () => {
  const filter = new OneEuroFilter({ minCutoff: 1.0, beta: 0.0, derivativeCutoff: 1.0 });
  const raw: number[] = [];
  const filtered: number[] = [];
  // Deterministic pseudo-noise around a constant 0.5, ~60fps.
  let seed = 12345;
  const pseudoRandom = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 120; i++) {
    const t = i * 16.6667;
    const noisy = 0.5 + (pseudoRandom() - 0.5) * 0.05;
    raw.push(noisy);
    filtered.push(filter.filter(noisy, t));
  }
  const variance = (xs: number[]) => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    return xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  };
  assert.ok(variance(filtered) < variance(raw), 'filtered signal should be smoother than raw input');
});

test('OneEuroFilter reset() forgets history so the next sample passes through unchanged', () => {
  const filter = new OneEuroFilter();
  filter.filter(1.0, 0);
  filter.filter(1.0, 16);
  filter.reset();
  assert.equal(filter.filter(9.0, 100), 9.0);
});

test('OneEuroFilter rejects non-positive cutoffs', () => {
  assert.throws(() => new OneEuroFilter({ ...DEFAULT_ONE_EURO_CONFIG, minCutoff: 0 }));
  assert.throws(() => new OneEuroFilter({ ...DEFAULT_ONE_EURO_CONFIG, derivativeCutoff: -1 }));
});

test('OneEuroPointFilter filters u and v independently', () => {
  const pf = new OneEuroPointFilter();
  const first = pf.filter({ u: 0.2, v: 0.8 }, 0);
  assert.deepEqual(first, { u: 0.2, v: 0.8 });
  const second = pf.filter({ u: 0.2, v: 0.8 }, 16);
  assert.ok(Math.abs(second.u - 0.2) < 1e-9);
  assert.ok(Math.abs(second.v - 0.8) < 1e-9);
});
