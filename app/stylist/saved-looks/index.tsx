import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import {
  EmptyStateCard,
  InlineNotice,
  KScanHeader,
  LuxuryScreen,
  SectionHeader,
} from '../../../components/luxury';
import { PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE } from '../../../constants/featureFlags';
import { LUXURY, SPACING } from '../../../constants/theme';
import { useAuthSession } from '../../../contexts/AuthSessionContext';
import { createActorRequest, isActorRequestCurrent } from '../../../services/actorContext';
import { getClosetItemProjections } from '../../../services/closetItemProjection';
import { loadClosetTyped } from '../../../services/closetLibrary';
import {
  deleteSavedLook,
  loadPrivateSavedLooks,
} from '../../../services/privateSavedLookStore';
import type { ClosetItemProjection } from '../../../services/closetItemProjection';
import type { PrivateSavedLookV1 } from '../../../types/privateSavedLook';

type ScreenState = {
  actorKey: string | null;
  status: 'loading' | 'ready' | 'error';
  looks: PrivateSavedLookV1[];
  closet: ClosetItemProjection[];
  recovered: boolean;
  closetUnavailable: boolean;
};

const INITIAL: ScreenState = {
  actorKey: null,
  status: 'loading',
  looks: [],
  closet: [],
  recovered: false,
  closetUnavailable: false,
};

function titleFor(look: PrivateSavedLookV1): string {
  return look.name || look.occasion || 'Saved Look';
}

function contextFor(look: PrivateSavedLookV1): string {
  const date = new Date(look.updatedAt).toLocaleDateString();
  return [look.occasion, date, `${look.slots.length} slot${look.slots.length === 1 ? '' : 's'}`]
    .filter(Boolean)
    .join(' - ');
}

