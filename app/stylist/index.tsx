// AI Stylist — Style This Item / Style Me for an Event (shared Android/iOS).
//
// Flow: optional anchor (STYLE THIS) → event context → generate → compare
// options → swap / reject / save as Look / ask my room. The anchor stays in
// every result unless the user explicitly asks for it to be replaced
// ("Don't use this item" on the anchor clears it before regenerating).
//
// Unavailable-service behavior (Part 17): the Edge Function is not deployed
// in this build, so unavailable results render calm fallback copy, keep the
// manual builder visible, preserve the anchor and event context, and respect
// the service-level 30s cooldown. Nothing here throws for expected failures.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { FeatureFreezeFallback } from '../../components/FeatureFreezeFallback';
import { TextField } from '../../components/StyleObjectCards';
import { AskMyRoomModal } from '../../components/looks/AskMyRoomModal';
import {
  LuxuryScreen,
  KScanHeader,
  SectionHeader,
  EmptyStateCard,
  InlineNotice,
  PrimaryButton,
  SecondaryButton,
} from '../../components/luxury';
import { LUXURY, SPACING } from '../../constants/theme';
import { AI_STYLIST_UI_ENABLED } from '../../constants/featureFlags';
import { useFeatureFreeze } from '../../hooks/useFeatureFreeze';
import { useOwnedClosetItems } from '../../hooks/useOwnedClosetItems';
import {
  generateOutfits,
  isGenerationInFlight,
  type OutfitSuggestion,
  type StyleOutfitResult,
} from '../../services/styleOutfits';
import { createLookFromOwnedItems } from '../../services/styleObjects';
import {
  recordAiStylistEvent,
  REJECTION_REASON_LABELS,
  REJECTION_REASONS,
  type RejectionReason,
} from '../../services/styleMemoryEvents';
import {
  FASHION_REASONING_CONTRACT_VERSION,
  STYLE_OUTFIT_PROMPT_VERSION,
  inferGarmentRole,
  isOutfitDressCode,
  isOutfitOccasion,
  type OutfitDressCode,
  type OutfitOccasion,
  type OutfitSetting,
} from '../../types/fashionReasoning';
import { ownedItemKey, type OwnedClosetItem, type OwnedItemRef } from '../../types/ownedClosetItem';

const OCCASIONS: Array<{ value: OutfitOccasion; label: string }> = [
  { value: 'casual', label: 'Casual' },
  { value: 'work', label: 'Work' },
  { value: 'date', label: 'Date' },
  { value: 'event', label: 'Event' },
  { value: 'travel', label: 'Travel' },
  { value: 'other', label: 'Other' },
];

const DRESS_CODES: Array<{ value: OutfitDressCode; label: string }> = [
  { value: 'relaxed', label: 'Relaxed' },
  { value: 'smart_casual', label: 'Smart Casual' },
  { value: 'dressy', label: 'Dressy' },
  { value: 'formal', label: 'Formal' },
];

const SETTINGS: Array<{ value: OutfitSetting; label: string }> = [
  { value: 'indoor', label: 'Indoor' },
  { value: 'outdoor', label: 'Outdoor' },
  { value: 'both', label: 'Both' },
];

const VARIATION_LABELS: Record<string, string> = {
  reliable: 'Reliable',
  elevated: 'Elevated',
  something_different: 'Something Different',
};

