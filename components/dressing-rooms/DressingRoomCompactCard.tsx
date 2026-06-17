import React from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import type { DressingRoom } from '../../types/styleObjects';

type Props = {
  room: DressingRoom;
};

export function DressingRoomCompactCard({ room }: Props) {
  const cover = room.coverImageUrl || room.coverFallbackUrl;
  const itemCount = room.itemCount ?? 0;

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={() => router.push(`/dressing-rooms/${room.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`${room.title}, ${itemCount} item${itemCount === 1 ? '' : 's'}. ${room.description || ''}`}
      accessibilityHint="Open this Dressing Room"
    >
      {cover ? (
        <Image source={{ uri: cover }} style={styles.thumb} resizeMode="cover" />
      ) : (
        <View style={[styles.thumb, styles.thumbFallback]}>
          <Text style={styles.thumbFallbackText}>K</Text>
        </View>
      )}
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {room.title}
        </Text>
        {room.description ? (
          <Text style={styles.description} numberOfLines={1}>
            {room.description}
          </Text>
        ) : null}
        <Text style={styles.meta}>
          {itemCount} item{itemCount === 1 ? '' : 's'}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.md,
    ...SHADOWS.editorialSmall,
  },
  cardPressed: {
    backgroundColor: LUXURY.colors.cream,
    borderColor: LUXURY.colors.goldLight,
  },
  thumb: {
    width: 64,
    height: 64,
    borderRadius: RADIUS.md,
    backgroundColor: LUXURY.colors.champagne,
  },
  thumbFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbFallbackText: {
    fontFamily: LUXURY.typography.brandMark.fontFamily,
    fontSize: 18,
    color: LUXURY.colors.goldBrushed,
  },
  body: {
    flex: 1,
    gap: SPACING.xs,
  },
  title: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
    fontSize: 15,
  },
  description: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
    fontSize: 12,
    letterSpacing: 0.5,
    textTransform: 'none',
  },
  meta: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    fontSize: 10,
    letterSpacing: 1.2,
  },
});
