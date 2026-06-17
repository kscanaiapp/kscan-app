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

export function DressingRoomHeroCard({ room }: Props) {
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
        <Image source={{ uri: cover }} style={styles.cover} resizeMode="cover" />
      ) : (
        <View style={[styles.cover, styles.coverFallback]}>
          <Text style={styles.coverFallbackText}>ROOM</Text>
        </View>
      )}
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {room.title}
        </Text>
        {room.description ? (
          <Text style={styles.cardDescription} numberOfLines={2}>
            {room.description}
          </Text>
        ) : null}
        <Text style={styles.cardMeta}>
          {itemCount} ITEM{itemCount === 1 ? '' : 'S'}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    overflow: 'hidden',
    ...SHADOWS.editorialRaised,
  },
  cardPressed: {
    backgroundColor: LUXURY.colors.cream,
    borderColor: LUXURY.colors.goldLight,
  },
  cover: {
    width: '100%',
    aspectRatio: 1.8,
    backgroundColor: LUXURY.colors.champagne,
  },
  coverFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverFallbackText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    letterSpacing: 3,
  },
  cardBody: {
    padding: SPACING.lg,
    gap: SPACING.xs,
  },
  cardTitle: {
    ...LUXURY.typography.displayTitle,
    color: LUXURY.colors.ink,
    fontSize: 18,
  },
  cardDescription: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
    fontSize: 13,
    lineHeight: 20,
  },
  cardMeta: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    marginTop: SPACING.xs,
    letterSpacing: 1.6,
  },
});
