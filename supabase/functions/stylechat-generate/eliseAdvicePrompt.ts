/**
 * E-4 advice prompt block + structured metadata builder.
 */

import { escapePromptData } from './promptHardening.ts';
import { ownershipLanguageLabel } from './eliseFashionFeatures.ts';
import type {
  EliseAdviceDisplayFacts,
  EliseAdviceIntent,
  EliseAdviceLook,
  EliseAdviceOutput,
  EliseFocusedItem,
  ElisePurchaseAdvice,
  EliseScoredCandidate,
  EliseWardrobeCandidate,
  EliseWardrobeContextMode,
  EliseWardrobeGap,
} from './eliseAdviceTypes.ts';
import {
  ELISE_ADVICE_CONTRACT_VERSION,
  ELISE_ADVICE_CONTRACT_VERSION_V2,
} from './eliseAdviceTypes.ts';

/**
 * C1 section 16 -- copy display facts off a SERVER-AUTHORIZED candidate.
 *
 * Every value is lifted from the candidate the deterministic pipeline already
 * ranked; nothing is derived from model output and nothing is invented. A field
 * the evidence does not carry stays null rather than being filled in, because a
 * plausible-looking guess on a card the user reads as "my clothes" is worse
 * than a blank.
 */
export function buildDisplayFacts(
  candidate: EliseWardrobeCandidate,
): EliseAdviceDisplayFacts {
  return {
    title: candidate.title,
    category: candidate.category,
    subtype: candidate.subcategory,
    brand: candidate.brand,
    // First colour only. The card shows one swatch, and picking "the primary"
    // out of a multi-colour list is a judgement the evidence does not support.
    primaryColor: candidate.colors[0] ?? null,
    // The canonical id the client already stores for this row. It is how the
    // app resolves a LOCAL image; it is not a new handle and grants nothing.
    clientId: candidate.canonicalResourceIds.itemId ?? null,
  };
}

