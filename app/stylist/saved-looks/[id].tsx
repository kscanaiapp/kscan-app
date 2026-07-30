import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import {
  EmptyStateCard,
  InlineNotice,
  KScanHeader,
  LuxuryScreen,
  PrimaryButton,
  SecondaryButton,
  SectionHeader,
} from '../../../components/luxury';
import { PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE } from '../../../constants/featureFlags';
import { LUXURY, SPACING } from '../../../constants/theme';
import { useAuthSession } from '../../../contexts/AuthSessionContext';
import { createActorRequest, isActorRequestCurrent } from '../../../services/actorContext';
import { getClosetItemProjections } from '../../../services/closetItemProjection';
import type { ClosetItemProjection } from '../../../services/closetItemProjection';
import { loadClosetTyped } from '../../../services/closetLibrary';
import {
  buildMissingPieceQuery,
  buildSavedLookReturnContext,
  runControlledMissingPieceHandoff,
} from '../../../services/privateSavedLookHandoff';
import { resolvePrivateSavedLookOwnership } from '../../../services/privateSavedLookOwnership';
import type { PrivateSlotOwnership } from '../../../services/privateSavedLookOwnership';
import {
  clearSavedLookReturnContext,
  loadSavedLookReturnContext,
  persistSavedLookReturnContext,
} from '../../../services/privateSavedLookReturnContext';
import {
  deleteSavedLook,
  loadPrivateSavedLook,
  renameSavedLook,
} from '../../../services/privateSavedLookStore';
import {
  PRIVATE_SLOT_LABELS,
  type PrivateDressingRoomSlot,
} from '../../../types/privateDressingRoomComposition';
import type { PrivateSavedLookSlotV1, PrivateSavedLookV1 } from '../../../types/privateSavedLook';
import type { MissingPieceIntent } from '../../../types/privateSavedLookHandoff';

type DetailState = {
  actorKey: string | null;
  status: 'loading' | 'ready' | 'missing' | 'error';
  look: PrivateSavedLookV1 | null;
  closet: ClosetItemProjection[];
  closetUnavailable: boolean;
  highlightedSlot: PrivateDressingRoomSlot | null;
};

const INITIAL: DetailState = {
  actorKey: null,
  status: 'loading',
  look: null,
  closet: [],
  closetUnavailable: false,
  highlightedSlot: null,
};

const STATE_LABELS: Record<string, string> = {
  exact_owned: 'Owned - exact',
  probable_owned: 'Probably owned',
  similar_owned: 'Similar piece owned',
  not_owned: 'Not in current Closet',
  unknown: 'Ownership unknown',
  deleted_reference: 'Original Closet item deleted',
  incompatible_edit: 'Original item changed category',
};

function handoffIntent(ownership: PrivateSlotOwnership): MissingPieceIntent {
  if (ownership.state === 'exact_owned' || ownership.state === 'probable_owned') return 'shop_anyway';
  if (ownership.state === 'similar_owned') return 'replace_item';
  return 'find_missing_piece';
}