export default function PrivateSavedLooksScreen() {
  const { isAuthenticated, user, loading: actorLoading } = useAuthSession();
  const actorId = isAuthenticated ? user?.id ?? null : null;
  const actorKey = actorId ? `user:${actorId}` : null;
  const [state, setState] = useState<ScreenState>(INITIAL);

  const load = useCallback(() => {
    if (!PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE || actorLoading || !actorId) return undefined;
    let live = true;
    const actorRequest = createActorRequest();
    setState({ ...INITIAL, actorKey });
    void Promise.all([
      loadPrivateSavedLooks(actorRequest),
      loadClosetTyped(actorId, { actorRequest }),
    ])
      .then(([saved, closet]) => {
        if (!live || !isActorRequestCurrent(actorRequest)) return;
        if (!saved.ok) {
          setState({ ...INITIAL, actorKey, status: 'error' });
          return;
        }
        setState({
          actorKey,
          status: 'ready',
          looks: saved.looks,
          closet: closet.ok ? getClosetItemProjections(closet.items) : [],
          recovered: saved.recovered === 'backup',
          closetUnavailable: !closet.ok,
        });
      })
      .catch(() => {
        if (live && isActorRequestCurrent(actorRequest)) {
          setState({ ...INITIAL, actorKey, status: 'error' });
        }
      });
    return () => {
      live = false;
    };
  }, [actorId, actorKey, actorLoading]);

  useFocusEffect(load);

  const confirmDelete = useCallback((look: PrivateSavedLookV1) => {
    Alert.alert('Delete Saved Look?', 'This removes only this local Saved Look.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          const actorRequest = createActorRequest();
          void deleteSavedLook(actorRequest, look.id).then((result) => {
            if (!isActorRequestCurrent(actorRequest) || !result.ok) return;
            setState((current) => ({ ...current, looks: result.looks }));
          });
        },
      },
    ]);
  }, []);

  if (!PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE) {
    return (
      <LuxuryScreen safeArea scrollable testID="private-saved-looks-disabled">
        <StatusBar style="dark" />
        <KScanHeader title="Saved Looks" onBack={() => router.replace('/stylist')} />
        <EmptyStateCard title="Not available" subtitle="Saved Looks is not available in this build." />
      </LuxuryScreen>
    );
  }

  if (!actorLoading && !actorId) {
    return (
      <LuxuryScreen safeArea scrollable testID="private-saved-looks-signed-out">
        <StatusBar style="dark" />
        <KScanHeader title="Saved Looks" onBack={() => router.replace('/stylist')} />
        <EmptyStateCard title="Sign in to continue" subtitle="Saved Looks are private to your account." />
      </LuxuryScreen>
    );
  }

  const current = state.actorKey === actorKey ? state : INITIAL;
  const closetById = new Map(current.closet.map((item) => [item.id, item]));

  return (
    <LuxuryScreen safeArea scrollable testID="private-saved-looks-list">
      <StatusBar style="dark" />
      <KScanHeader title="Saved Looks" onBack={() => router.replace('/stylist')} />
      <SectionHeader title="Your private looks" subtitle="Saved on this device" />

      {current.status === 'loading' ? (
        <View style={styles.loading} accessibilityLiveRegion="polite">
          <ActivityIndicator size="large" color={LUXURY.colors.plum} />
          <Text style={styles.muted}>Loading Saved Looks...</Text>
        </View>
      ) : null}

      {current.status === 'error' ? (
        <InlineNotice
          variant="error"
          title="Saved Looks unavailable"
          body="We couldn't read your Saved Looks. Your Closet was not changed."
        />
      ) : null}

      {current.recovered ? (
        <InlineNotice variant="info" title="Saved Looks recovered" body="The backup copy was restored safely." />
      ) : null}

      {current.closetUnavailable ? (
        <InlineNotice
          variant="info"
          title="Closet media unavailable"
          body="Saved Look details are intact. Current Closet images couldn't be loaded."
        />
      ) : null}

      {current.status === 'ready' && current.looks.length === 0 ? (
        <EmptyStateCard
          title="No Saved Looks yet"
          subtitle="Save an effective Look from your private Dressing Room."
        />
      ) : null}

      {current.looks.map((look) => {
        const media = look.slots
          .map((slot) => (slot.closetItemId ? closetById.get(slot.closetItemId) : null))
          .find((item) => item?.thumbnailUri || item?.imageUri) ?? null;
        const uri = media?.thumbnailUri ?? media?.imageUri ?? null;
        return (
          <View key={look.id} style={styles.card} testID="saved-look-list-card">
            <TouchableOpacity
              style={styles.cardMain}
              onPress={() => router.push({ pathname: '/stylist/saved-looks/[id]', params: { id: look.id } })}
              accessibilityRole="button"
              accessibilityLabel={`${titleFor(look)}, ${contextFor(look)}`}
            >
              {uri ? (
                <Image source={{ uri }} style={styles.image} resizeMode="cover" accessibilityLabel={`${media?.title ?? 'Saved Look'} image`} />
              ) : (
                <View style={[styles.image, styles.placeholder]} accessibilityLabel="No current Closet image">
                  <Text style={styles.placeholderText}>LOOK</Text>
                </View>
              )}
              <View style={styles.cardCopy}>
                <Text style={styles.title}>{titleFor(look)}</Text>
                <Text style={styles.muted}>{contextFor(look)}</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => confirmDelete(look)}
              accessibilityRole="button"
              accessibilityLabel={`Delete ${titleFor(look)}`}
              testID="delete-saved-look-button"
            >
              <Text style={styles.delete}>Delete</Text>
            </TouchableOpacity>
          </View>
        );
      })}
    </LuxuryScreen>
  );
}

const styles = StyleSheet.create({
  loading: { alignItems: 'center', paddingVertical: SPACING.xl, gap: SPACING.sm },
  card: {
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    borderRadius: 18,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.md,
    marginBottom: SPACING.md,
  },
  cardMain: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  image: { width: 76, height: 92, borderRadius: 14, backgroundColor: LUXURY.colors.champagne },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
  placeholderText: { color: LUXURY.colors.stone, fontSize: 11, letterSpacing: 2 },
  cardCopy: { flex: 1, gap: SPACING.xs },
  title: { color: LUXURY.colors.ink, fontSize: 17, fontWeight: '700' },
  muted: { color: LUXURY.colors.stone, fontSize: 13, lineHeight: 19 },
  delete: { color: LUXURY.colors.error, fontWeight: '600', paddingTop: SPACING.sm, textAlign: 'right' },
});