export function buildEliseAdvicePromptBlock(input: {
  intent: EliseAdviceIntent;
  focused: EliseFocusedItem;
  shortlist: EliseScoredCandidate[];
  wardrobeGap: EliseWardrobeGap | null;
  purchaseAdvice: ElisePurchaseAdvice | null;
  looks: EliseAdviceLook[] | null;
  /** Concierge capability. Off -> the pre-Concierge block, byte-identical. */
  conciergeV1?: boolean;
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
    '- Do not execute purchases, cart changes, or preference writes.',
    `- adviceIntent: ${escapePromptData(input.intent)}`,
  ];

  if (input.conciergeV1) {
    // C3 section 33 -- the FIRST defence, and the one meant to do the work. The
    // guard downstream deletes sentences; this is what stops them being written.
    lines.push(
      'OWNERSHIP SEMANTICS (STRICT):',
      '- NEVER describe an item as owned unless its evidence line says relationship=owned.',
      '- relationship=saved means the user bookmarked it. They may not own it.',
      '- relationship=scanned means the user photographed it. Photographing is not owning.',
      '- relationship=shared means someone else owns it.',
      '- relationship=discovered means it is a shopping suggestion, not a possession.',
      '- relationship=unverified/unknown means ownership is UNKNOWN. Say nothing about owning it.',
      '- If you want to mention a garment the user owns and no owned candidate below',
      '  matches it, do not mention it. Absence of evidence is not evidence of absence,',
      '  and it is never a licence to assume.',
    );
  }

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
  } else if (input.conciergeV1 && input.focused.resolution === 'closet_text_ambiguous') {
    // C2 section 21. The user named something of theirs and several owned items
    // fit. Reporting the tie -- rather than a winner -- is what stops the answer
    // implying a specific item resolved when none did.
    const tied = input.focused.ambiguousCandidates ?? [];
    lines.push('[FOCUSED ITEM - AMBIGUOUS]');
    lines.push(
      `matchCount=${tied.length} ` +
        `sharedCategory=${escapePromptData(input.focused.ambiguousSharedCategory ?? 'none')}`,
    );
    for (const candidate of tied) {
      lines.push(
        `- id=${escapePromptData(candidate.candidateId)} ` +
          `category=${escapePromptData(candidate.category ?? 'unknown')} ` +
          `colors=${escapePromptData(candidate.colors.join('|') || 'unknown')}`,
      );
    }
    lines.push(
      'HANDLING: Several owned items match what the user described. Do NOT pick one',
      'silently and do NOT claim a specific item was identified. Either ask which one',
      'they meant, or say plainly that several match and build around that GROUP.',
    );
    lines.push('[/FOCUSED ITEM - AMBIGUOUS]');
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
          `score=${scored.score.total} category=${escapePromptData(c.category ?? 'unknown')} ` +
          `colors=${escapePromptData(c.colors.join('|') || 'unknown')} ` +
          `reasons=${escapePromptData(scored.score.reasons.join(',') || 'none')} ` +
          `label=${escapePromptData(ownershipLanguageLabel(c.actorRelationship))}`,
      );
    }
  }
  lines.push('[/AUTHORIZED CANDIDATES]');

  if (input.wardrobeGap) {
    const label = '— SCOPED';
    lines.push(`[WARDROBE GAP ${label}]`);
    lines.push(
      `partialInventory=${input.wardrobeGap.partialInventory} ` +
        `codes=${escapePromptData(input.wardrobeGap.gapCodes.join(',') || 'none')} ` +
        `note=Based on the items currently available to Elise`,
    );
    if (input.conciergeV1) {
      // C2 section 27. The prompt must be told WHICH claim the evidence can
      // carry. Without this line the model cannot tell an exhaustive census
      // from a bounded shortlist, and will phrase both as certainty.
      if (input.wardrobeGap.evidenceIsExhaustive) {
        lines.push(
          'EVIDENCE=EXHAUSTIVE_CLOSET_CENSUS. These gaps were checked against the',
          'entire Closet, so you may state plainly that they do not have the',
          'listed pieces.',
        );
        if (input.wardrobeGap.confirmedAbsentCategories?.length) {
          lines.push(
            `confirmedAbsent=${escapePromptData(
              input.wardrobeGap.confirmedAbsentCategories.join(','),
            )}`,
          );
        }
      } else {
        lines.push(
          'EVIDENCE=BOUNDED. These gaps come from the pieces available to this turn,',
          'NOT from the whole Closet. Scope your language accordingly - say "based on',
          'the pieces I reviewed" or similar. Do NOT say the user does not own something.',
        );
      }
      if (input.wardrobeGap.notes.includes('small_closet_gap_restraint')) {
        // Section 28: a small Closet is not a defective one.
        lines.push(
          'SMALL CLOSET: this Closet has few items, which is normal and not a problem.',
          'Style what is present. Mention at most the single gap listed, and only if it',
          'directly blocks what was asked. Do not audit the wardrobe for deficiencies',
          'and do not push the user to add items.',
        );
      }
    }
    lines.push(`[/WARDROBE GAP ${label}]`);
  }

  if (input.purchaseAdvice) {
    lines.push('[PURCHASE ADVICE — DETERMINISTIC]');
    lines.push(
      `verdict=${escapePromptData(input.purchaseAdvice.verdict)} ` +
        `confidence=${input.purchaseAdvice.confidence} ` +
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
    '[/RESPONSE GUIDANCE]',
    '[/Elise Closet-Aware Advice Grounding]',
  );

  return lines.join('\n');
}

/**
 * C1 section 17 -- classify what wardrobe evidence actually participated.
 *
 * Derived from the SHORTLIST, not from entitlement and not from the flag: a K+
 * user asking about the weather in Paris has an empty shortlist and gets
 * 'none', which is what stops the client rendering Closet chrome on an answer
 * that has nothing to do with their Closet.
 */
/**
 * AUDIT-CON-005 -- what counts as "owned CLOSET evidence".
 *
 * `actorRelationship === 'owned'` alone is NOT the test. `roomItemRelationship`
 * maps a Dressing Room row whose declared provenance is `owned_closet` or
 * `physically_owned` to sourceType 'owned_room' with relationship 'owned', and
 * `listOwnedRoomItems` is not K+ gated. Counting those made two things true
 * that must not be:
 *
 *   * the premium Concierge surface rendered for a non-K+ actor, and
 *   * a Dressing Room item was headed "From your Closet" -- a store the row is
 *     not in. `user_closet_items` is the only authoritative owned-item source.
 *
 * The contract on `EliseWardrobeContextMode` already said this in words
 * ("closet -- every represented candidate is owned CLOSET evidence"); this is
 * the predicate that makes the code agree with it.
 */
