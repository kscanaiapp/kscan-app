/**
 * E-4 focused-item resolution from E-1 envelope.
 * Never upgrades trust or ownership beyond server-verified provenance.
 */

import type {
  EliseVisualContextEnvelope,
  EliseVisualEvidence,
} from './eliseVisualContextTypes.ts';
import type {
  EliseActorRelationship,
  EliseFocusedItem,
  EliseWardrobeCandidate,
} from './eliseAdviceTypes.ts';
import { normalizeWardrobeCandidate } from './eliseFashionFeatures.ts';
import { matchClosetFocusFromText } from './eliseClosetFocusText.ts';

function mapRelationship(value: string | null | undefined): EliseActorRelationship {
  switch (value) {
    case 'owned':
      return 'owned';
    case 'shared':
      return 'shared';
    case 'saved':
      // INT-KPLUS-001: inspiration/saved items are saved, never owned. Without
      // this case they collapsed to 'unknown' and lost their honest label.
      return 'saved';
    case 'scanned':
    case 'uploaded':
      return 'scanned';
    case 'discovered':
      return 'discovered';
    default:
      return 'unknown';
  }
}

function evidenceToCandidate(evidence: EliseVisualEvidence): EliseWardrobeCandidate {
  const sourceType =
    // Canonical Closet only. The legacy 'closet_item' label is kept mapping to
    // 'closet' for compatibility, but the server only ever emits it now as one
    // of the three honest resolved types (INT-KPLUS-001).
    evidence.sourceType === 'user_closet_item' || evidence.sourceType === 'closet_item'
      ? 'closet'
      : evidence.sourceType === 'inspiration_item'
      ? 'inspiration'
      : evidence.sourceType === 'saved_scan'
      ? 'saved_scan'
      : evidence.sourceType === 'owned_room_item'
      ? 'owned_room'
      : evidence.sourceType === 'shared_room_item'
      ? 'shared_room'
      : evidence.sourceType === 'recent_scan'
      ? 'recent_scan'
      : evidence.sourceType === 'commerce_product'
      ? 'commerce_product'
      : 'focused_scan';

  const relationship = mapRelationship(evidence.actorRelationship);
  return normalizeWardrobeCandidate({
    candidateId: `focus:${evidence.evidenceId}`,
    sourceType,
    actorRelationship: relationship,
    row: {
      title: evidence.title,
      category: evidence.category,
      brand: evidence.brand,
      color: evidence.colors[0] ?? null,
      material: evidence.materials[0] ?? null,
      silhouette: evidence.silhouette,
      snapshot_payload: {
        metadata: {
          subcategory: evidence.subcategory,
          colors: evidence.colors,
          materials: evidence.materials,
          silhouette: evidence.silhouette,
          styleAttributes: evidence.styleAttributes,
          texture: evidence.textureAttributes,
          occasions: evidence.occasionAttributes,
          confidence: evidence.confidence,
        },
      },
    },
    canonicalResourceIds: {
      itemId: evidence.itemId ?? evidence.sourceId ?? undefined,
      scanId: evidence.scanId ?? undefined,
      roomId: evidence.roomId ?? undefined,
      productId: evidence.commerce?.productId ?? undefined,
    },
  });
}

/**
 * C2 section 20. Resolve the item the user is talking about.
 *
 * ONE RESOLVER, TWO KINDS OF EVIDENCE. Envelope evidence (something the user
 * attached, scanned or tapped) is checked first and always wins, because a
 * thing pointed at is a stronger signal than a thing described. Only when the
 * envelope offers nothing does the bounded text matcher get a turn -- and it
 * matches exclusively against candidates retrieval already authorized as owned,
 * so a phrase can never reach an item the actor has no access to.
 */
export function resolveEliseFocusedItem(input: {
  envelope: EliseVisualContextEnvelope | null;
  /** C2: the user message, for possessive phrases like "my brown loafers". */
  message?: string;
  /** C2: ALREADY actor-authorized candidates. Never client-supplied ids. */
  authorizedCandidates?: EliseWardrobeCandidate[];
  /** Concierge capability. Off -> envelope-only, exactly as before Concierge. */
  conciergeV1?: boolean;
}): EliseFocusedItem {
  const evidence = input.envelope?.evidence ?? [];

  const resolveFromText = (): EliseFocusedItem | null => {
    if (!input.conciergeV1) return null;
    if (!input.message || !input.authorizedCandidates?.length) return null;

    const match = matchClosetFocusFromText({
      message: input.message,
      candidates: input.authorizedCandidates,
    });

    if (match.status === 'matched') {
      return {
        // A text match names an OWNED CLOSET ROW, not a piece of envelope
        // evidence, so it carries no evidenceId. Leaving this null is what
        // keeps the client from resolving it against the visual envelope.
        evidenceId: null,
        actorRelationship: 'owned',
        candidate: match.candidate,
        resolution: 'closet_text_match',
      };
    }

    if (match.status === 'ambiguous') {
      // SECTION 21. `candidate` stays null on purpose: there is no resolved
      // item, and populating one here is exactly the silent selection this
      // branch exists to prevent. Downstream reasons at category level.
      return {
        evidenceId: null,
        actorRelationship: 'owned',
        candidate: null,
        resolution: 'closet_text_ambiguous',
        ambiguousCandidates: match.candidates,
        ambiguousSharedCategory: match.sharedCategory,
      };
    }

    return null;
  };

  if (!evidence.length) {
    return (
      resolveFromText() ?? {
        evidenceId: null,
        actorRelationship: 'unknown',
        candidate: null,
        resolution: 'none',
      }
    );
  }

  const focusedId = input.envelope?.focusedEvidenceId ?? null;
  if (focusedId) {
    const focused = evidence.find((e) => e.evidenceId === focusedId);
    if (focused) {
      return {
        evidenceId: focused.evidenceId,
        actorRelationship: mapRelationship(focused.actorRelationship),
        candidate: evidenceToCandidate(focused),
        resolution: 'focused_evidence',
      };
    }
  }

  const selected = evidence.find((e) => e.sourceType === 'selected_scan_item');
  if (selected) {
    return {
      evidenceId: selected.evidenceId,
      actorRelationship: mapRelationship(selected.actorRelationship),
      candidate: evidenceToCandidate(selected),
      resolution: 'explicit_selected',
    };
  }

  const currentScan = evidence.find((e) => e.sourceType === 'current_scan');
  if (currentScan) {
    return {
      evidenceId: currentScan.evidenceId,
      actorRelationship: mapRelationship(currentScan.actorRelationship),
      candidate: evidenceToCandidate(currentScan),
      resolution: 'current_scan',
    };
  }

  const closetOrSaved = evidence.find(
    (e) => e.sourceType === 'closet_item' || e.sourceType === 'recent_scan',
  );
  if (closetOrSaved) {
    return {
      evidenceId: closetOrSaved.evidenceId,
      actorRelationship: mapRelationship(closetOrSaved.actorRelationship),
      candidate: evidenceToCandidate(closetOrSaved),
      resolution: 'referenced_saved',
    };
  }

  // Last resort inside the envelope is "whatever arrived first", which is a
  // weaker signal than the user naming an owned item in this very message --
  // so an explicit text match outranks it. Every stronger envelope resolution
  // above (focused, selected, current scan, referenced saved) already returned.
  const fromText = resolveFromText();
  if (fromText) return fromText;

  const first = evidence[0];
  return {
    evidenceId: first.evidenceId,
    actorRelationship: mapRelationship(first.actorRelationship),
    candidate: evidenceToCandidate(first),
    resolution: 'recent_evidence',
  };
}