function Chips<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T | null;
  onChange: (next: T | null) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.chipSection}>
      <Text style={styles.chipLabel}>{label}</Text>
      <View style={styles.chipWrap}>
        {options.map((option) => {
          const selected = value === option.value;
          return (
            <TouchableOpacity
              key={option.value}
              style={[styles.chip, selected && styles.chipSelected]}
              onPress={() => onChange(selected ? null : option.value)}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`${label}: ${option.label}`}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{option.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

type SwapTarget = {
  suggestion: OutfitSuggestion;
  itemKey: string;
};

type RejectTarget = {
  suggestion: OutfitSuggestion;
};

function StylistContent() {
  const params = useLocalSearchParams<{
    anchorSourceType?: string;
    anchorSourceId?: string;
    occasion?: string;
    dressCode?: string;
    note?: string;
  }>();

  const { items, loading: closetLoading } = useOwnedClosetItems();

  const itemByKey = useMemo(() => {
    const map = new Map<string, OwnedClosetItem>();
    for (const item of items) map.set(ownedItemKey(item), item);
    return map;
  }, [items]);

  const aiEligibleItems = useMemo(() => items.filter((item) => item.aiEligible), [items]);

  // Anchor: from params (Style This entry) or picked in-screen.
  const paramAnchorKey =
    (params.anchorSourceType === 'saved_scan' || params.anchorSourceType === 'inspiration_item') &&
    typeof params.anchorSourceId === 'string' &&
    params.anchorSourceId
      ? `${params.anchorSourceType}:${params.anchorSourceId}`
      : null;

  const [anchorKey, setAnchorKey] = useState<string | null>(paramAnchorKey);
  const [occasion, setOccasion] = useState<OutfitOccasion | null>(
    isOutfitOccasion(params.occasion) ? (params.occasion as OutfitOccasion) : null,
  );
  const [dressCode, setDressCode] = useState<OutfitDressCode | null>(
    isOutfitDressCode(params.dressCode) ? (params.dressCode as OutfitDressCode) : null,
  );
  const [setting, setSetting] = useState<OutfitSetting | null>(null);
  const [note, setNote] = useState(typeof params.note === 'string' ? params.note : '');

  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<StyleOutfitResult | null>(null);
  const [dismissedSuggestionIds, setDismissedSuggestionIds] = useState<string[]>([]);
  const [excludedRefs, setExcludedRefs] = useState<OwnedItemRef[]>([]);
  const [swapTarget, setSwapTarget] = useState<SwapTarget | null>(null);
  const [rejectTarget, setRejectTarget] = useState<RejectTarget | null>(null);
  const [savingSuggestionId, setSavingSuggestionId] = useState<string | null>(null);
  const [savedLookIdBySuggestion, setSavedLookIdBySuggestion] = useState<Record<string, string>>({});
  const [askRoomLookIds, setAskRoomLookIds] = useState<string[] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const generatingRef = useRef(false);

  const anchorItem = anchorKey ? itemByKey.get(anchorKey) ?? null : null;

  const runGenerate = useCallback(
    async (input?: { keepItems?: OwnedItemRef[]; mode?: 'style_item' | 'style_event' | 'restyle_remaining' }) => {
      if (generatingRef.current || isGenerationInFlight()) return; // rapid-tap guard
      generatingRef.current = true;
      setGenerating(true);
      setActionError(null);
      setDismissedSuggestionIds([]);
      setSavedLookIdBySuggestion({});

      try {
        const anchorRef: OwnedItemRef | null =
          anchorItem && anchorItem.sourceId
            ? { sourceType: anchorItem.sourceType, sourceId: anchorItem.sourceId }
            : null;

        const mode = input?.mode ?? (anchorRef ? 'style_item' : 'style_event');
        const response = await generateOutfits({
          mode,
          anchorItem: anchorRef,
          keepItems: input?.keepItems ?? [],
          excludeItems: excludedRefs,
          event: { occasion, dressCode, setting, note },
        });
        setResult(response);

        if (response.status === 'success') {
          for (const suggestion of response.outfits) {
            void recordAiStylistEvent({
              eventType: 'ai_suggestion_viewed',
              signalKey: suggestion.suggestionId,
              payload: { variation: suggestion.variation, occasion: occasion ?? null },
            });
          }
        }
      } finally {
        generatingRef.current = false;
        setGenerating(false);
      }
    },
    [anchorItem, occasion, dressCode, setting, note, excludedRefs],
  );

  // ── Swap actions ─────────────────────────────────────────────────────────────

  const applyLocalSwap = (target: SwapTarget, replacement: OwnedClosetItem) => {
    if (!result || result.status !== 'success' || !replacement.sourceId) return;
    const nextOutfits = result.outfits.map((suggestion) => {
      if (suggestion.suggestionId !== target.suggestion.suggestionId) return suggestion;
      return {
        ...suggestion,
        itemRefs: suggestion.itemRefs.map((ref) =>
          `${ref.sourceType}:${ref.sourceId}` === target.itemKey
            ? { ...ref, sourceType: replacement.sourceType, sourceId: replacement.sourceId as string }
            : ref,
        ),
      };
    });
    setResult({ ...result, outfits: nextOutfits });
    setSavedLookIdBySuggestion((current) => {
      const next = { ...current };
      delete next[target.suggestion.suggestionId]; // edited: needs re-save
      return next;
    });
    void recordAiStylistEvent({
      eventType: 'ai_item_swapped',
      signalKey: `${target.suggestion.suggestionId}:${target.itemKey}`,
      payload: { variation: target.suggestion.variation },
    });
    setSwapTarget(null);
  };

  const handleKeepAndRestyle = (target: SwapTarget) => {
    const [sourceType, sourceId] = target.itemKey.split(':');
    setSwapTarget(null);
    const keep: OwnedItemRef[] = [{ sourceType: sourceType as OwnedItemRef['sourceType'], sourceId }];
    void runGenerate({ keepItems: keep, mode: 'restyle_remaining' });
  };

  const handleExcludeItem = (target: SwapTarget) => {
    const [sourceType, sourceId] = target.itemKey.split(':');
    // Excluding the anchor is an explicit request to replace it: clear anchor.
    if (anchorItem && anchorItem.sourceId === sourceId) {
      setAnchorKey(null);
    }
    // Per-request correction only — never a permanent global rule. The
    // exclusion list lives in screen state and resets when the screen unmounts.
    setExcludedRefs((current) => [
      ...current.filter((ref) => ref.sourceId !== sourceId),
      { sourceType: sourceType as OwnedItemRef['sourceType'], sourceId },
    ]);
    setSwapTarget(null);
    void recordAiStylistEvent({
      eventType: 'ai_suggestion_rejected',
      signalKey: `${target.suggestion.suggestionId}:${target.itemKey}`,
      payload: { reason: 'do_not_use_item', variation: target.suggestion.variation },
    });
  };

  // ── Rejection ────────────────────────────────────────────────────────────────

  const handleReject = (target: RejectTarget, reason: RejectionReason) => {
    setDismissedSuggestionIds((current) => [...current, target.suggestion.suggestionId]);
    setRejectTarget(null);
    void recordAiStylistEvent({
      eventType: 'ai_suggestion_rejected',
      signalKey: target.suggestion.suggestionId,
      payload: {
        reason,
        variation: target.suggestion.variation,
        occasion: occasion ?? null,
      },
    });
  };

  // ── Save as Look / Ask My Room ───────────────────────────────────────────────

  const saveSuggestionAsLook = useCallback(
    async (suggestion: OutfitSuggestion): Promise<string | null> => {
      const existing = savedLookIdBySuggestion[suggestion.suggestionId];
      if (existing) return existing;
      if (savingSuggestionId) return null; // in-flight guard

      setSavingSuggestionId(suggestion.suggestionId);
      setActionError(null);
      try {
        const titleParts = [
          VARIATION_LABELS[suggestion.variation] ?? 'Styled',
          occasion ? OCCASIONS.find((entry) => entry.value === occasion)?.label : null,
        ].filter(Boolean);
        const look = await createLookFromOwnedItems({
          title: `${titleParts.join(' · ')} Look`,
          source: 'ai',
          occasion,
          dressCode,
          setting,
          contextNote: note,
          explanation: suggestion.reason,
          promptVersion: STYLE_OUTFIT_PROMPT_VERSION,
          contractVersion: FASHION_REASONING_CONTRACT_VERSION,
          items: suggestion.itemRefs.map((ref) => ({
            sourceType: ref.sourceType,
            sourceId: ref.sourceId,
            role: ref.role,
          })),
        });
        setSavedLookIdBySuggestion((current) => ({
          ...current,
          [suggestion.suggestionId]: look.id,
        }));
        void recordAiStylistEvent({
          eventType: 'ai_suggestion_saved',
          signalKey: suggestion.suggestionId,
          payload: { variation: suggestion.variation, occasion: occasion ?? null },
        });
        return look.id;
      } catch (err: any) {
        setActionError(err?.message || 'Unable to save this Look. Please try again.');
        return null;
      } finally {
        setSavingSuggestionId(null);
      }
    },
    [savedLookIdBySuggestion, savingSuggestionId, occasion, dressCode, setting, note],
  );

  const handleSaveLook = async (suggestion: OutfitSuggestion) => {
    const lookId = await saveSuggestionAsLook(suggestion);
    if (lookId) router.push(`/looks/${lookId}`);
  };

  const handleAskRoomSingle = async (suggestion: OutfitSuggestion) => {
    const lookId = await saveSuggestionAsLook(suggestion);
    if (lookId) setAskRoomLookIds([lookId]);
  };

  const handleAskRoomAll = async (suggestions: OutfitSuggestion[]) => {
    // Canonical variation order is already enforced by the service.
    const lookIds: string[] = [];
    for (const suggestion of suggestions.slice(0, 3)) {
      const lookId = await saveSuggestionAsLook(suggestion);
      if (!lookId) return; // error already surfaced; drafts preserved
      lookIds.push(lookId);
    }
    if (lookIds.length > 0) setAskRoomLookIds(lookIds);
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  const visibleSuggestions =
    result?.status === 'success'
      ? result.outfits.filter((suggestion) => !dismissedSuggestionIds.includes(suggestion.suggestionId))
      : [];

  const renderSuggestionItem = (
    suggestion: OutfitSuggestion,
    ref: OutfitSuggestion['itemRefs'][number],
  ) => {
    const key = `${ref.sourceType}:${ref.sourceId}`;
    const item = itemByKey.get(key);
    return (
      <View key={key} style={styles.resultItem}>
        {item?.imageUri ? (
          <Image source={{ uri: item.imageUri }} style={styles.resultImage} resizeMode="cover" />
        ) : (
          <View style={[styles.resultImage, styles.imageFallback]}>
            <Text style={styles.imageFallbackText}>{ref.role.slice(0, 1).toUpperCase()}</Text>
          </View>
        )}
        <Text style={styles.resultItemTitle} numberOfLines={1}>
          {item?.title ?? ref.role}
        </Text>
        <TouchableOpacity
          onPress={() => setSwapTarget({ suggestion, itemKey: key })}
          accessibilityRole="button"
          accessibilityLabel={`Swap ${item?.title ?? ref.role}`}
          style={styles.swapLink}
        >
          <Text style={styles.swapLinkText}>SWAP</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <LuxuryScreen safeArea={false} scrollable={false} backgroundColor={LUXURY.colors.ivory}>
      <StatusBar style="dark" />
      <KScanHeader
        title={anchorItem ? 'Style This' : 'Style Me'}
        subtitle="FROM YOUR CLOSET"
        onBack={generating ? undefined : () => router.back()}
        backLabel="Back"
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Anchor */}
        <SectionHeader
          title={anchorItem ? 'Styling around' : 'Start from a piece (optional)'}
          subtitle={anchorItem ? 'This piece stays in every option' : 'Or style your whole closet'}
        />
        {closetLoading ? (
          <ActivityIndicator color={LUXURY.colors.plum} />
        ) : anchorItem ? (
          <View style={styles.anchorRow}>
            {anchorItem.imageUri ? (
              <Image source={{ uri: anchorItem.imageUri }} style={styles.anchorImage} resizeMode="cover" />
            ) : (
              <View style={[styles.anchorImage, styles.imageFallback]}>
                <Text style={styles.imageFallbackText}>{(anchorItem.category ?? '?').slice(0, 1)}</Text>
              </View>
            )}
            <View style={styles.anchorMeta}>
              <Text style={styles.anchorTitle} numberOfLines={1}>{anchorItem.title}</Text>
              {anchorItem.category ? <Text style={styles.anchorSub}>{anchorItem.category}</Text> : null}
            </View>
            <TouchableOpacity
              onPress={() => setAnchorKey(null)}
              disabled={generating}
              accessibilityRole="button"
              accessibilityLabel="Remove anchor item"
              style={styles.anchorClear}
            >
              <Text style={styles.anchorClearText}>✕</Text>
            </TouchableOpacity>
          </View>
        ) : aiEligibleItems.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.anchorPicker}>
            {aiEligibleItems.map((item) => (
              <TouchableOpacity
                key={ownedItemKey(item)}
                onPress={() => setAnchorKey(ownedItemKey(item))}
                disabled={generating}
                accessibilityRole="button"
                accessibilityLabel={`Style this: ${item.title}`}
                style={styles.anchorOption}
              >
                {item.imageUri ? (
                  <Image source={{ uri: item.imageUri }} style={styles.anchorOptionImage} resizeMode="cover" />
                ) : (
                  <View style={[styles.anchorOptionImage, styles.imageFallback]}>
                    <Text style={styles.imageFallbackText}>{(item.category ?? '?').slice(0, 1)}</Text>
                  </View>
                )}
                <Text style={styles.anchorOptionTitle} numberOfLines={1}>{item.title}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        ) : (
          <EmptyStateCard
            title="No AI-ready pieces yet"
            subtitle="Scan clothing to your Closet first — the stylist works from pieces with garment details."
          />
        )}

        {/* Event context */}
        <SectionHeader title="What are you dressing for?" subtitle="All optional" />
        <Chips
          label="OCCASION"
          options={OCCASIONS}
          value={occasion}
          onChange={(next) => setOccasion(next)}
          disabled={generating}
        />
        <Chips
          label="DRESS CODE"
          options={DRESS_CODES}
          value={dressCode}
          onChange={(next) => setDressCode(next)}
          disabled={generating}
        />
        <Chips
          label="SETTING"
          options={SETTINGS}
          value={setting}
          onChange={(next) => setSetting(next)}
          disabled={generating}
        />
        <TextField label="Note (optional)" value={note} onChangeText={setNote} multiline />

        <PrimaryButton
          title={generating ? 'Styling' : anchorItem ? 'Style This' : 'Style Me'}
          onPress={() => void runGenerate()}
          disabled={generating || closetLoading}
          accessibilityLabel="Generate outfit options"
          testID="generate-outfits-button"
        />
        <SecondaryButton
          title="Build My Own"
          onPress={() => router.push('/looks/create')}
          disabled={generating}
          accessibilityLabel="Build a look manually"
        />

        {/* Results */}
        {generating ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="large" color={LUXURY.colors.plum} />
            <Text style={styles.loadingText}>Styling from your closet…</Text>
          </View>
        ) : null}

        {!generating && result && result.status !== 'success' ? (
          <InlineNotice
            variant={result.status === 'no_result' ? 'info' : 'error'}
            title={result.status === 'no_result' ? 'Not enough to work with yet' : 'AI Stylist'}
            body={'message' in result ? result.message : ''}
          />
        ) : null}

        {actionError ? <InlineNotice variant="error" title="Something went wrong" body={actionError} /> : null}

        {!generating && visibleSuggestions.length > 0 ? (
          <>
            <SectionHeader
              title="Your options"
              subtitle={`${visibleSuggestions.length} option${visibleSuggestions.length === 1 ? '' : 's'} from your closet`}
            />
            {visibleSuggestions.map((suggestion) => (
              <View key={suggestion.suggestionId} style={styles.resultCard} testID="outfit-result-card">
                <Text style={styles.variationLabel}>
                  {VARIATION_LABELS[suggestion.variation] ?? suggestion.variation}
                </Text>
                <View style={styles.resultItems}>
                  {suggestion.itemRefs.map((ref) => renderSuggestionItem(suggestion, ref))}
                </View>
                <View style={styles.whyCard}>
                  <Text style={styles.whyLabel}>WHY IT WORKS</Text>
                  <Text style={styles.whyText}>{suggestion.reason}</Text>
                </View>
                <View style={styles.resultActions}>
                  <SecondaryButton
                    title="Not for Me"
                    onPress={() => setRejectTarget({ suggestion })}
                    accessibilityLabel="Not for me"
                  />
                  <SecondaryButton
                    title={savingSuggestionId === suggestion.suggestionId ? 'Saving' : 'Save Look'}
                    onPress={() => void handleSaveLook(suggestion)}
                    disabled={savingSuggestionId !== null}
                    accessibilityLabel="Save this suggestion as a look"
                    testID="save-suggestion-button"
                  />
                  <SecondaryButton
                    title="Ask My Room"
                    onPress={() => void handleAskRoomSingle(suggestion)}
                    disabled={savingSuggestionId !== null}
                    accessibilityLabel="Ask my room about this option"
                  />
                </View>
              </View>
            ))}
            {visibleSuggestions.length >= 2 ? (
              <PrimaryButton
                title="Ask My Room · All Options"
                onPress={() => void handleAskRoomAll(visibleSuggestions)}
                disabled={savingSuggestionId !== null}
                accessibilityLabel="Share all options to a room vote"
                testID="ask-room-all-button"
              />
            ) : null}
          </>
        ) : null}
      </ScrollView>

      {/* Swap sheet */}
      <Modal
        visible={swapTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setSwapTarget(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Swap this piece</Text>
            {swapTarget ? (
              <>
                <SecondaryButton
                  title="Keep this item, restyle the rest"
                  onPress={() => handleKeepAndRestyle(swapTarget)}
                  accessibilityLabel="Keep this item and restyle the rest"
                />
                <SecondaryButton
                  title="Don't use this item"
                  onPress={() => handleExcludeItem(swapTarget)}
                  accessibilityLabel="Do not use this item for this request"
                />
                <Text style={styles.modalSectionLabel}>OR SWAP IN</Text>
                <ScrollView style={styles.swapList} showsVerticalScrollIndicator={false}>
                  {aiEligibleItems
                    .filter((item) => {
                      const key = ownedItemKey(item);
                      if (key === swapTarget.itemKey) return false;
                      const currentKeys = new Set(
                        swapTarget.suggestion.itemRefs.map((ref) => `${ref.sourceType}:${ref.sourceId}`),
                      );
                      if (currentKeys.has(key)) return false;
                      const swappedRef = swapTarget.suggestion.itemRefs.find(
                        (ref) => `${ref.sourceType}:${ref.sourceId}` === swapTarget.itemKey,
                      );
                      // Same-role replacements keep the outfit structure valid.
                      return swappedRef
                        ? inferGarmentRole(item.category, item.subcategory) === swappedRef.role
                        : true;
                    })
                    .map((item) => (
                      <TouchableOpacity
                        key={ownedItemKey(item)}
                        style={styles.swapRow}
                        onPress={() => applyLocalSwap(swapTarget, item)}
                        accessibilityRole="button"
                        accessibilityLabel={`Swap in ${item.title}`}
                      >
                        {item.imageUri ? (
                          <Image source={{ uri: item.imageUri }} style={styles.swapThumb} resizeMode="cover" />
                        ) : (
                          <View style={[styles.swapThumb, styles.imageFallback]}>
                            <Text style={styles.imageFallbackText}>{(item.category ?? '?').slice(0, 1)}</Text>
                          </View>
                        )}
                        <Text style={styles.swapRowTitle} numberOfLines={1}>{item.title}</Text>
                      </TouchableOpacity>
                    ))}
                </ScrollView>
              </>
            ) : null}
            <SecondaryButton title="Cancel" onPress={() => setSwapTarget(null)} />
          </View>
        </View>
      </Modal>

      {/* Rejection reasons */}
      <Modal
        visible={rejectTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setRejectTarget(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Not for me because…</Text>
            {REJECTION_REASONS.filter((reason) => reason !== 'do_not_use_item').map((reason) => (
              <SecondaryButton
                key={reason}
                title={REJECTION_REASON_LABELS[reason]}
                onPress={() => rejectTarget && handleReject(rejectTarget, reason)}
                accessibilityLabel={`Reject: ${REJECTION_REASON_LABELS[reason]}`}
              />
            ))}
            <SecondaryButton title="Cancel" onPress={() => setRejectTarget(null)} />
          </View>
        </View>
      </Modal>

      {askRoomLookIds ? (
        <AskMyRoomModal
          visible
          lookIds={askRoomLookIds}
          onClose={() => setAskRoomLookIds(null)}
          onShared={({ roomId }) => {
            setAskRoomLookIds(null);
            router.push(`/dressing-rooms/${roomId}`);
          }}
        />
      ) : null}
    </LuxuryScreen>
  );
}

export default function StylistScreen() {
  const { isFeatureEnabled, isLoading } = useFeatureFreeze();
  if (isLoading) {
    return <FeatureFreezeFallback cta="closet" loading />;
  }
  if (!AI_STYLIST_UI_ENABLED || !isFeatureEnabled('aiStylist')) {
    return <FeatureFreezeFallback cta="closet" />;
  }
  return <StylistContent />;
}

const styles = StyleSheet.create({
  scrollView: { flex: 1 },
  scrollContent: {
    padding: SPACING.xl,
    paddingBottom: SPACING.xxxl,
    gap: SPACING.lg,
  },
  loadingWrap: {
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.lg,
  },
  loadingText: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
  },
  anchorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: LUXURY.colors.plum,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.sm,
  },
  anchorImage: {
    width: 64,
    height: 64,
    borderRadius: 12,
    backgroundColor: LUXURY.colors.ivory,
  },
  anchorMeta: { flex: 1, gap: 2 },
  anchorTitle: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
  },
  anchorSub: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
  },
  anchorClear: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  anchorClearText: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.graphite,
  },
  anchorPicker: {
    gap: SPACING.sm,
  },
  anchorOption: {
    width: 88,
    gap: SPACING.xs,
  },
  anchorOptionImage: {
    width: 88,
    height: 104,
    borderRadius: 12,
    backgroundColor: LUXURY.colors.pearl,
  },
  anchorOptionTitle: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
  },
  imageFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.ivory,
  },
  imageFallbackText: {
    ...LUXURY.typography.displayTitle,
    color: LUXURY.colors.goldBrushed,
  },
  chipSection: { gap: SPACING.sm },
  chipLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    letterSpacing: 2.2,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  chip: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  chipSelected: {
    borderColor: LUXURY.colors.plum,
    backgroundColor: LUXURY.colors.plum,
  },
  chipText: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.graphite,
  },
  chipTextSelected: {
    color: LUXURY.colors.pearl,
  },
  resultCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.lg,
    gap: SPACING.md,
  },
  variationLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    letterSpacing: 2.2,
  },
  resultItems: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  resultItem: {
    width: 88,
    gap: 2,
  },
  resultImage: {
    width: 88,
    height: 104,
    borderRadius: 12,
    backgroundColor: LUXURY.colors.ivory,
  },
  resultItemTitle: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
  },
  swapLink: {
    alignSelf: 'flex-start',
  },
  swapLinkText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    letterSpacing: 1.4,
  },
  whyCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.ivory,
    padding: SPACING.md,
    gap: SPACING.xs,
  },
  whyLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    letterSpacing: 2.2,
  },
  whyText: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
  },
  resultActions: {
    gap: SPACING.sm,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: LUXURY.colors.plumDeep + 'C2',
    padding: SPACING.xl,
  },
  modalCard: {
    borderRadius: LUXURY.cards.screen.borderRadius,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.xl,
    gap: SPACING.sm,
    maxHeight: '80%',
    ...LUXURY.cards.screen.shadow,
  },
  modalTitle: {
    ...LUXURY.typography.displayTitle,
    color: LUXURY.colors.ink,
  },
  modalSectionLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    letterSpacing: 2.2,
    marginTop: SPACING.sm,
  },
  swapList: {
    flexGrow: 0,
    maxHeight: 220,
  },
  swapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  swapThumb: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: LUXURY.colors.ivory,
  },
  swapRowTitle: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.ink,
    flex: 1,
  },
});
