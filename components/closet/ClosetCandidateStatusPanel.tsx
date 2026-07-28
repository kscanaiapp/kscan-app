// Minimal flag-gated Closet CANDIDATE status surface (Build 1).
//
// SCOPE: the smallest surface that proves the foundation works — a thumbnail, the
// derived status, the classified taxonomy, a retry, and a remove. Nothing more.
//
// DELIBERATELY NOT BUILT HERE, and each is a later build rather than an omission:
// the multi-photo batch picker, approve-all, multi-select review, promotion into
// the committed Closet, duplicate comparison, receipt import, retailer URL import,
// the share extension, mirror garment extraction, and My Style.
//
// PROMOTION IS UNREACHABLE FROM THIS SURFACE. The state machine can represent
// `ready_for_review -> saving -> saved`, but nothing here calls it. A candidate is
// not a committed Closet item, and Build 1 does not commit one.
//
// UI METADATA IS DERIVED FROM STATUS, never read off the record. See
// services/closetCandidateStateMachine.ts#statusUIMetadata for why a persisted
// copy would drift from the status it claims to describe.

import React from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';

import { SecondaryButton } from '../luxury';
import { LUXURY, SPACING } from '../../constants/theme';
import { useClosetCandidates } from '../../hooks/useClosetCandidates';
import { statusUIMetadata } from '../../services/closetCandidateStateMachine';
import {
  closetCandidateErrorMessage,
  isUserRetryable,
} from '../../services/closetCandidateErrors';

/** Category / subtype / colour, in that order, skipping what is absent. */
function describe(candidate: {
  category?: string | null;
  clothingType?: string | null;
  subtype?: string | null;
  primaryColor?: string | null;
}): string | null {
  const parts = [
    candidate.category,
    candidate.clothingType,
    candidate.subtype,
    candidate.primaryColor,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  return parts.length ? parts.join(' · ') : null;
}

export function ClosetCandidateStatusPanel({
  api,
}: {
  /**
   * The screen's ONE `useClosetCandidates()` instance, passed down so intake and
   * this panel observe the same snapshot. REQUIRED rather than defaulted: if this
   * component mounted its own instance, a candidate staged through the screen's
   * instance would not appear here until the next focus, and every focus would
   * run a second hydrate/queue pass for nothing.
   */
  api: ReturnType<typeof useClosetCandidates>;
}) {
  const { candidates, loading, retry, remove } = api;

  if (loading) {
    return (
      <View style={styles.loadingWrap} accessibilityLabel="Loading staged photos">
        <ActivityIndicator size="small" color={LUXURY.colors.plum} />
      </View>
    );
  }

  // An empty staging queue renders nothing at all rather than an empty state: the
  // committed Closet below already owns the empty-state message for this screen,
  // and a second one would imply the user has two empty things to fill.
  if (!candidates.length) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.heading}>WAITING FOR REVIEW</Text>
      {candidates.map((candidate: any) => {
        const meta = statusUIMetadata(candidate.status);
        const detail = describe(candidate);
        // Status says the state ALLOWS retry; the registry says whether retrying
        // this particular failure could help. Both must agree before we offer it.
        const showRetry =
          meta.canRetry && (!candidate.errorCode || isUserRetryable(candidate.errorCode));
        return (
          <View key={candidate.candidateId} style={styles.row}>
            {candidate.candidateThumbnailUri ? (
              <Image
                source={{ uri: candidate.candidateThumbnailUri }}
                style={styles.thumb}
                accessibilityIgnoresInvertColors
              />
            ) : (
              <View style={[styles.thumb, styles.thumbPlaceholder]} />
            )}

            <View style={styles.body}>
              <Text style={styles.status}>{meta.progressLabel}</Text>
              {detail ? <Text style={styles.detail}>{detail}</Text> : null}
              {candidate.brand ? <Text style={styles.detail}>{candidate.brand}</Text> : null}
              {/* Registry copy only. A raw backend error is never displayed. */}
              {candidate.errorCode ? (
                <Text style={styles.error}>
                  {closetCandidateErrorMessage(candidate.errorCode)}
                </Text>
              ) : null}
            </View>

            <View style={styles.actions}>
              {showRetry ? (
                <SecondaryButton
                  title="Try again"
                  onPress={() => {
                    void retry(candidate.candidateId);
                  }}
                  accessibilityLabel="Try identifying this photo again"
                />
              ) : null}
              {meta.canReject ? (
                <SecondaryButton
                  title="Remove"
                  onPress={() => {
                    void remove(candidate.candidateId);
                  }}
                  accessibilityLabel="Remove this staged photo"
                />
              ) : null}
            </View>
          </View>
        );
      })}

    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.md,
  },
  loadingWrap: {
    paddingVertical: SPACING.lg,
    alignItems: 'center',
  },
  heading: {
    fontSize: 11,
    letterSpacing: 1.5,
    color: LUXURY.colors.plum,
    marginBottom: SPACING.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: LUXURY.colors.ivory,
  },
  thumbPlaceholder: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LUXURY.colors.plum,
    opacity: 0.3,
  },
  body: {
    flex: 1,
  },
  status: {
    fontSize: 14,
    color: LUXURY.colors.ink,
  },
  detail: {
    fontSize: 12,
    opacity: 0.7,
    color: LUXURY.colors.plum,
  },
  error: {
    fontSize: 12,
    marginTop: 2,
    color: LUXURY.colors.plum,
  },
  actions: {
    gap: SPACING.xs,
  },
});
