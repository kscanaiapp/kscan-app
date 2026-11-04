/**
 * VRI-03 collection-kit import: owner sheets → manifest + human result labels.
 *
 *   docs/vri-03/collection-kit/intake.csv.txt           → failure-set manifest
 *   docs/vri-03/collection-kit/results-labeling.csv.txt → per-result labels
 *
 * Reviewer initials stay in the sheet and are reduced to a reviewer COUNT in
 * the manifest. The manifest gate then decides whether the set is usable.
 * Nothing is inferred: a blank cell stays blank, and the gate rejects it.
 *
 * Offline and pure.
 */

import { MATCH_LABELS } from './manifestGate.ts';
import type { MatchLabel } from './metrics.ts';

export const INTAKE_COLUMNS = [
  'itemId', 'imageDigest', 'consentPolicyId', 'consentEvidenceId', 'consentedAt', 'scene', 'type', 'brandVisible',
  'blackOwnedRelevance', 'targetDescription', 'googleRetailerDomain', 'googleProductTitle', 'googleCapturedAt', 'market',
  'purchasable', 'truthCategory', 'truthSubtype', 'reviewer1Initials', 'reviewer2Initials', 'adjudicated',
] as const;

export const LABELING_COLUMNS = [
  'itemId', 'arm', 'stage', 'rank', 'canonicalUrl', 'merchant', 'label', 'reviewer1Label', 'reviewer2Label', 'adjudicatedLabel',
] as const;

/** RFC 4180-style CSV: quoted fields, escaped quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (quoted) throw new Error('CSV: unterminated quoted field');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function toRecords(text: string, columns: readonly string[]): { records: Record<string, string>[]; issues: string[] } {
  const rows = parseCsv(text);
  const issues: string[] = [];
  if (!rows.length) return { records: [], issues: ['sheet is empty'] };
  const header = rows[0].map((h) => h.trim());
  if (header.join(',') !== columns.join(',')) issues.push(`header must be exactly: ${columns.join(',')}`);
  const records = rows.slice(1).map((r, i) => {
    if (r.length !== columns.length) issues.push(`row ${i + 2}: expected ${columns.length} columns, got ${r.length}`);
    return Object.fromEntries(columns.map((c, j) => [c, (r[j] ?? '').trim()]));
  });
  return { records, issues };
}

function bool(v: string): boolean | string {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v; // left as-is so the gate reports it
}

export function intakeToManifest(text: string, meta: { setId?: string; version?: string } = {}) {
  const { records, issues } = toRecords(text, INTAKE_COLUMNS);
  const items = records.map((r) => {
    const reviewers = [r.reviewer1Initials, r.reviewer2Initials].filter(Boolean).length;
    return {
      itemId: r.itemId,
      imageDigest: r.imageDigest,
      consent: { policyId: r.consentPolicyId, evidenceId: r.consentEvidenceId, consentedAt: r.consentedAt },
      strata: { scene: r.scene, type: r.type, brandVisible: bool(r.brandVisible), blackOwnedRelevance: r.blackOwnedRelevance },
      ...(r.targetDescription ? { targetDescription: r.targetDescription } : {}),
      googleEvidence: {
        retailerDomain: r.googleRetailerDomain, productTitle: r.googleProductTitle, capturedAt: r.googleCapturedAt,
        market: r.market, purchasable: bool(r.purchasable),
      },
      groundTruth: { category: r.truthCategory, subtype: r.truthSubtype, reviewers, adjudicated: bool(r.adjudicated) },
    };
  });
  return {
    manifest: { setId: meta.setId ?? 'vri-03-failure-set', version: meta.version ?? '0.1.0', status: 'IMPORTED_FROM_INTAKE', items },
    issues,
  };
}

export type ImportedLabel = { itemId: string; arm: string; stage: 'candidate' | 'shown'; canonicalUrl: string; label: MatchLabel };

export function labelKey(itemId: string, arm: string, stage: string, canonicalUrl: string): string {
  return `${itemId}|${arm}|${stage}|${canonicalUrl}`;
}

/**
 * Two reviewers per result. Agreement → that label. Disagreement → the
 * adjudicated label, or the row stays `unlabeled` (which blocks keep decisions).
 */
export function importResultLabels(text: string) {
  const { records, issues } = toRecords(text, LABELING_COLUMNS);
  const labels = new Map<string, ImportedLabel>();
  const valid = new Set<string>(MATCH_LABELS);
  let unresolved = 0;
  records.forEach((r, i) => {
    const where = `row ${i + 2}`;
    if (r.stage !== 'candidate' && r.stage !== 'shown') { issues.push(`${where}: stage must be candidate|shown`); return; }
    if (!r.itemId || !r.arm || !r.canonicalUrl) { issues.push(`${where}: itemId, arm and canonicalUrl are required`); return; }
    for (const k of ['reviewer1Label', 'reviewer2Label', 'adjudicatedLabel'] as const) {
      if (r[k] && !valid.has(r[k])) issues.push(`${where}: ${k} "${r[k]}" is not a taxonomy label`);
    }
    let label: MatchLabel = 'unlabeled';
    if (r.reviewer1Label && r.reviewer1Label === r.reviewer2Label && valid.has(r.reviewer1Label)) label = r.reviewer1Label as MatchLabel;
    else if (r.adjudicatedLabel && valid.has(r.adjudicatedLabel)) label = r.adjudicatedLabel as MatchLabel;
    if (label === 'unlabeled') unresolved++;
    const key = labelKey(r.itemId, r.arm, r.stage, r.canonicalUrl);
    if (labels.has(key)) issues.push(`${where}: duplicate label row for ${key}`);
    labels.set(key, { itemId: r.itemId, arm: r.arm, stage: r.stage as 'candidate' | 'shown', canonicalUrl: r.canonicalUrl, label });
  });
  return { labels, unresolved, issues };
}
