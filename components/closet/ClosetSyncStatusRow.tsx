// Closet Experience V1 — the Closet header's cloud status (PR A1, section 31).
//
// Small and non-intrusive by design: one pill and at most one line of detail,
// inside the Closet header. NOT a dedicated engineering screen, and never a
// blocker — the Closet renders identically whether or not this row appears.
//
// Renders NOTHING when the presenter returns null (entitlement still resolving,
// or cloud sync not applicable to this actor). A status row that says
// "unavailable" while the authority is still answering is exactly the
// RESOLVING-treated-as-INACTIVE mistake section 12 forbids.

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { StatusPill } from '../luxury/StatusPill';
import { LUXURY, SPACING, FONTS } from '../../constants/theme';
import type { ClosetSyncPresentation } from '../../services/closet/closetSyncPresentation';

const VARIANT: Record<ClosetSyncPresentation['tone'], 'neutral' | 'warning'> = {
  neutral: 'neutral',
  progress: 'neutral',
  attention: 'warning',
};

export interface ClosetSyncStatusRowProps {
  status: ClosetSyncPresentation | null;
}

export function ClosetSyncStatusRow({ status }: ClosetSyncStatusRowProps) {
  if (!status) return null;

  return (
    <View
      style={styles.root}
      testID="closet-sync-status"
      // One node for the whole row so a screen reader reads "Syncing. Saving 2
      // items to your other devices." as a single announcement rather than two
      // disconnected fragments.
      accessible
      accessibilityRole="text"
      accessibilityLabel={status.detail ? `${status.label}. ${status.detail}` : status.label}
    >
      <StatusPill
        label={status.label}
        variant={VARIANT[status.tone]}
        testID={`closet-sync-pill-${status.id}`}
      />
      {status.detail ? (
        <Text style={styles.detail} numberOfLines={2}>
          {status.detail}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    flexWrap: 'wrap',
  },
  detail: {
    flexShrink: 1,
    fontFamily: FONTS.sans,
    fontSize: 12,
    color: LUXURY.colors.stone,
  },
});
