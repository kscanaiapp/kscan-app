/**
 * E-4 advice prompt block + structured metadata builder.
 */

import { escapePromptData } from './promptHardening.ts';
import { ownershipLanguageLabel } from './eliseFashionFeatures.ts';
import type {
  EliseAdviceIntent,
  EliseAdviceLook,
  EliseAdviceOutput,
  EliseFocusedItem,
  ElisePurchaseAdvice,
  EliseScoredCandidate,
  EliseWardrobeGap,
} from './eliseAdviceTypes.ts';
import { ELISE_ADVICE_CONTRACT_VERSION } from './eliseAdviceTypes.ts';

export function buildEliseAdvicePromptBlock(input: {
  intent: EliseAdviceIntent;
  focused: EliseFocusedItem;
  shortlist: EliseScoredCandidate[];
  wardrobeGap: EliseWardrobeGap | null;
  purchaseAdvice: ElisePurchaseAdvice | null;
  looks: EliseAdviceLook[] | null;
}): string {
  const lines: string[] = [
    '[Elise Closet-Aware Advice Grounding]',
    'RULES:',
    '- Use ONLY the candidates listed below. Do not invent Closet or saved items.',
    '- Ownership language must match actorRelationship exactly.',
    '- Owned means the user already has it. Saved is not owned. Shared is not owned.',
    '- Discovered/commerce options are shopping suggestions only.',
    '- Prefer owned items before saved, then shared, then commerce.',
    '- Do not invent prices, stock, sales urgency, or retailer preference.',
    '- Never quote an internal compatibility score, confidence number, or percentage.',
    '- Do not execute purchases, cart changes, or preference writes.',
    `- adviceIntent: ${escapePromptData(input.intent)}`,
  ];

  if (input.focused.candidate) {
    const f = input.focused.candidate;
    lines.push('[FOCUSED ITEM]');
    lines.push(
      `id=${escapePromptData(f.candidateId)} relationship=${escapePromptData(f.actorRelationship)} ` +
        `category=${escapePromptData(f.category ?? 'unknown')} ` +
        `colors=${escapePromptData(f.colors.join('|') || 'unknown')} ` +
        `language=${escapePromptData(ownershipLanguageLabel(f.actorRelationship))}`,
    );
    lines.push('[/FOCUSED ITEM]');
  } else {
    lines.push('[FOCUSED ITEM]');
    lines.push('none');
    lines.push('[/FOCUSED ITEM]');
  }

  lines.push('[AUTHORIZED CANDIDATES]');
  if (!input.shortlist.length) {
    lines.push('none');
  } else {
    for (const scored of input.shortlist) {
      const c = scored.candidate;
      lines.push(
        `- id=${escapePromptData(c.candidateId)} source=${escapePromptData(c.sourceType)} ` +
          `relationship=${escapePromptData(c.actorRelationship)} role=${escapePromptData(scored.recommendationRole)} ` +
          `category=${escapePromptData(c.category ?? 'unknown')} ` +
          `colors=${escapePromptData(c.colors.join('|') || 'unknown')} ` +
          `reasons=${escapePromptData(scored.score.reasons.join(',') || 'none')} ` +
          `label=${escapePromptData(ownershipLanguageLabel(c.actorRelationship))}`,
      );
    }
  }
  lines.push('[/AUTHORIZED CANDIDATES]');

  if (input.wardrobeGap) {
    lines.push('[WARDROBE GAP — SCOPED]');
    lines.push(
      `partialInventory=${input.wardrobeGap.partialInventory} ` +
        `codes=${escapePromptData(input.wardrobeGap.gapCodes.join(',') || 'none')} ` +
        `note=Based on the items currently available to Elise`,
    );
    lines.push('[/WARDROBE GAP — SCOPED]');
  }

  if (input.purchaseAdvice) {
    lines.push('[PURCHASE ADVICE — DETERMINISTIC]');
    lines.push(
      `verdict=${escapePromptData(input.purchaseAdvice.verdict)} ` +
        `reasons=${escapePromptData(input.purchaseAdvice.reasons.join(',') || 'none')}`,
    );
    lines.push('[/PURCHASE ADVICE — DETERMINISTIC]');
  }

  if (input.looks?.length) {
    lines.push('[MULTI LOOK — GROUNDED]');
    for (const look of input.looks) {
      lines.push(
        `- ${escapePromptData(look.lookId)} label=${escapePromptData(look.label)} ` +
          `items=${escapePromptData(look.candidateIds.join(',') || 'none')} ` +
          `missing=${escapePromptData(look.missingPieceCodes.join(',') || 'none')}`,
      );
    }
    lines.push('[/MULTI LOOK — GROUNDED]');
  }

  lines.push(
    '[RESPONSE GUIDANCE]',
    '- Lead with a direct recommendation.',
    '- Explain why using retrieved candidates.',
    '- Offer one alternative when useful.',
    '- Mention a missing piece only when gap codes exist.',
    '- Suggest commerce only when allowed by intent and no strong owned alternative exists.',
    '- Describe compatibility qualitatively; never expose scores or percentages.',
    '[/RESPONSE GUIDANCE]',
    '[/Elise Closet-Aware Advice Grounding]',
  );

  return lines.join('\n');
}

export function buildEliseAdviceMetadata(input: {
  intent: EliseAdviceIntent;
  focused: EliseFocusedItem;
  shortlist: EliseScoredCandidate[];
  wardrobeGap: EliseWardrobeGap | null;
  purchaseAdvice: ElisePurchaseAdvice | null;
  looks: EliseAdviceLook[] | null;
}): Omit<EliseAdviceOutput, 'text'> {
  return {
    adviceIntent: input.intent,
    focusedItem: {
      evidenceId: input.focused.evidenceId,
      actorRelationship: input.focused.actorRelationship,
    },
    recommendations: input.shortlist.map((s) => ({
      candidateId: s.candidate.candidateId,
      sourceType: s.candidate.sourceType,
      actorRelationship: s.candidate.actorRelationship,
      recommendationRole: s.recommendationRole,
      score: s.score.total,
      reasonCodes: s.score.reasons.slice(0, 8),
    })),
    wardrobeGap: input.wardrobeGap,
    purchaseAdvice: input.purchaseAdvice,
    looks: input.looks,
    contractVersion: ELISE_ADVICE_CONTRACT_VERSION,
  };
}
