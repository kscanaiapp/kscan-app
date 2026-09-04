import type { BatchItemResult } from './batch';
import type { EvidenceClass, RejectionCode, ShotClass } from './types';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function distribution(values: number[]): { count: number; min: number; median: number; p95: number; max: number; mean: number } {
  if (values.length === 0) return { count: 0, min: 0, median: 0, p95: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0],
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}

function countBy<T extends string | number>(items: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[String(item)] = (out[String(item)] ?? 0) + 1;
  return out;
}

export interface GateEReport {
  evidenceClassCounts: Record<string, number>;
  totalItems: number;
  variantAmbiguousCount: number;
  fullyAutomaticSuccessCount: number;
  fullyAutomaticSuccessRate: number;
  rejectionCount: number;
  rejectionRate: number;
  rejectionByCode: Record<string, number>;
  byShotClass: Record<string, { total: number; accepted: number; rejected: number; successRate: number }>;
  byGarmentFamily: Record<string, { total: number; accepted: number }>;
  byEvidenceClass: Record<string, { total: number; accepted: number; rejected: number }>;
  productFidelity: {
    passRate: number;
    fillRatioDistribution: ReturnType<typeof distribution>;
    compactnessDistribution: ReturnType<typeof distribution>;
    metricsWithReferenceCount: number;
    metricsWithoutReferenceCount: number;
  };
  runtime: {
    totalDurationMsDistribution: ReturnType<typeof distribution>;
    perStageDurationMsDistribution: Record<string, ReturnType<typeof distribution>>;
    retryCountTotal: number;
  };
  manualCorrectionMinutes: 'NOT_MEASURED';
  sampleSizeCaveat: string;
}

export function buildGateEReport(items: readonly BatchItemResult[]): GateEReport {
  const withManifest = items.filter((i) => i.manifest !== null);
  const evidenceClassCounts = countBy(withManifest.map((i) => i.manifest!.evidenceClass as EvidenceClass));

  const accepted = withManifest.filter((i) => i.manifest!.eligibility.live2d === true);
  const rejected = withManifest.filter((i) => i.manifest!.rejection !== null);
  const variantAmbiguous = items.filter((i) => i.variantAmbiguous);

  const rejectionByCode = countBy(rejected.map((i) => i.manifest!.rejection!.code as RejectionCode));

  const byShotClass: GateEReport['byShotClass'] = {};
  for (const shotClass of ['EASY', 'MEDIUM', 'HARD', 'UNSUPPORTED'] as ShotClass[]) {
    const inClass = withManifest.filter((i) => i.manifest!.shotClassification.shotClass === shotClass);
    const acceptedInClass = inClass.filter((i) => i.manifest!.eligibility.live2d === true);
    byShotClass[shotClass] = {
      total: inClass.length,
      accepted: acceptedInClass.length,
      rejected: inClass.length - acceptedInClass.length,
      successRate: inClass.length > 0 ? acceptedInClass.length / inClass.length : 0,
    };
  }

  const byGarmentFamily: GateEReport['byGarmentFamily'] = {};
  for (const item of withManifest) {
    const family = item.manifest!.ksgarment ? 'simple-top (only mapped family today)' : 'n/a (rejected before geometry)';
    if (!byGarmentFamily[family]) byGarmentFamily[family] = { total: 0, accepted: 0 };
    byGarmentFamily[family].total++;
    if (item.manifest!.eligibility.live2d) byGarmentFamily[family].accepted++;
  }

  const byEvidenceClass: GateEReport['byEvidenceClass'] = {};
  for (const item of withManifest) {
    const ec = item.manifest!.evidenceClass;
    if (!byEvidenceClass[ec]) byEvidenceClass[ec] = { total: 0, accepted: 0, rejected: 0 };
    byEvidenceClass[ec].total++;
    if (item.manifest!.eligibility.live2d) byEvidenceClass[ec].accepted++;
    else byEvidenceClass[ec].rejected++;
  }

  const withQa = withManifest.filter((i) => i.manifest!.qa !== null);
  const fillRatios = withQa.map((i) => i.manifest!.qa!.silhouette.fillRatio);
  const compactness = withQa.map((i) => i.manifest!.qa!.silhouette.compactness).filter((v) => Number.isFinite(v));
  let referenceCount = 0;
  let noReferenceCount = 0;
  for (const i of withQa) {
    for (const metric of [i.manifest!.qa!.color, i.manifest!.qa!.logo, i.manifest!.qa!.pattern]) {
      if (metric.computable) referenceCount++;
      else noReferenceCount++;
    }
  }

  const allDurations = items.map((i) => i.totalDurationMs);
  const perStage: Record<string, number[]> = {};
  for (const item of withManifest) {
    for (const timing of item.manifest!.stageTimings) {
      perStage[timing.stage] = perStage[timing.stage] ?? [];
      perStage[timing.stage].push(timing.durationMs);
    }
  }
  const perStageDurationMsDistribution: Record<string, ReturnType<typeof distribution>> = {};
  for (const [stage, durations] of Object.entries(perStage)) {
    perStageDurationMsDistribution[stage] = distribution(durations);
  }

  return {
    evidenceClassCounts,
    totalItems: items.length,
    variantAmbiguousCount: variantAmbiguous.length,
    fullyAutomaticSuccessCount: accepted.length,
    fullyAutomaticSuccessRate: withManifest.length > 0 ? accepted.length / withManifest.length : 0,
    rejectionCount: rejected.length,
    rejectionRate: withManifest.length > 0 ? rejected.length / withManifest.length : 0,
    rejectionByCode,
    byShotClass,
    byGarmentFamily,
    byEvidenceClass,
    productFidelity: {
      passRate: withQa.length > 0 ? withQa.filter((i) => i.manifest!.qa!.passed).length / withQa.length : 0,
      fillRatioDistribution: distribution(fillRatios),
      compactnessDistribution: distribution(compactness),
      metricsWithReferenceCount: referenceCount,
      metricsWithoutReferenceCount: noReferenceCount,
    },
    runtime: {
      totalDurationMsDistribution: distribution(allDurations),
      perStageDurationMsDistribution,
      retryCountTotal: items.reduce((a, i) => a + i.retryCount, 0),
    },
    manualCorrectionMinutes: 'NOT_MEASURED',
    sampleSizeCaveat: `across SYNTHETIC + AUTHORIZED_FIXTURE evidence only — not statistically sufficient for a production Gate E PASS; see docs/vto-phase4-corpus-request.md.`,
  };
}
