/**
 * Commerce results inside a chat turn (Build 36 activation).
 *
 * REUSES `ProductShelf`. That is the point: Shop/Save/Watch gating, retailer
 * identity, price truth and the #409 commercial-usability floor already live
 * there and are already tested. A second chat-only product card would be a
 * second place for those rules to drift out of agreement.
 *
 * Every card rendered here came back from the Commerce path on this turn.
 * Nothing is rendered from Elise's prose, and the three non-result states are
 * distinct on purpose: a provider failure is not "nothing matches".
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ProductShelf, type Product } from '../ProductShelf';
import { hasCommerceProvenance } from '../../services/style-chat/commerceActivation';
// The fact is read, never re-derived: see `matchedRequestedAttribute`.
import { matchedRequestedAttribute } from '../../services/commerce/commerceRationale';
import { LUXURY, SPACING } from '../../constants/theme';

export type CommerceBlockNotice =
  | 'formality_needs_reference'
  | 'restored_not_transactable'
  | 'reference_expired'
  | 'reference_out_of_range'
  | 'reference_no_shelf'
  | 'rejections_dropped'
  | 'rejections_cleared';

export interface CommerceProductsBlockProps {
  status: 'results' | 'no_matches' | 'exhausted' | 'error';
  products: unknown;
  /** The memory operation this shelf answers, when it answers one. */
  memoryOp?: 'different' | 'another' | 'not_those' | 'reference' | 'clear' | null;
  /** Closed fact codes from deterministic state. Copy is chosen here. */
  notices?: CommerceBlockNotice[] | null;
  /** Candidates the active product exclusions removed (§47). */
  hiddenCount?: number | null;
  /** The whole active request, for the compact state line (§47). */
  intentSummary?: {
    color?: string | null;
    material?: string | null;
    silhouette?: string | null;
    formality?: string | null;
    budget?: { amount: number; currency: string } | null;
  } | null;
  /**
   * The colour the customer asked for and how hard they asked, echoed from the
   * shopping intent. Presentation only -- ranking already happened.
   */
  requestedColor?: string | null;
  colorStrength?: 'EXPLICIT_PREFERENCE' | 'STRONG_EXPLICIT_PREFERENCE' | null;
  testID?: string;
}

/**
 * Copy per state.
 *
 * "I couldn't check live options right now" and "I couldn't find a current
 * option" are different sentences because they are different facts, and
 * telling someone nothing matched when the lookup failed is a lie the app
 * would have no way to correct.
 */
const NO_MATCHES_COPY = "I couldn't find a current option that fits those constraints.";
const ERROR_COPY = "I couldn't check live options right now.";

/**
 * EXHAUSTION IS NOT FAILURE, and it must not read like one.
 *
 * "Nothing matches" tells someone the market is empty. It is not: they have
 * seen it, and what is left is a choice about their own constraints. Saying so
 * plainly, and naming the two constraints that could move, is the difference
 * between a dead end and a decision. K Scan never relaxes a constraint on
 * someone's behalf — the offer is made, the customer decides.
 */
const EXHAUSTED_COPY =
  "That's everything I can currently find that fits. I can open up the budget or look at other colours if you'd like.";

/** One line per fact. Every one is proven by deterministic state, never prose. */
const NOTICE_COPY: Record<CommerceBlockNotice, string> = {
  formality_needs_reference:
    "I'm not sure what to make it less formal than — tell me the level you want (casual, smart, dressy or formal) and I'll use it.",
  restored_not_transactable:
    "That's the one you were looking at. I can't confirm its current price or availability, so I've left it as a link rather than a purchase.",
  reference_expired:
    "I remember what we were shopping for, but I no longer have those earlier options. Want me to search again?",
  reference_out_of_range: "I don't have an option at that position — which one did you mean?",
  reference_no_shelf: "I haven't shown you any options for this yet.",
  rejections_dropped:
    "I'm tracking a lot of rejected options now, so some of the earliest ones may reappear.",
  rejections_cleared: "I've put the hidden options back.",
};

/**
 * The compact active-state line: "black · suede · under $150 · 4 hidden".
 *
 * Read-only, and deliberately small. It exists because state a customer cannot
 * see is state they cannot correct — four silently hidden options look like a
 * thin market rather than their own instruction. Clearing is conversational
 * ("show me everything again") until there is a control surface to put it on.
 */