function isOwnedClosetEvidence(candidate: EliseWardrobeCandidate): boolean {
  return candidate.sourceType === 'closet' && candidate.actorRelationship === 'owned';
}

export function deriveWardrobeContextMode(
  shortlist: EliseScoredCandidate[],
  focused?: EliseFocusedItem,
): EliseWardrobeContextMode {
  // DEFECT DEF-CON-003. The FOCUS counts as wardrobe evidence.
  //
  // rankAndBoundCandidates deliberately removes the focused item from the
  // shortlist -- you do not recommend the thing you are building around. So a
  // one-item Closet answering "what goes with my brown loafers?" produces an
  // EMPTY shortlist even though the answer is entirely about an owned item.
  // Deriving the mode from the shortlist alone reported 'none' there, which
  // would have told the client to hide all Closet presentation on precisely
  // the flagship case this feature exists for (section 55, Test A).
  const focusIsOwned =
    (focused?.candidate ? isOwnedClosetEvidence(focused.candidate) : false) ||
    // An ambiguous text match resolved no single item, but it did prove the
    // user has owned items fitting the description -- that is Closet context.
    (focused?.resolution === 'closet_text_ambiguous' &&
      (focused.ambiguousCandidates ?? []).some(isOwnedClosetEvidence));

  const ownedCount = shortlist.filter((s) => isOwnedClosetEvidence(s.candidate)).length;

  if (ownedCount === 0) return focusIsOwned ? 'closet' : 'none';
  // 'mixed' is the signal that the UI must label cards individually rather than
  // filing them all under "From your Closet".
  return ownedCount === shortlist.length ? 'closet' : 'mixed';
}

export function buildEliseAdviceMetadata(input: {
  intent: EliseAdviceIntent;
  focused: EliseFocusedItem;
  shortlist: EliseScoredCandidate[];
  wardrobeGap: EliseWardrobeGap | null;
  purchaseAdvice: ElisePurchaseAdvice | null;
  looks: EliseAdviceLook[] | null;
  /** Concierge capability. Off -> a byte-identical v1 payload. */
  conciergeV1?: boolean;
}): Omit<EliseAdviceOutput, 'text'> {
  const base: Omit<EliseAdviceOutput, 'text'> = {
    adviceIntent: input.intent,
    focusedItem: {
      evidenceId: input.focused.evidenceId,
      actorRelationship: input.focused.actorRelationship,
      // DEFECT DEF-CON-004, v2 only. Without this the client cannot render the
      // focus card, so the "FROM YOUR CLOSET / [brown loafers]" proof in
      // section 4 was unbuildable: focusedItem carried an id and a
      // relationship and nothing displayable, and the focus is excluded from
      // `recommendations` by design. Same provenance rule as every other
      // display fact -- copied off the server-authorized candidate.
      ...(input.conciergeV1 && input.focused.candidate
        ? { displayFacts: buildDisplayFacts(input.focused.candidate) }
        : {}),
    },
    recommendations: input.shortlist.map((s) => ({
      candidateId: s.candidate.candidateId,
      sourceType: s.candidate.sourceType,
      actorRelationship: s.candidate.actorRelationship,
      recommendationRole: s.recommendationRole,
      score: s.score.total,
      reasonCodes: s.score.reasons.slice(0, 8),
      // v2 ONLY. Adding the key unconditionally would change the v1 payload
      // shape, and v1 is a shipped contract.
      ...(input.conciergeV1 ? { displayFacts: buildDisplayFacts(s.candidate) } : {}),
    })),
    wardrobeGap: input.wardrobeGap,
    purchaseAdvice: input.purchaseAdvice,
    looks: input.looks,
    contractVersion: input.conciergeV1
      ? ELISE_ADVICE_CONTRACT_VERSION_V2
      : ELISE_ADVICE_CONTRACT_VERSION,
  };

  if (!input.conciergeV1) return base;

  return {
    ...base,
    wardrobeContextMode: deriveWardrobeContextMode(input.shortlist, input.focused),
    focusAmbiguity:
      input.focused.resolution === 'closet_text_ambiguous'
        ? {
          ambiguous: true,
          // Ids only. The client already holds the display facts for these in
          // `recommendations` when they ranked; it never needs prose here.
          candidateIds: (input.focused.ambiguousCandidates ?? []).map(
            (candidate) => candidate.candidateId,
          ),
          sharedCategory: input.focused.ambiguousSharedCategory ?? null,
        }
        : null,
  };
}
