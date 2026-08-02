'use strict';

const STATISTICS_CONTRACT_VERSION = '1.0.0';

function wilsonInterval(successes, n, z = 1.959963984540054) {
  if (!Number.isInteger(successes) || !Number.isInteger(n) || successes < 0 || n < 0 || successes > n) {
    throw new Error('Wilson interval requires integer 0 <= successes <= n');
  }
  if (n === 0) return { n: 0, successes: 0, rate: null, lower: null, upper: null };
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / denominator;
  return { n, successes, rate: p, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function binomialCoefficient(n, k) {
  const m = Math.min(k, n - k);
  let value = 1;
  for (let i = 1; i <= m; i += 1) value = (value * (n - m + i)) / i;
  return value;
}

function exactMcNemar(control, candidate) {
  if (!Array.isArray(control) || control.length !== candidate.length) {
    throw new Error('paired binary arrays must have identical length');
  }
  let controlOnly = 0;
  let candidateOnly = 0;
  let bothCorrect = 0;
  let bothWrong = 0;
  for (let i = 0; i < control.length; i += 1) {
    const a = control[i] === true;
    const b = candidate[i] === true;
    if (a && b) bothCorrect += 1;
    else if (a) controlOnly += 1;
    else if (b) candidateOnly += 1;
    else bothWrong += 1;
  }
  const discordant = controlOnly + candidateOnly;
  let pValue = 1;
  if (discordant > 0) {
    const tail = Math.min(controlOnly, candidateOnly);
    let probability = 0;
    for (let k = 0; k <= tail; k += 1) {
      probability += binomialCoefficient(discordant, k) * Math.pow(0.5, discordant);
    }
    pValue = Math.min(1, 2 * probability);
  }
  return { bothCorrect, bothWrong, controlOnly, candidateOnly, discordant, twoSidedExactPValue: pValue };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pairedBootstrapMeanDelta(control, candidate, options = {}) {
  if (!Array.isArray(control) || control.length === 0 || control.length !== candidate.length) {
    throw new Error('paired bootstrap requires equal non-empty arrays');
  }
  const iterations = options.iterations || 5000;
  const seed = options.seed == null ? 140031 : options.seed;
  const random = seededRandom(seed);
  const deltas = control.map((value, index) => candidate[index] - value);
  const observed = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    for (let index = 0; index < deltas.length; index += 1) {
      sum += deltas[Math.floor(random() * deltas.length)];
    }
    samples.push(sum / deltas.length);
  }
  samples.sort((a, b) => a - b);
  const percentile = (q) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
  return { n: deltas.length, observedDelta: observed, lower95: percentile(0.025), upper95: percentile(0.975), iterations, seed };
}

function pairedBinaryReport(control, candidate) {
  const n = control.length;
  const controlHits = control.filter(Boolean).length;
  const candidateHits = candidate.filter(Boolean).length;
  return {
    statisticsContractVersion: STATISTICS_CONTRACT_VERSION,
    n,
    evidenceLabel: n < 100 ? 'PILOT EVIDENCE - NOT SUFFICIENT ALONE FOR PRODUCTION PROMOTION' : 'GOVERNED EVIDENCE',
    control: wilsonInterval(controlHits, n),
    candidate: wilsonInterval(candidateHits, n),
    absoluteDelta: candidateHits / n - controlHits / n,
    mcnemar: exactMcNemar(control, candidate),
  };
}

module.exports = { STATISTICS_CONTRACT_VERSION, wilsonInterval, exactMcNemar, pairedBootstrapMeanDelta, pairedBinaryReport };