function activeStateLine(
  intentSummary: CommerceProductsBlockProps['intentSummary'],
  hiddenCount: number,
): string | null {
  const parts: string[] = [];
  for (const value of [intentSummary?.color, intentSummary?.material, intentSummary?.silhouette, intentSummary?.formality]) {
    if (typeof value === 'string' && value) parts.push(value);
  }
  const budget = intentSummary?.budget;
  if (budget && Number.isFinite(budget.amount) && typeof budget.currency === 'string') {
    parts.push(`under ${budget.amount} ${budget.currency}`);
  }
  if (hiddenCount > 0) parts.push(`${hiddenCount} hidden`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Nothing matched the colour they insisted on, but real alternatives came back.
 *
 * THIS IS NOT A NO-RESULTS STATE, and it must not read like one: the customer
 * has options, they simply are not the colour asked for. Saying so plainly is
 * the whole job -- what must never happen is a brown boot sitting silently
 * under a request for black, as though it answered it.
 */
const noPreferredMatchCopy = (color: string) =>
  `I couldn't find a strong ${color} match right now, but these are the closest alternatives.`;

export function CommerceProductsBlock({
  status,
  products,
  requestedColor,
  colorStrength,
  memoryOp,
  notices,
  hiddenCount,
  intentSummary,
  testID,
}: CommerceProductsBlockProps) {
  const noticeLines = (Array.isArray(notices) ? notices : [])
    .filter((notice): notice is CommerceBlockNotice => Boolean(NOTICE_COPY[notice as CommerceBlockNotice]))
    .map((notice) => NOTICE_COPY[notice]);

  const noticeBlock = noticeLines.length ? (
    <View testID={testID ? `${testID}-notices` : undefined}>
      {noticeLines.map((line) => (
        <Text key={line} style={styles.stateText}>{line}</Text>
      ))}
    </View>
  ) : null;

  if (status === 'error') {
    return (
      <View style={styles.state} testID={testID ? `${testID}-error` : undefined}>
        {noticeBlock}
        <Text style={styles.stateText}>{ERROR_COPY}</Text>
      </View>
    );
  }

  // Re-checked at RENDER time, not only at write time: a persisted block that
  // was edited, or that arrived from an older build, must not be able to put a
  // card on screen without Commerce provenance.
  const verified = (Array.isArray(products) ? products : []).filter(hasCommerceProvenance) as Product[];

  if (status === 'exhausted' && verified.length === 0) {
    return (
      <View style={styles.state} testID={testID ? `${testID}-exhausted` : undefined}>
        {noticeBlock}
        <Text style={styles.stateText}>{EXHAUSTED_COPY}</Text>
      </View>
    );
  }

  if (status === 'no_matches' || verified.length === 0) {
    return (
      <View style={styles.state} testID={testID ? `${testID}-empty` : undefined}>
        {noticeBlock}
        <Text style={styles.stateText}>{NO_MATCHES_COPY}</Text>
      </View>
    );
  }

  const stateLine = activeStateLine(intentSummary, typeof hiddenCount === 'number' ? hiddenCount : 0);
  const header = (stateLine || noticeBlock) ? (
    <View testID={testID ? `${testID}-state` : undefined}>
      {noticeBlock}
      {stateLine ? (
        <Text style={styles.activeState} testID={testID ? `${testID}-active-state` : undefined}>
          {stateLine}
        </Text>
      ) : null}
    </View>
  ) : null;

  // A single restored option is not a shelf of recommendations, and labelling
  // it "OPTIONS" would imply K Scan went looking again. It did not: this is the
  // one the customer asked to see.
  const shelfLabel = memoryOp === 'reference' ? 'THE ONE YOU ASKED FOR' : 'OPTIONS';

  // A strong request is the only one that earns a split shelf. An ordinary
  // preference needs no explanation for a near-miss being on the list, and
  // splitting every shelf would make the distinction meaningless where it
  // matters.
  const shouldGroup =
    colorStrength === 'STRONG_EXPLICIT_PREFERENCE' &&
    typeof requestedColor === 'string' &&
    requestedColor.length > 0;

  if (!shouldGroup) {
    return (
      <View testID={testID}>
        {header}
        <ProductShelf products={verified} label={shelfLabel} testID={testID ? `${testID}-shelf` : undefined} />
      </View>
    );
  }

  // ORDER IS PRESERVED WITHIN EACH GROUP. This partitions the shelf the ranker
  // produced; it does not re-rank it, and a candidate cannot change position
  // relative to another in the same group.
  const best = verified.filter(matchedRequestedAttribute);
  const other = verified.filter((product) => !matchedRequestedAttribute(product));

  // Nothing in the requested colour, but real alternatives did come back.
  if (best.length === 0) {
    return (
      <View testID={testID}>
        {header}
        <Text style={styles.stateText} testID={testID ? `${testID}-no-preferred-match` : undefined}>
          {noPreferredMatchCopy(requestedColor)}
        </Text>
        <ProductShelf
          products={other}
          label="OTHER OPTIONS"
          testID={testID ? `${testID}-shelf-other` : undefined}
        />
      </View>
    );
  }

  return (
    <View testID={testID}>
      {header}
      <ProductShelf
        products={best}
        label="BEST MATCHES"
        testID={testID ? `${testID}-shelf-best` : undefined}
      />
      {other.length > 0 ? (
        <ProductShelf
          products={other}
          label="OTHER OPTIONS"
          testID={testID ? `${testID}-shelf-other` : undefined}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  state: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },
  stateText: {
    color: LUXURY.colors.graphite,
    fontSize: 13,
    lineHeight: 18,
  },
  activeState: {
    color: LUXURY.colors.graphite,
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 0.4,
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
    textTransform: 'lowercase',
  },
});
