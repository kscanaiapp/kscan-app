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
import {
  ActivityIndicator,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
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
import {
  PRIVATE_WORKSPACE_COPY,
  PRIVATE_LOOK_LABELS,
  describeMissingSlots,
} from '../../../services/privateDressingRoomCoordinator';
import type { ResolvedLookItem } from '../../../services/privateDressingRoomCoordinator';
import { PRIVATE_SLOT_LABELS } from '../../../types/privateDressingRoomComposition';
import type { PrivateDressingRoomSlot } from '../../../types/privateDressingRoomComposition';
import { PRIVATE_COMPARISON_COPY } from '../../../services/privateDressingRoomComparison';

const OCCASIONS = ['Work', 'Dinner', 'Weekend', 'Event', 'Travel'];

/**
 * The governed tablet breakpoint for this screen.
 *
 * The repository declares no shared breakpoint constant, so the assignment's
 * 768 logical pixels is used and documented here rather than scattered.
 */
const TABLET_MIN_WIDTH = 768;

/**
 * One garment thumbnail.
 *
 * NEVER BLANK SPACE: an item without an image falls back to its slot label on a
 * placeholder tile. No fashion photography is invented, and a deleted garment
 * shows that it is gone rather than a stale picture.
 */
function LookThumb({ entry, large = false }: { entry: ResolvedLookItem; large?: boolean }) {
  const uri = entry.item?.thumbnailUri ?? entry.item?.imageUri ?? null;
  const label = PRIVATE_SLOT_LABELS[entry.slot];
  if (!uri) {
    return (
      <View
        style={[styles.thumb, large ? styles.thumbLarge : null, styles.thumbPlaceholder]}
        accessibilityLabel={`${label}: no image available`}
      >
        <Text style={styles.thumbPlaceholderText} numberOfLines={1}>
          {label}
        </Text>
      </View>
    );
  }
  return (
    <Image
      source={{ uri }}
      style={[styles.thumb, large ? styles.thumbLarge : null]}
      resizeMode="cover"
      accessibilityLabel={`${label}: ${entry.item?.title ?? 'image'}`}
    />
  );
}

export default function PrivateDressingRoomScreen() {
  const params = useLocalSearchParams();
  const workspace = usePrivateDressingRoom(params?.closetItemId);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const { width } = useWindowDimensions();
  const isWide = width >= TABLET_MIN_WIDTH;

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
    requestContextChange,
    discardSession,
    resetSession,
    compositionStatus,
    compositionError,
    looks,
    selectLook,
    rebuildOutfits,
    retry,
    resetComposition,
    // Phase 3. All inert while the nested flag is OFF.
    interactionsEnabled,
    interactionCorrupt,
    missingSwappedItems,
    effectiveLooks,
    canUndo,
    undoAvailability,
    slotEditor,
    preview,
    comparison,
    comparing,
    canCompareLooks,
    pendingContextChange,
    openSlotEditor,
    closeSlotEditor,
    previewSlotCandidate,
    applySlotCandidate,
    restoreOriginalSlot,
    undoLastSwap,
    resetCorruptInteraction,
    openComparison,
    closeComparison,
    confirmContextChange,
    cancelContextChange,
  } = workspace;

  const editorLook = effectiveLooks.find((look) => look.lookId === slotEditor.lookId) ?? null;
  const anchorId = session?.anchorClosetItemId ?? null;
  const closetById = new Map(closetItems.map((item) => [item.id, item]));

  /** A slot row's override state, used to decide whether Restore Original shows. */
  const overrideFor = (lookId: string | null, slot: PrivateDressingRoomSlot | null) => {
    if (!lookId || !slot) return null;
    const look = effectiveLooks.find((entry) => entry.lookId === lookId);
    return look?.items.find((item) => item.slot === slot && item.overridden) ?? null;
  };

  /**
   * The outfit section.
   *
   * PHASE 2 STILL OFFERS NO SWAP, COMPARE, SAVE, ELISE OR COMMERCE CONTROL, and
   * no disabled teaser for any of them — a control that cannot do anything
   * teaches the user the feature is broken. Phase 3 owns swaps and comparison.
   */
  const renderOutfits = () => {
    if (compositionStatus === 'idle') {
      return (
        <InlineNotice
          variant="info"
          title="Pick a starting point"
          body={PRIVATE_WORKSPACE_COPY.noSession}
        />
      );
    }

    if (compositionStatus === 'building') {
      return (
        <View style={styles.loadingWrap} accessibilityLiveRegion="polite" testID="composition-building">
          <ActivityIndicator
            size="large"
            color={LUXURY.colors.plum}
            accessibilityLabel={PRIVATE_WORKSPACE_COPY.building}
          />
          <Text style={styles.loadingText}>{PRIVATE_WORKSPACE_COPY.building}</Text>
        </View>
      );
    }

    if (compositionStatus === 'corrupt') {
      return (
        <View testID="composition-corrupt">
          <InlineNotice
            variant="error"
            title="Outfits not restored"
            body={PRIVATE_WORKSPACE_COPY.compositionCorrupt}
          />
          <PrimaryButton
            title={PRIVATE_WORKSPACE_COPY.rebuild}
            onPress={() => void resetComposition()}
            disabled={busy}
            accessibilityLabel="Reset and rebuild outfits from your current Closet"
            testID="reset-composition-button"
          />
        </View>
      );
    }

    if (compositionStatus === 'insufficient') {
      return (
        <View testID="composition-insufficient">
          <InlineNotice
            variant="info"
            title="Not enough to work with yet"
            body={
              compositionError === 'UNSUPPORTED_ANCHOR'
                ? PRIVATE_WORKSPACE_COPY.unsupportedAnchor
                : PRIVATE_WORKSPACE_COPY.insufficient
            }
          />
          <SecondaryButton
            title={PRIVATE_WORKSPACE_COPY.returnToCloset}
            onPress={() => router.push({ pathname: '/library', params: { section: 'closet' } })}
            accessibilityLabel="Return to your Closet"
            testID="return-to-closet-button"
          />
        </View>
      );
    }

    if (compositionStatus === 'failed') {
      return (
        <View testID="composition-failed">
          <InlineNotice
            variant="error"
            title="Couldn't build outfits"
            body={
              compositionError === 'PERSISTENCE_FAILED'
                ? PRIVATE_WORKSPACE_COPY.persistenceFailed
                : PRIVATE_WORKSPACE_COPY.compositionFailed
            }
          />
          <PrimaryButton
            title={PRIVATE_WORKSPACE_COPY.retry}
            onPress={() => retry()}
            disabled={busy}
            accessibilityLabel="Try building outfits again"
            testID="retry-composition-button"
          />
        </View>
      );
    }

    const active = looks.find((look) => look.isActive) ?? looks[0] ?? null;

    return (
      <View testID="composition-ready">
        <SectionHeader
          title="Outfit options"
          subtitle={`${looks.length} option${looks.length === 1 ? '' : 's'} from your Closet`}
        />

        {compositionStatus === 'stale' ? (
          <InlineNotice
            variant="info"
            title="Closet changed"
            body={PRIVATE_WORKSPACE_COPY.compositionStale}
          />
        ) : null}

        {compositionStatus === 'stale' ? (
          <PrimaryButton
            title={PRIVATE_WORKSPACE_COPY.rebuild}
            onPress={() => void rebuildOutfits()}
            disabled={busy}
            accessibilityLabel="Rebuild outfits from your current Closet"
            testID="rebuild-outfits-button"
          />
        ) : null}

        {/*
          A horizontally scrollable selector on phones rather than three
          compressed equal-width cards, and a wrapping grid at tablet width.
        */}
        <ScrollView
          horizontal={!isWide}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={isWide ? styles.lookGrid : styles.lookRow}
          testID="look-selector"
        >
          {looks.map((look) => {
            const anchorEntry = look.items[0];
            const supporting = look.items.slice(1, 4);
            const overflow = look.itemCount - 1 - supporting.length;
            const missingText = describeMissingSlots(look.missingSlots);
            return (
              <TouchableOpacity
                key={look.lookId}
                style={[
                  styles.lookCard,
                  isWide ? styles.lookCardWide : null,
                  look.isActive ? styles.lookCardSelected : null,
                ]}
                onPress={() => void selectLook(look.lookId)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityState={{ selected: look.isActive, disabled: busy }}
                accessibilityLabel={[
                  `Look ${look.rank + 1}`,
                  look.completeness === 'complete' ? 'complete outfit' : 'partial outfit',
                  `${look.itemCount} Closet item${look.itemCount === 1 ? '' : 's'}`,
                  missingText ?? '',
                  look.isActive ? 'selected' : '',
                ]
                  .filter(Boolean)
                  .join(', ')}
                testID="look-card"
              >
                <View style={styles.lookImages}>
                  {/* The anchor is first and largest: it is what the user chose. */}
                  <LookThumb entry={anchorEntry} large />
                  <View style={styles.lookSupporting}>
                    {supporting.map((entry) => (
                      <LookThumb key={entry.closetItemId} entry={entry} />
                    ))}
                    {overflow > 0 ? (
                      <View style={styles.lookOverflow}>
                        <Text style={styles.lookOverflowText}>{`+${overflow}`}</Text>
                      </View>
                    ) : null}
                  </View>
                </View>
                <Text style={styles.lookTitle}>{`Look ${look.rank + 1}`}</Text>
                <Text style={styles.lookMeta}>
                  {`${look.itemCount} item${look.itemCount === 1 ? '' : 's'}`}
                </Text>
                {missingText ? <Text style={styles.lookMissing}>{missingText}</Text> : null}
                {look.labelCodes.map((code) => (
                  <Text key={code} style={styles.lookLabel}>
                    {PRIVATE_LOOK_LABELS[code] ?? code}
                  </Text>
                ))}
                {look.stale ? (
                  <Text style={styles.lookMissing}>{PRIVATE_WORKSPACE_COPY.lookStale}</Text>
                ) : null}
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {active ? (
          <View testID="active-look-detail">
            <SectionHeader title="Active look" />
            {active.completeness === 'partial' ? (
              <InlineNotice
                variant="info"
                title={describeMissingSlots(active.missingSlots) ?? 'Missing a piece'}
                body="Built from the pieces already in your Closet."
              />
            ) : null}
            {active.items.map((entry) => {
              const isAnchor = !!anchorId && entry.closetItemId === anchorId;
              const edited = !!overrideFor(active.lookId, entry.slot);
              return (
                <View
                  key={entry.closetItemId}
                  style={styles.slotRow}
                  // Slot BEFORE garment, so a screen reader announces the role first.
                  accessibilityLabel={[
                    `${PRIVATE_SLOT_LABELS[entry.slot]}: ${
                      entry.item?.title ?? 'no longer in your Closet'
                    }`,
                    isAnchor ? PRIVATE_WORKSPACE_COPY.anchorLockedLabel : '',
                    edited ? 'edited' : '',
                  ]
                    .filter(Boolean)
                    .join(', ')}
                  testID="active-look-slot"
                >
                  <Text style={styles.slotName}>{PRIVATE_SLOT_LABELS[entry.slot]}</Text>
                  <Text style={styles.slotItem}>
                    {entry.item?.title ?? PRIVATE_WORKSPACE_COPY.lookStale}
                    {edited ? ' · edited' : ''}
                  </Text>
                  {interactionsEnabled ? (
                    isAnchor ? (
                      // The anchor is locked: no enabled swap control exists.
                      <Text style={styles.slotLocked} testID="anchor-locked-label">
                        {PRIVATE_WORKSPACE_COPY.anchorLockedLabel}
                      </Text>
                    ) : (
                      <TouchableOpacity
                        style={styles.slotAction}
                        onPress={() => void openSlotEditor(active.lookId, entry.slot)}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel={`Swap ${PRIVATE_SLOT_LABELS[entry.slot]}`}
                        testID="slot-swap-button"
                      >
                        <Text style={styles.slotActionText}>{PRIVATE_WORKSPACE_COPY.swapAction}</Text>
                      </TouchableOpacity>
                    )
                  ) : null}
                </View>
              );
            })}

            {/* An explicitly missing slot can be FILLED, never invented. */}
            {interactionsEnabled
              ? active.missingSlots.map((slot) => (
                  <View key={`missing-${slot}`} style={styles.slotRow} testID="fillable-slot">
                    <Text style={styles.slotName}>{PRIVATE_SLOT_LABELS[slot]}</Text>
                    <Text style={styles.slotItem}>{PRIVATE_COMPARISON_COPY.missing}</Text>
                    <TouchableOpacity
                      style={styles.slotAction}
                      onPress={() => void openSlotEditor(active.lookId, slot)}
                      disabled={busy}
                      accessibilityRole="button"
                      accessibilityLabel={`Choose ${PRIVATE_SLOT_LABELS[slot]}`}
                      testID="slot-fill-button"
                    >
                      <Text style={styles.slotActionText}>{PRIVATE_WORKSPACE_COPY.chooseItem}</Text>
                    </TouchableOpacity>
                  </View>
                ))
              : null}

            {/*
              Undo appears only when persisted history exists. Never a redo.

              When the item it would put back has left the Closet the control
              stays VISIBLE but disabled, with the reason stated next to it —
              the user learns the change is not reversible before committing to
              a tap, rather than from a failure afterwards.
            */}
            {interactionsEnabled && canUndo ? (
              <View testID="undo-section">
                <SecondaryButton
                  title={PRIVATE_WORKSPACE_COPY.undo}
                  onPress={() => void undoLastSwap()}
                  disabled={busy || undoAvailability === 'blocked_prior_item_missing'}
                  accessibilityLabel={
                    undoAvailability === 'blocked_prior_item_missing'
                      ? `Undo the last outfit change, unavailable. ${PRIVATE_WORKSPACE_COPY.undoBlockedPriorItemMissing}`
                      : 'Undo the last outfit change'
                  }
                  testID="undo-button"
                />
                {undoAvailability === 'blocked_prior_item_missing' ? (
                  <Text
                    style={styles.undoBlockedText}
                    accessibilityLiveRegion="polite"
                    testID="undo-blocked-reason"
                  >
                    {PRIVATE_WORKSPACE_COPY.undoBlockedPriorItemMissing}
                  </Text>
                ) : null}
              </View>
            ) : null}

            {interactionsEnabled && canCompareLooks ? (
              <SecondaryButton
                title={PRIVATE_COMPARISON_COPY.entry}
                onPress={() => void openComparison()}
                disabled={busy}
                accessibilityLabel="Compare two outfits"
                testID="compare-entry-button"
              />
            ) : null}
            <Text style={styles.usesLine}>
              {`Uses ${active.itemCount} Closet item${active.itemCount === 1 ? '' : 's'}`}
            </Text>
          </View>
        ) : null}
      </View>
    );
  };

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
                // Clearing the anchor replaces the composition exactly as
                // choosing a different one does, so it uses the same gate.
                onPress={() =>
                  void requestContextChange({ kind: 'anchor', anchorClosetItemId: null })
                }
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
                      // Routed through the coordinator so a change that would
                      // discard persisted edits asks first.
                      onPress={() =>
                        void requestContextChange({ kind: 'anchor', anchorClosetItemId: item.id })
                      }
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
                    onPress={() =>
                      void requestContextChange({
                        kind: 'occasion',
                        occasion: selected ? null : occasion,
                      })
                    }
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

            {renderOutfits()}

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

      {/* Corrupt EDITS never cost the user their outfits. */}
      {interactionsEnabled && interactionCorrupt ? (
        <View testID="interaction-corrupt">
          <InlineNotice
            variant="error"
            title="Edits not restored"
            body={PRIVATE_WORKSPACE_COPY.interactionCorrupt}
          />
          <SecondaryButton
            title={PRIVATE_WORKSPACE_COPY.resetEdits}
            onPress={() => void resetCorruptInteraction()}
            disabled={busy}
            accessibilityLabel="Reset your outfit edits"
            testID="reset-edits-button"
          />
        </View>
      ) : null}

      {/* A swapped garment that has left the Closet is never silently replaced. */}
      {interactionsEnabled && missingSwappedItems.length > 0 ? (
        <View testID="swapped-item-missing">
          <InlineNotice
            variant="info"
            title="Item unavailable"
            body={PRIVATE_WORKSPACE_COPY.swappedItemMissing}
          />
          {missingSwappedItems.map((entry) => (
            <View key={`${entry.lookId}-${entry.slot}`} style={styles.slotRow}>
              <Text style={styles.slotName}>{PRIVATE_SLOT_LABELS[entry.slot]}</Text>
              <TouchableOpacity
                style={styles.slotAction}
                onPress={() => void restoreOriginalSlot(entry.lookId, entry.slot)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={`Restore the original ${PRIVATE_SLOT_LABELS[entry.slot]}`}
                testID="missing-restore-button"
              >
                <Text style={styles.slotActionText}>
                  {PRIVATE_WORKSPACE_COPY.restoreOriginal}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.slotAction}
                onPress={() => void openSlotEditor(entry.lookId, entry.slot)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={`Choose another ${PRIVATE_SLOT_LABELS[entry.slot]}`}
                testID="missing-choose-button"
              >
                <Text style={styles.slotActionText}>{PRIVATE_WORKSPACE_COPY.chooseAnother}</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      ) : null}

      {renderBody()}

      {/* ── Slot editor ─────────────────────────────────────────────────── */}
      <Modal
        visible={interactionsEnabled && slotEditor.status !== 'closed'}
        transparent
        animationType="slide"
        onRequestClose={closeSlotEditor}
      >
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheet} testID="slot-editor">
            <SectionHeader
              title={`Change ${slotEditor.slot ? PRIVATE_SLOT_LABELS[slotEditor.slot] : ''}`}
              subtitle={
                slotEditor.candidates?.currentClosetItemId
                  ? `Current: ${
                      closetById.get(slotEditor.candidates.currentClosetItemId)?.title ?? ''
                    }`
                  : PRIVATE_COMPARISON_COPY.missing
              }
            />

            {slotEditor.status === 'loading' ? (
              <View style={styles.loadingWrap} accessibilityLiveRegion="polite">
                <ActivityIndicator size="large" color={LUXURY.colors.plum} />
              </View>
            ) : null}

            {slotEditor.status === 'anchor_locked' ? (
              <InlineNotice
                variant="info"
                title={PRIVATE_WORKSPACE_COPY.anchorLockedLabel}
                body={PRIVATE_WORKSPACE_COPY.anchorLocked}
              />
            ) : null}

            {/* Never an empty list with no explanation. */}
            {slotEditor.status === 'no_candidates' ? (
              <View testID="no-candidates">
                <InlineNotice
                  variant="info"
                  title="No alternatives"
                  body={PRIVATE_WORKSPACE_COPY.noAlternatives}
                />
                <SecondaryButton
                  title={PRIVATE_WORKSPACE_COPY.addToCloset}
                  onPress={() => {
                    closeSlotEditor();
                    router.push({ pathname: '/library', params: { section: 'closet' } });
                  }}
                  accessibilityLabel="Add an item to your Closet"
                  testID="add-to-closet-button"
                />
              </View>
            ) : null}

            {slotEditor.status === 'failed' ? (
              <InlineNotice
                variant="error"
                title="Couldn't change this piece"
                body={
                  slotEditor.resultCode === 'STALE_PREVIEW'
                    ? PRIVATE_WORKSPACE_COPY.stalePreview
                    : PRIVATE_WORKSPACE_COPY.applyFailed
                }
              />
            ) : null}

            {slotEditor.status === 'ready' || slotEditor.status === 'applying' ? (
              <ScrollView style={styles.candidateList} testID="candidate-list">
                {(slotEditor.candidates?.candidates ?? []).map((candidate) => {
                  const previewed = preview?.candidateClosetItemId === candidate.closetItemId;
                  return (
                    <TouchableOpacity
                      key={candidate.closetItemId}
                      style={[styles.candidateRow, previewed ? styles.candidateRowSelected : null]}
                      onPress={() => previewSlotCandidate(candidate.closetItemId)}
                      disabled={busy || slotEditor.status === 'applying'}
                      accessibilityRole="button"
                      accessibilityState={{ selected: previewed, disabled: busy }}
                      accessibilityLabel={[
                        candidate.item.title,
                        candidate.item.brand ?? '',
                        candidate.item.primaryColor ?? '',
                        previewed ? 'previewed' : '',
                      ]
                        .filter(Boolean)
                        .join(', ')}
                      testID="candidate-option"
                    >
                      <LookThumb
                        entry={{
                          slot: slotEditor.slot!,
                          closetItemId: candidate.closetItemId,
                          item: candidate.item,
                        }}
                      />
                      <View style={styles.candidateText}>
                        <Text style={styles.slotItem}>{candidate.item.title}</Text>
                        {candidate.item.brand || candidate.item.primaryColor ? (
                          <Text style={styles.lookMeta}>
                            {[candidate.item.brand, candidate.item.primaryColor]
                              .filter(Boolean)
                              .join(' · ')}
                          </Text>
                        ) : null}
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            ) : null}

            {/* Preview and Apply are distinct: tapping a card never persists. */}
            {slotEditor.status === 'ready' || slotEditor.status === 'applying' ? (
              <PrimaryButton
                title={PRIVATE_WORKSPACE_COPY.applySwap}
                onPress={() => void applySlotCandidate()}
                disabled={busy || !preview || slotEditor.status === 'applying'}
                accessibilityLabel="Apply this swap"
                testID="apply-swap-button"
              />
            ) : null}

            {overrideFor(slotEditor.lookId, slotEditor.slot) ? (
              <SecondaryButton
                title={PRIVATE_WORKSPACE_COPY.restoreOriginal}
                onPress={() =>
                  void restoreOriginalSlot(slotEditor.lookId!, slotEditor.slot!)
                }
                disabled={busy}
                accessibilityLabel={`Restore the original ${
                  slotEditor.slot ? PRIVATE_SLOT_LABELS[slotEditor.slot] : 'item'
                }`}
                testID="restore-original-button"
              />
            ) : null}

            <SecondaryButton
              title={PRIVATE_WORKSPACE_COPY.cancelSwap}
              onPress={closeSlotEditor}
              accessibilityLabel="Cancel and close without changing this piece"
              testID="cancel-swap-button"
            />
          </View>
        </View>
      </Modal>

      {/* ── Comparison ──────────────────────────────────────────────────── */}
      <Modal
        visible={interactionsEnabled && comparing && !!comparison?.available}
        transparent
        animationType="slide"
        onRequestClose={() => void closeComparison()}
      >
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheet} testID="comparison-view">
            <SectionHeader
              title={PRIVATE_COMPARISON_COPY.title}
              subtitle={`${comparison?.leftLabel ?? ''} · ${comparison?.rightLabel ?? ''}`}
            />
            {/* The shared anchor is resolved ONCE and pinned, not repeated. */}
            {comparison?.anchorRow ? (
              <View style={styles.anchorPin} testID="comparison-anchor-pin">
                <Text style={styles.slotName}>
                  {PRIVATE_SLOT_LABELS[comparison.anchorRow.slot]}
                </Text>
                <Text style={styles.slotItem}>
                  {closetById.get(comparison.anchorRow.left?.closetItemId ?? '')?.title ?? ''}
                </Text>
                <Text style={styles.lookMeta}>{PRIVATE_COMPARISON_COPY.anchorRow}</Text>
              </View>
            ) : null}

            <ScrollView testID="comparison-rows">
              {(comparison?.rows ?? [])
                .filter((row) => !row.anchor)
                .map((row) => (
                  <View
                    key={row.slot}
                    style={[styles.compareRow, row.different ? styles.compareRowDifferent : null]}
                    accessibilityLabel={[
                      PRIVATE_SLOT_LABELS[row.slot],
                      `${comparison?.leftLabel}: ${
                        row.left
                          ? closetById.get(row.left.closetItemId)?.title ?? 'unavailable'
                          : PRIVATE_COMPARISON_COPY.missing
                      }`,
                      `${comparison?.rightLabel}: ${
                        row.right
                          ? closetById.get(row.right.closetItemId)?.title ?? 'unavailable'
                          : PRIVATE_COMPARISON_COPY.missing
                      }`,
                      row.different ? PRIVATE_COMPARISON_COPY.differs : PRIVATE_COMPARISON_COPY.same,
                    ].join(', ')}
                    testID="comparison-row"
                  >
                    <Text style={styles.slotName}>{PRIVATE_SLOT_LABELS[row.slot]}</Text>
                    <View style={isWide ? styles.compareColumnsWide : styles.compareColumns}>
                      <Text style={styles.compareCell}>
                        {row.left
                          ? closetById.get(row.left.closetItemId)?.title ?? '—'
                          : PRIVATE_COMPARISON_COPY.missing}
                      </Text>
                      <Text style={styles.compareCell}>
                        {row.right
                          ? closetById.get(row.right.closetItemId)?.title ?? '—'
                          : PRIVATE_COMPARISON_COPY.missing}
                      </Text>
                    </View>
                  </View>
                ))}
            </ScrollView>

            <SecondaryButton
              title={PRIVATE_COMPARISON_COPY.close}
              onPress={() => void closeComparison()}
              accessibilityLabel="Close the comparison"
              testID="close-comparison-button"
            />
          </View>
        </View>
      </Modal>

      {/* ── Destructive context change ──────────────────────────────────── */}
      <Modal
        visible={!!pendingContextChange}
        transparent
        animationType="fade"
        onRequestClose={cancelContextChange}
      >
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheet} testID="context-change-confirm">
            <InlineNotice
              variant="info"
              title="Discard your edits?"
              body={
                pendingContextChange?.kind === 'anchor'
                  ? PRIVATE_WORKSPACE_COPY.editsDiscardedAnchor
                  : PRIVATE_WORKSPACE_COPY.editsDiscardedOccasion
              }
            />
            <PrimaryButton
              title={PRIVATE_WORKSPACE_COPY.continueChange}
              onPress={() => void confirmContextChange()}
              disabled={busy}
              accessibilityLabel="Continue and discard the outfit edits"
              testID="confirm-context-change-button"
            />
            <SecondaryButton
              title={PRIVATE_WORKSPACE_COPY.keepEditing}
              onPress={cancelContextChange}
              accessibilityLabel="Keep my outfit edits"
              testID="cancel-context-change-button"
            />
          </View>
        </View>
      </Modal>
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

  // ── Outfit options ─────────────────────────────────────────────────────────
  lookRow: { paddingVertical: SPACING.sm },
  /** Tablet: a wrapping grid instead of stretched phone cards. */
  lookGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingVertical: SPACING.sm },
  lookCard: {
    width: 220,
    minHeight: 48,
    marginRight: SPACING.md,
    marginBottom: SPACING.md,
    padding: SPACING.md,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: LUXURY.colors.champagne,
    backgroundColor: LUXURY.colors.pearl,
  },
  lookCardWide: { width: 260 },
  lookCardSelected: { borderColor: LUXURY.colors.plum, borderWidth: 2 },
  lookImages: { flexDirection: 'row', marginBottom: SPACING.sm },
  lookSupporting: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', marginLeft: SPACING.xs },
  thumb: {
    width: 44,
    height: 58,
    borderRadius: 6,
    margin: 2,
    backgroundColor: LUXURY.colors.champagne,
  },
  thumbLarge: { width: 76, height: 100, borderRadius: 8, margin: 0 },
  thumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  thumbPlaceholderText: { fontSize: 9, color: LUXURY.colors.plum, paddingHorizontal: 2 },
  lookOverflow: {
    width: 44,
    height: 58,
    borderRadius: 6,
    margin: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: LUXURY.colors.champagne,
  },
  lookOverflowText: { fontSize: 12, color: LUXURY.colors.ink },
  lookTitle: { fontSize: 15, color: LUXURY.colors.ink, marginBottom: 2 },
  lookMeta: { fontSize: 12, color: LUXURY.colors.plum },
  lookMissing: { fontSize: 12, color: LUXURY.colors.ink, marginTop: 2 },
  lookLabel: { fontSize: 11, color: LUXURY.colors.plum, marginTop: 2 },

  // ── Active look detail ─────────────────────────────────────────────────────
  slotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: LUXURY.colors.champagne,
  },
  slotName: { width: 96, fontSize: 12, color: LUXURY.colors.plum },
  slotItem: { flex: 1, fontSize: 14, color: LUXURY.colors.ink },
  usesLine: { marginTop: SPACING.md, fontSize: 13, color: LUXURY.colors.plum },
  // Sits directly beneath the disabled Undo control it explains.
  undoBlockedText: { marginTop: SPACING.xs, fontSize: 13, color: LUXURY.colors.ink },

  // ── Phase 3 slot editing ───────────────────────────────────────────────────
  slotAction: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: SPACING.md,
    marginLeft: SPACING.sm,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: LUXURY.colors.champagne,
  },
  slotActionText: { fontSize: 13, color: LUXURY.colors.plum },
  slotLocked: { fontSize: 12, color: LUXURY.colors.plum, marginLeft: SPACING.sm },
  sheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    maxHeight: '85%',
    padding: SPACING.lg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    backgroundColor: LUXURY.colors.pearl,
  },
  candidateList: { maxHeight: 320 },
  candidateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    padding: SPACING.sm,
    marginBottom: SPACING.sm,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: LUXURY.colors.champagne,
  },
  candidateRowSelected: { borderColor: LUXURY.colors.plum, borderWidth: 2 },
  candidateText: { flex: 1, marginLeft: SPACING.md },

  // ── Comparison ─────────────────────────────────────────────────────────────
  anchorPin: {
    padding: SPACING.md,
    marginBottom: SPACING.md,
    borderRadius: 12,
    backgroundColor: LUXURY.colors.champagne,
  },
  compareRow: {
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: LUXURY.colors.champagne,
  },
  compareRowDifferent: { borderLeftWidth: 3, borderLeftColor: LUXURY.colors.plum, paddingLeft: SPACING.sm },
  /** Phone: stacked cells. Tablet: true two columns at the SAME Phase 2 breakpoint. */
  compareColumns: { flexDirection: 'column' },
  compareColumnsWide: { flexDirection: 'row', justifyContent: 'space-between' },
  compareCell: { flex: 1, fontSize: 14, color: LUXURY.colors.ink, paddingVertical: 2 },
});
