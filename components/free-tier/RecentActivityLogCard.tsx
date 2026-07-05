/**
 * Free Tier Utility Expansion — recent activity / wardrobe log card.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  FREE_TIER_ACTIVITY_LOG_ENABLED,
  isFreeTierFeatureEnabled,
} from '../../constants/freeTierUtilityFlags';
import { useActivityLog } from '../../hooks/useActivityLog';
import { FT_COLORS, UtilityCard, UtilityTitle } from './freeTierUi';

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - then) / 60000));
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.floor(hours / 24) + 'd ago';
}

export function RecentActivityLogCard() {
  const enabled = isFreeTierFeatureEnabled(FREE_TIER_ACTIVITY_LOG_ENABLED);
  const { events, loading } = useActivityLog(6);
  if (!enabled || loading || events.length === 0) return null;

  return (
    <UtilityCard>
      <UtilityTitle kicker="Closet memory">Recent activity</UtilityTitle>
      {events.map((event) => (
        <View key={event.id} style={styles.row}>
          <Text style={styles.label} numberOfLines={1}>
            {event.label}
          </Text>
          <Text style={styles.time}>{timeAgo(event.createdAt)}</Text>
        </View>
      ))}
    </UtilityCard>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  label: { flex: 1, fontSize: 13, color: FT_COLORS.plum, marginRight: 8 },
  time: { fontSize: 11, color: FT_COLORS.textMuted },
});