export default function PrivateSavedLookDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const savedLookId = Array.isArray(params.id) ? params.id[0] ?? '' : params.id ?? '';
  const { isAuthenticated, user, loading: actorLoading } = useAuthSession();
  const actorId = isAuthenticated ? user?.id ?? null : null;
  const actorKey = actorId ? `user:${actorId}` : null;
  const [state, setState] = useState<DetailState>(INITIAL);
  const [renameDraft, setRenameDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE || actorLoading || !actorId || !savedLookId) {
      return undefined;
    }
    let live = true;
    const actorRequest = createActorRequest();
    setState({ ...INITIAL, actorKey });
    void Promise.all([
      loadPrivateSavedLook(actorRequest, savedLookId),
      loadClosetTyped(actorId, { actorRequest }),
      loadSavedLookReturnContext(actorRequest),
    ])
      .then(async ([saved, closet, returnContext]) => {
        if (!live || !isActorRequestCurrent(actorRequest)) return;
        if (!saved.ok || !saved.look) {
          setState({
            ...INITIAL,
            actorKey,
            status: saved.errorCode === 'saved_look_not_found' ? 'missing' : 'error',
          });
          return;
        }
        const highlightedSlot = returnContext?.savedLookId === saved.look.id
          ? returnContext.slotKey
          : null;
        setRenameDraft(saved.look.name ?? '');
        setState({
          actorKey,
          status: 'ready',
          look: saved.look,
          closet: closet.ok ? getClosetItemProjections(closet.items) : [],
          closetUnavailable: !closet.ok,
          highlightedSlot,
        });
        if (highlightedSlot && isActorRequestCurrent(actorRequest)) {
          await clearSavedLookReturnContext(actorRequest).catch(() => false);
        }
      })
      .catch(() => {
        if (live && isActorRequestCurrent(actorRequest)) {
          setState({ ...INITIAL, actorKey, status: 'error' });
        }
      });
    return () => {
      live = false;
    };
  }, [actorId, actorKey, actorLoading, savedLookId]);

  useFocusEffect(load);

  const current = state.actorKey === actorKey ? state : INITIAL;
  const ownership = useMemo(
    // The scope is provable here and nowhere else: `current` is only the live
    // state when state.actorKey === actorKey, and that state's closet came from
    // loadClosetTyped(actorId) under the same actor request that loaded the Look.
    () => current.look && !current.closetUnavailable
      ? resolvePrivateSavedLookOwnership(current.look, current.closet, {
          loadedForActorId: current.actorKey === actorKey ? actorId : null,
        })
      : null,
    [current.look, current.closet, current.closetUnavailable, current.actorKey, actorKey, actorId],
  );
  const closetById = useMemo(
    () => new Map(current.closet.map((item) => [item.id, item])),
    [current.closet],
  );

  const rename = useCallback(async () => {
    if (!current.look || busy) return;
    setBusy(true);
    const actorRequest = createActorRequest();
    try {
      const result = await renameSavedLook(actorRequest, current.look.id, renameDraft);
      if (isActorRequestCurrent(actorRequest) && result.ok && result.look) {
        setState((value) => ({ ...value, look: result.look }));
      }
    } finally {
      if (isActorRequestCurrent(actorRequest)) setBusy(false);
    }
  }, [busy, current.look, renameDraft]);

  const confirmDelete = useCallback(() => {
    if (!current.look) return;
    Alert.alert('Delete Saved Look?', 'Your Closet and Dressing Room are not affected.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          const actorRequest = createActorRequest();
          void deleteSavedLook(actorRequest, current.look!.id).then((result) => {
            if (isActorRequestCurrent(actorRequest) && result.ok) {
              router.replace('/stylist/saved-looks');
            }
          });
        },
      },
    ]);
  }, [current.look]);

  const beginHandoff = useCallback(async (
    slot: PrivateSavedLookSlotV1,
    slotOwnership: PrivateSlotOwnership,
  ) => {
    if (!current.look || busy) return;
    const intent = handoffIntent(slotOwnership);
    const query = buildMissingPieceQuery({ savedLook: current.look, slot, intent });
    const context = buildSavedLookReturnContext({
      savedLookId: current.look.id,
      slotKey: slot.slotKey,
      returnRoute: `/stylist/saved-looks/${current.look.id}`,
    });
    if (!query || !context) return;
    setBusy(true);
    const actorRequest = createActorRequest();
    try {
      await runControlledMissingPieceHandoff(query);
      const persisted = await persistSavedLookReturnContext(actorRequest, context);
      if (!persisted || !isActorRequestCurrent(actorRequest)) return;
      router.push('/stylist/saved-looks/handoff');
    } finally {
      if (isActorRequestCurrent(actorRequest)) setBusy(false);
    }
  }, [busy, current.look]);

  if (!PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE) {
    return (
      <LuxuryScreen safeArea scrollable testID="private-saved-look-detail-disabled">
        <StatusBar style="dark" />
        <KScanHeader title="Saved Look" onBack={() => router.replace('/stylist')} />
        <EmptyStateCard title="Not available" subtitle="Saved Looks is not available in this build." />
      </LuxuryScreen>
    );
  }

  if (!actorLoading && !actorId) {
    return (
      <LuxuryScreen safeArea scrollable testID="private-saved-look-detail-signed-out">
        <StatusBar style="dark" />
        <KScanHeader title="Saved Look" onBack={() => router.replace('/stylist')} />
        <EmptyStateCard title="Sign in to continue" subtitle="Saved Looks are private to your account." />
      </LuxuryScreen>
    );
  }

  return (
    <LuxuryScreen safeArea scrollable testID="private-saved-look-detail">
      <StatusBar style="dark" />
      <KScanHeader title="Saved Look" onBack={() => router.replace('/stylist/saved-looks')} />

      {current.status === 'loading' ? (
        <View style={styles.loading} accessibilityLiveRegion="polite">
          <ActivityIndicator size="large" color={LUXURY.colors.plum} />
          <Text style={styles.muted}>Loading Saved Look...</Text>
        </View>
      ) : null}

      {current.status === 'missing' ? (
        <EmptyStateCard title="Saved Look not found" subtitle="It may have been deleted on this device." />
      ) : null}

      {current.status === 'error' ? (
        <InlineNotice variant="error" title="Saved Look unavailable" body="We couldn't read this Saved Look safely." />
      ) : null}

      {current.look ? (
        <>
          <SectionHeader
            title={current.look.name || current.look.occasion || 'Saved Look'}
            subtitle={`Saved ${new Date(current.look.createdAt).toLocaleDateString()}`}
          />
          <View style={styles.renameRow}>
            <TextInput
              value={renameDraft}
              onChangeText={setRenameDraft}
              maxLength={80}
              placeholder="Name this Look"
              placeholderTextColor={LUXURY.colors.stone}
              style={styles.input}
              accessibilityLabel="Saved Look name"
              testID="saved-look-name-input"
            />
            <SecondaryButton
              title="Rename"
              onPress={() => void rename()}
              disabled={busy}
              accessibilityLabel="Rename this Saved Look"
              testID="rename-saved-look-button"
            />
          </View>

          {current.closetUnavailable ? (
            <InlineNotice
              variant="error"
              title="Closet unavailable"
              body="Ownership is not recalculated from an empty fallback. Try again when your Closet can be read."
            />
          ) : null}

          {current.highlightedSlot ? (
            <InlineNotice
              variant="info"
              title={`${PRIVATE_SLOT_LABELS[current.highlightedSlot]} restored`}
              body="Ownership was refreshed after the missing-piece handoff."
            />
          ) : null}

          {current.look.slots.map((slot) => {
            const slotOwnership = ownership?.slots.find((entry) => entry.slotKey === slot.slotKey) ?? null;
            const liveItem = slot.closetItemId ? closetById.get(slot.closetItemId) ?? null : null;
            const matched = slotOwnership?.matchedItem ?? liveItem;
            const uri = matched?.thumbnailUri ?? matched?.imageUri ?? null;
            return (
              <View
                key={slot.slotKey}
                style={[
                  styles.slotCard,
                  current.highlightedSlot === slot.slotKey ? styles.slotCardHighlighted : null,
                ]}
                testID="saved-look-slot"
              >
                <View style={styles.slotHeader}>
                  {uri ? (
                    <Image source={{ uri }} style={styles.image} resizeMode="cover" accessibilityLabel={`${matched?.title ?? 'Closet item'} image`} />
                  ) : (
                    <View style={[styles.image, styles.placeholder]} accessibilityLabel="No current image">
                      <Text style={styles.placeholderText}>{PRIVATE_SLOT_LABELS[slot.slotKey]}</Text>
                    </View>
                  )}
                  <View style={styles.slotCopy}>
                    <Text style={styles.slotTitle}>{PRIVATE_SLOT_LABELS[slot.slotKey]}</Text>
                    <Text style={styles.stateLabel}>
                      {slotOwnership ? STATE_LABELS[slotOwnership.state] : 'Ownership unavailable'}
                    </Text>
                    {matched ? <Text style={styles.muted}>{matched.title}</Text> : null}
                  </View>
                </View>

                {slotOwnership ? (
                  <Text style={styles.explanation}>{slotOwnership.confidenceExplanation}</Text>
                ) : null}

                {slotOwnership?.showOwnedAlternativeFirst && slotOwnership.matchedItem ? (
                  <InlineNotice
                    variant="info"
                    title="Owned alternative first"
                    body={slotOwnership.matchedItem.title}
                  />
                ) : null}

                {slotOwnership?.ownedAlternatives.length ? (
                  <Text style={styles.explanation}>
                    Other owned options: {slotOwnership.ownedAlternatives.map((item) => item.title).join(', ')}
                  </Text>
                ) : null}

                {slotOwnership ? (
                  <SecondaryButton
                    title={slotOwnership.commerceSuppressed ? 'Shop anyway' : 'Find an alternative'}
                    onPress={() => void beginHandoff(slot, slotOwnership)}
                    disabled={busy}
                    accessibilityLabel={`${slotOwnership.commerceSuppressed ? 'Shop anyway for' : 'Find an alternative for'} ${PRIVATE_SLOT_LABELS[slot.slotKey]}`}
                    testID="missing-piece-handoff-button"
                  />
                ) : null}
              </View>
            );
          })}

          <PrimaryButton
            title="Return to Dressing Room"
            onPress={() => router.push('/stylist/dressing-room')}
            disabled={busy}
            accessibilityLabel="Return to the private Dressing Room"
          />
          <SecondaryButton
            title="Delete Saved Look"
            onPress={confirmDelete}
            disabled={busy}
            style={styles.action}
            accessibilityLabel="Delete this Saved Look"
            testID="delete-saved-look-detail-button"
          />
        </>
      ) : null}
    </LuxuryScreen>
  );
}

