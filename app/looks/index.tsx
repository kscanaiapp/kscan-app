import React from 'react';
import {
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { FeatureFreezeFallback } from '../../components/FeatureFreezeFallback';
import {
  EmptyState,
  Header,
  LoadingOrError,
  styleObjectStyles,
} from '../../components/StyleObjectCards';
import { COLORS, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { useFeatureFreeze } from '../../hooks/useFeatureFreeze';
import { useLooks } from '../../hooks/useStyleObjects';
import type { Look } from '../../types/styleObjects';

function LookCard({ look }: { look: Look }) {
  const cover = look.coverImageUrl || look.coverFallbackUrl;
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => router.push(`/looks/${look.id}`)}
      activeOpacity={0.84}
    >
      {cover ? (
        <Image source={{ uri: cover }} style={styles.cover} resizeMode="cover" />
      ) : (
        <View style={[styles.cover, styles.coverFallback]}>
          <Text style={styles.coverFallbackText}>LOOK</Text>
        </View>
      )}
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle} numberOfLines={1}>{look.title}</Text>
        {look.dressingRoomTitle ? (
          <Text style={styles.roomName} numberOfLines={1}>{look.dressingRoomTitle}</Text>
        ) : (
          <Text style={styles.roomName}>STANDALONE</Text>
        )}
        {look.description ? (
          <Text style={styles.cardDescription} numberOfLines={2}>{look.description}</Text>
        ) : null}
        <Text style={styles.cardMeta}>{look.itemCount ?? 0} ITEMS</Text>
      </View>
    </TouchableOpacity>
  );
}

function LooksContent() {
  const { looks, loading, error, reload } = useLooks();
  const blocking = loading || !!error;

  return (
    <View style={styleObjectStyles.screen}>
      <StatusBar style="dark" />
      <Header title="Looks" eyebrow="Outfit Compositions" onBack={() => router.back()} />
      {blocking ? (
        <LoadingOrError loading={loading} error={error} onRetry={reload} />
      ) : (
        <ScrollView contentContainerStyle={styleObjectStyles.content}>
          {looks.length === 0 ? (
            <EmptyState
              title="No Looks yet."
              body="Open a Dressing Room, select one or more items, and create your first Look."
            />
          ) : (
            <View style={styles.grid}>
              {looks.map((look) => <LookCard key={look.id} look={look} />)}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

export default function LooksScreen() {
  const { isFeatureEnabled, isLoading } = useFeatureFreeze();
  if (isLoading) {
    return <FeatureFreezeFallback cta="closet" loading />;
  }
  if (!isFeatureEnabled('outfitRemixLooks')) {
    return <FeatureFreezeFallback cta="closet" />;
  }

  return <LooksContent />;
}

const styles = StyleSheet.create({
  grid: {
    gap: SPACING.md,
  },
  card: {
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceCard,
    overflow: 'hidden',
    ...SHADOWS.editorialSmall,
  },
  cover: {
    width: '100%',
    aspectRatio: 1.8,
    backgroundColor: COLORS.surfaceMuted,
  },
  coverFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverFallbackText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextMuted,
  },
  cardBody: {
    padding: SPACING.lg,
    gap: SPACING.xs,
  },
  cardTitle: {
    ...TYPOGRAPHY.title,
    color: COLORS.editorialTextPrimary,
  },
  roomName: {
    ...TYPOGRAPHY.caption,
    color: COLORS.goldPressed,
  },
  cardDescription: {
    ...TYPOGRAPHY.body,
    color: COLORS.editorialTextSecondary,
    fontSize: 13,
  },
  cardMeta: {
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextMuted,
    marginTop: SPACING.xs,
  },
});
