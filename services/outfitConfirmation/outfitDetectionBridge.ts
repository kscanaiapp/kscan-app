import type { DetectedGarmentCandidate } from '../../types/scanIdentification';

export type OutfitConfirmationCandidate = {
  id: string;
  order: number;
  label: string;
  category: string;
  subtype: string;
  confidenceScore?: number;
  isPrimary: boolean;
  source: DetectedGarmentCandidate;
};

function fallbackId(candidate: DetectedGarmentCandidate, index: number): string {
  const category = candidate.category || 'garment';
  const subtype = candidate.subtype || category;
  return `garment-${index + 1}-${category}-${subtype}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildOutfitConfirmationCandidates(
  detectedGarments: DetectedGarmentCandidate[] | null | undefined,
): OutfitConfirmationCandidate[] {
  if (!Array.isArray(detectedGarments)) return [];

  return detectedGarments
    .filter((candidate) => candidate && candidate.category && candidate.subtype)
    .slice(0, 5)
    .map((candidate, index) => ({
      id: candidate.candidateId || fallbackId(candidate, index),
      order: typeof candidate.order === 'number' ? candidate.order : index,
      label: candidate.label || candidate.subtype || candidate.category,
      category: candidate.category,
      subtype: candidate.subtype,
      confidenceScore: candidate.confidenceScore,
      isPrimary: index === 0,
      source: candidate,
    }));
}