const styles = StyleSheet.create({
  loading: { alignItems: 'center', paddingVertical: SPACING.xl, gap: SPACING.sm },
  renameRow: { gap: SPACING.sm, marginBottom: SPACING.lg },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    borderRadius: 14,
    backgroundColor: LUXURY.colors.pearl,
    color: LUXURY.colors.ink,
    paddingHorizontal: SPACING.md,
    fontSize: 16,
  },
  slotCard: {
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    borderRadius: 18,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    gap: SPACING.sm,
  },
  slotCardHighlighted: { borderColor: LUXURY.colors.plum, borderWidth: 2 },
  slotHeader: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  image: { width: 72, height: 84, borderRadius: 13, backgroundColor: LUXURY.colors.champagne },
  placeholder: { alignItems: 'center', justifyContent: 'center', padding: SPACING.xs },
  placeholderText: { color: LUXURY.colors.stone, fontSize: 10, textAlign: 'center' },
  slotCopy: { flex: 1, gap: SPACING.xs },
  slotTitle: { color: LUXURY.colors.ink, fontSize: 17, fontWeight: '700' },
  stateLabel: { color: LUXURY.colors.plum, fontSize: 13, fontWeight: '700' },
  muted: { color: LUXURY.colors.stone, fontSize: 13, lineHeight: 19 },
  explanation: { color: LUXURY.colors.graphite, fontSize: 13, lineHeight: 19 },
  action: { marginTop: SPACING.md },
});
