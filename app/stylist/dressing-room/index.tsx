// Private Dressing Room workspace (Build 3: Dressing Rooms V1, Phase 1).
//
// THIS IS NOT THE COLLABORATIVE PRODUCT. `/dressing-rooms` and
// `/(public)/rooms/[token]` are the cloud rooms with membership, reactions,
// voting and share tokens. This route is a device-local, actor-private
// workspace: it reads the Build 2 Closet and one private session record, and
// touches no Supabase row at all.
//
// PHASE 1 DOES NOT GENERATE OUTFITS. There is deliberately no "Continue"
// button, no placeholder Look, and no simulated generation — an action with no
// destination teaches the user the feature is broken. The ready state says the
// session is ready for the next step and stops there.
//
// The screen is thin on purpose: every ordering rule lives in
// services/privateDressingRoomCoordinator.ts and every write in
// services/privateDressingRoomSessionStore.ts. Nothing here calls persistence.

import React, { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import {
  LuxuryScreen,
  KScanHeader,
  SectionHeader,
  EmptyStateCard,
  InlineNotice,
  PrimaryButton,
  SecondaryButton,
} from '../../../components/luxury';
import { LUXURY, SPACING } from '../../../constants/theme';
import { PRIVATE_DRESSING_ROOM_V1 } from '../../../constants/featureFlags';
import { goBackOrHome } from '../../../services/navigationExit';
import { usePrivateDressingRoom } from '../../../hooks/usePrivateDressingRoom';
import { PRIVATE_WORKSPACE_COPY } from '../../../services/privateDressingRoomCoordinator';

const OCCASIONS = ['Work', 'Dinner', 'Weekend', 'Event', 'Travel'];

export default function PrivateDressingRoomScreen() {
  const params = useLocalSearchParams();
  const workspace = usePrivateDressingRoom(params?.closetItemId);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  // Android hardware back and the header control resolve the same way: back
  // when the stack has history, Home otherwise, so a deep link into the
  // workspace can never trap the user here.
  const onBack = useCallback(() => goBackOrHome(router), []);

  // The flag gate is checked here as well as in the coordinator: a disabled
  // feature should not mount a workspace at all, even an empty one.
  if (!PRIVATE_DRESSING_ROOM_V1) {
    return (
      <LuxuryScreen safeArea scrollable testID="private-dressing-room-disabled">
        <StatusBar style="dark" />
        <KScanHeader title="Dressing Room" onBack={onBack} />
        <EmptyStateCard
          title="Not available"
          subtitle="This feature isn't available in this build."
        />
      </LuxuryScreen>
    );
  }

  const {
    status,
    session,
    anchor,
    anchorMissing,
    closetEmpty,
    closetItems,
    routeItemUnavailable,
    recoveredFromBackup,
    errorCode,
    canReset,
    busy,
    startSession,
    setAnchor,
    clearAnchor,
    setOccasion,
    clearOccasion,
    discardSession,
    resetSession,
  } = workspace;

  const renderBody = () => {
    switch (status) {
      case 'actor_loading':
        return (
          <View style={styles.loadingWrap} accessibilityLiveRegion="polite">
            <ActivityIndicator
              size="large"
              color={LUXURY.colors.plum}
              accessibilityLabel={PRIVATE_WORKSPACE_COPY.actorLoading}
            />
            <Text style={styles.loadingText}>{PRIVATE_WORKSPACE_COPY.actorLoading}</Text>
          </View>
        );

      case 'actor_unavailable':
        return (
          <EmptyStateCard
            title="Sign in to continue"
            subtitle={PRIVATE_WORKSPACE_COPY.actorUnavailable}
          />
        );

      case 'closet_loading':
        return (
          <View style={styles.loadingWrap} accessibilityLiveRegion="polite">
            <ActivityIndicator
              size="large"
              color={LUXURY.colors.plum}
              accessibilityLabel={PRIVATE_WORKSPACE_COPY.closetLoading}
            />
            <Text style={styles.loadingText}>{PRIVATE_WORKSPACE_COPY.closetLoading}</Text>
          </View>
        );

      // A Closet that failed to load is NOT an empty Closet, and must not
      // invite the user to build from a wardrobe that is merely unreadable.
      case 'closet_failed':
        return (
          <InlineNotice
            variant="error"
            title="Closet unavailable"
            body={PRIVATE_WORKSPACE_COPY.closetFailed}
          />
        );

      case 'session_unrecoverable':
        return (
          <View testID="private-dressing-room-recovery">
            <InlineNotice
              variant="error"
              title="Session not restored"
              body={
                errorCode === 'session_store_future_schema'
                  ? PRIVATE_WORKSPACE_COPY.futureSchema
                  : PRIVATE_WORKSPACE_COPY.unrecoverable
              }
            />
            {canReset ? (
              <PrimaryButton
                title={PRIVATE_WORKSPACE_COPY.reset}
                onPress={() => void resetSession()}
                disabled={busy}
                accessibilityLabel="Reset the Dressing Room session"
                testID="reset-session-button"
              />
            ) : null}
            <SecondaryButton
              title="Go back"
              onPress={onBack}
              accessibilityLabel="Go back"
            />
          </View>
        );

      case 'no_session':
        return (
          <View testID="private-dressing-room-empty">
            {closetEmpty ? (
              <EmptyStateCard title="Your Closet is empty" subtitle={PRIVATE_WORKSPACE_COPY.closetEmpty} />
            ) : (
              <EmptyStateCard title="No Dressing Room yet" subtitle={PRIVATE_WORKSPACE_COPY.noSession} />
            )}
            <PrimaryButton
              title="Start a Dressing Room"
              onPress={() => void startSession()}
              disabled={busy}
              accessibilityLabel="Start a Dressing Room session"
              testID="start-session-button"
            />
          </View>
        );

      case 'active':
        return (
          <View testID="private-dressing-room-active">
            {recoveredFromBackup ? (
              <InlineNotice
                variant="info"
                title="Session restored"
                body={PRIVATE_WORKSPACE_COPY.recovered}
              />
            ) : null}

            <SectionHeader title="Building around" />
            {anchorMissing ? (
              // The stored id is retained; no stale garment metadata is shown.
              <InlineNotice
                variant="info"
                title="Item unavailable"
                body={PRIVATE_WORKSPACE_COPY.anchorMissing}
              />
            ) : null}

            {anchor ? (
              <View style={styles.anchorCard} testID="anchor-summary">
                {anchor.imageUri ? (
                  <Image
                    source={{ uri: anchor.thumbnailUri ?? anchor.imageUri }}
                    style={styles.anchorImage}
                    resizeMode="cover"
                    accessibilityLabel={`${anchor.title} image`}
                  />
                ) : null}
                <View style={styles.anchorText}>
                  <Text style={styles.anchorTitle}>{anchor.title}</Text>
                  {anchor.displaySummary ? (
                    <Text style={styles.anchorSubtitle}>{anchor.displaySummary}</Text>
                  ) : null}
                </View>
              </View>
            ) : null}

            {!anchor && !anchorMissing ? (
              <Text style={styles.hint}>Choose a piece from your Closet to build around.</Text>
            ) : null}

            {anchor || anchorMissing ? (
              <SecondaryButton
                title="Clear item"
                onPress={() => void clearAnchor()}
                disabled={busy}
                accessibilityLabel="Clear the selected Closet item"
                testID="clear-anchor-button"
              />
            ) : null}

            <SectionHeader title="Your Closet" subtitle={closetEmpty ? undefined : 'Tap to change the item'} />
            {closetEmpty ? (
              <EmptyStateCard title="Your Closet is empty" subtitle={PRIVATE_WORKSPACE_COPY.closetEmpty} />
            ) : (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.closetRow}
              >
                {closetItems.map((item) => {
                  const selected = session?.anchorClosetItemId === item.id;
                  return (
                    <TouchableOpacity
                      key={item.id}
                      style={[styles.closetChip, selected ? styles.closetChipSelected : null]}
                      onPress={() => void setAnchor(item.id)}
                      disabled={busy}
                      accessibilityRole="button"
                      accessibilityState={{ selected, disabled: busy }}
                      accessibilityLabel={`Build around ${item.title}`}
                      testID="closet-anchor-option"
                    >
                      {item.thumbnailUri ?? item.imageUri ? (
                        <Image
                          source={{ uri: item.thumbnailUri ?? item.imageUri! }}
                          style={styles.closetChipImage}
                          resizeMode="cover"
                          accessibilityLabel={`${item.title} image`}
                        />
                      ) : null}
                      <Text style={styles.closetChipText} numberOfLines={2}>
                        {item.title}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            <SectionHeader title="Occasion" />
            <View style={styles.occasionRow}>
              {OCCASIONS.map((occasion) => {
                const selected = session?.occasion === occasion;
                return (
                  <TouchableOpacity
                    key={occasion}
                    style={[styles.occasionChip, selected ? styles.occasionChipSelected : null]}
                    onPress={() => void (selected ? clearOccasion() : setOccasion(occasion))}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityState={{ selected, disabled: busy }}
                    accessibilityLabel={
                      selected ? `Clear occasion ${occasion}` : `Set occasion ${occasion}`
                    }
                    testID="occasion-option"
                  >
                    <Text style={styles.occasionText}>{occasion}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Passive status only. Phase 1 has no generation to offer. */}
            <InlineNotice variant="info" title="Ready" body={PRIVATE_WORKSPACE_COPY.ready} />

            {confirmingDiscard ? (
              <View testID="discard-confirm">
                <InlineNotice
                  variant="info"
                  title="Discard this Dressing Room?"
                  body="Your Closet is not affected."
                />
                <PrimaryButton
                  title={PRIVATE_WORKSPACE_COPY.discard}
                  onPress={() => {
                    setConfirmingDiscard(false);
                    void discardSession();
                  }}
                  disabled={busy}
                  accessibilityLabel="Confirm discarding the Dressing Room session"
                  testID="confirm-discard-button"
                />
                <SecondaryButton
                  title="Keep it"
                  onPress={() => setConfirmingDiscard(false)}
                  accessibilityLabel="Keep the Dressing Room session"
                />
              </View>
            ) : (
              <SecondaryButton
                title={PRIVATE_WORKSPACE_COPY.discard}
                onPress={() => setConfirmingDiscard(true)}
                disabled={busy}
                accessibilityLabel="Discard the Dressing Room session"
                testID="discard-session-button"
              />
            )}
          </View>
        );

      default:
        return null;
    }
  };

  return (
    <LuxuryScreen safeArea scrollable testID="private-dressing-room">
      <StatusBar style="dark" />
      <KScanHeader title="Dressing Room" onBack={onBack} />
      {routeItemUnavailable ? (
        <InlineNotice
          variant="info"
          title="Item unavailable"
          body={PRIVATE_WORKSPACE_COPY.routeItemUnavailable}
        />
      ) : null}
      {renderBody()}
    </LuxuryScreen>
  );
}

const styles = StyleSheet.create({
  loadingWrap: { alignItems: 'center', paddingVertical: SPACING.xl },
  loadingText: { marginTop: SPACING.md, color: LUXURY.colors.ink, textAlign: 'center' },
  hint: { color: LUXURY.colors.ink, marginBottom: SPACING.md },
  anchorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: LUXURY.colors.champagne,
    padding: SPACING.md,
    marginBottom: SPACING.md,
  },
  anchorImage: { width: 72, height: 96, borderRadius: 10, backgroundColor: LUXURY.colors.champagne },
  anchorText: { flex: 1, marginLeft: SPACING.md },
  anchorTitle: { fontSize: 16, color: LUXURY.colors.ink, marginBottom: 4 },
  anchorSubtitle: { fontSize: 13, color: LUXURY.colors.plum },
  closetRow: { paddingVertical: SPACING.sm, gap: SPACING.sm },
  closetChip: {
    width: 108,
    minHeight: 48,
    marginRight: SPACING.sm,
    padding: SPACING.sm,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: LUXURY.colors.champagne,
    backgroundColor: LUXURY.colors.pearl,
  },
  closetChipSelected: { borderColor: LUXURY.colors.plum, borderWidth: 2 },
  closetChipImage: {
    width: '100%',
    height: 96,
    borderRadius: 8,
    marginBottom: SPACING.xs,
    backgroundColor: LUXURY.colors.champagne,
  },
  closetChipText: { fontSize: 12, color: LUXURY.colors.ink },
  occasionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, marginBottom: SPACING.md },
  occasionChip: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: LUXURY.colors.champagne,
    backgroundColor: LUXURY.colors.pearl,
    marginRight: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  occasionChipSelected: { borderColor: LUXURY.colors.plum, borderWidth: 2 },
  occasionText: { color: LUXURY.colors.ink, fontSize: 14 },
});
