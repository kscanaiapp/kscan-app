// Manual Look builder (AI Stylist expansion).
//
// Select 2–6 owned closet items, order them, add optional context, and save
// atomically through create_look_from_owned_items. Also serves as the editor
// for owned-item Looks (?lookId=…) via update_look_owned_items.
//
// Save behavior (Part 8): save disabled below two items, selection blocked
// above six, duplicates impossible (selection is a keyed set), one in-flight
// guard, draft preserved on error, navigation blocked while saving, navigate
// to the saved Look on success. Local-only scans are cloud-synced through the
// existing saved-scan path before persistence; a sync failure keeps the draft
// and shows a concise recoverable error.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
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
import {
  LuxuryScreen,
  KScanHeader,
  SectionHeader,
  EmptyStateCard,
  InlineNotice,
  PrimaryButton,
} from '../../components/luxury';
import { LUXURY, SPACING } from '../../constants/theme';
import { AI_STYLIST_UI_ENABLED } from '../../constants/featureFlags';
import { useFeatureFreeze } from '../../hooks/useFeatureFreeze';
import { useOwnedClosetItems } from '../../hooks/useOwnedClosetItems';
import {
  createLookFromOwnedItems,
  getLookDetail,
  updateLookOwnedItems,
  LOOK_MAX_ITEMS,
  LOOK_MIN_ITEMS,
  type OwnedLookItemInput,
} from '../../services/styleObjects';
import {
  ensureRemoteBackedOwnedItem,
  OwnedItemSyncError,
} from '../../services/ownedClosetItems';
import { recordAiStylistEvent } from '../../services/styleMemoryEvents';
import { inferGarmentRole } from '../../types/fashionReasoning';
import { ownedItemKey, type OwnedClosetItem } from '../../types/ownedClosetItem';
import type { SavedScanModel } from '../../services/savedScansCloud';

const OCCASIONS = [
  { value: 'casual', label: 'Casual' },
  { value: 'work', label: 'Work' },
  { value: 'date', label: 'Date' },
  { value: 'event', label: 'Event' },
  { value: 'travel', label: 'Travel' },
  { value: 'other', label: 'Other' },
] as const;

const DRESS_CODES = [
  { value: 'relaxed', label: 'Relaxed' },
  { value: 'smart_casual', label: 'Smart Casual' },
  { value: 'dressy', label: 'Dressy' },
  { value: 'formal', label: 'Formal' },
] as const;

const SETTINGS = [
  { value: 'indoor', label: 'Indoor' },
  { value: 'outdoor', label: 'Outdoor' },
  { value: 'both', label: 'Both' },
] as const;

function OptionChips({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string | null;
  onChange: (next: string | null) => void;
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

function SelectedItemRow({
  item,
  index,
  count,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  item: OwnedClosetItem;
  index: number;
  count: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  return (
    <View style={styles.selectedRow}>
      {item.imageUri ? (
        <Image source={{ uri: item.imageUri }} style={styles.selectedThumb} resizeMode="cover" />
      ) : (
        <View style={[styles.selectedThumb, styles.thumbFallback]}>
          <Text style={styles.thumbFallbackText}>{(item.category || item.title || '?').slice(0, 1)}</Text>
        </View>
      )}
      <View style={styles.selectedMeta}>
        <Text style={styles.selectedTitle} numberOfLines={1}>
          {index + 1}. {item.title}
        </Text>
        {item.category ? <Text style={styles.selectedSub} numberOfLines={1}>{item.category}</Text> : null}
      </View>
      <View style={styles.moveControls}>
        <TouchableOpacity
          onPress={onMoveUp}
          disabled={index === 0}
          accessibilityRole="button"
          accessibilityLabel={`Move ${item.title} up`}
          style={[styles.moveButton, index === 0 && styles.moveButtonDisabled]}
        >
          <Text style={styles.moveButtonText}>↑</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onMoveDown}
          disabled={index === count - 1}
          accessibilityRole="button"
          accessibilityLabel={`Move ${item.title} down`}
          style={[styles.moveButton, index === count - 1 && styles.moveButtonDisabled]}
        >
          <Text style={styles.moveButtonText}>↓</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onRemove}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${item.title}`}
          style={styles.moveButton}
        >
          <Text style={styles.moveButtonText}>✕</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function CreateLookContent() {
  const { lookId } = useLocalSearchParams<{ lookId?: string }>();
  const editingLookId = typeof lookId === 'string' && lookId ? lookId : null;

  const { items, loading, error, localScans } = useOwnedClosetItems();
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [occasion, setOccasion] = useState<string | null>(null);
  const [dressCode, setDressCode] = useState<string | null>(null);
  const [setting, setSetting] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editPrefillDone, setEditPrefillDone] = useState(false);
  const savingRef = useRef(false);

  const itemByKey = useMemo(() => {
    const map = new Map<string, OwnedClosetItem>();
    for (const item of items) map.set(ownedItemKey(item), item);
    return map;
  }, [items]);

  // Edit mode: prefill metadata and current items once the closet is loaded.
  useEffect(() => {
    if (!editingLookId || editPrefillDone || loading) return;
    let cancelled = false;
    (async () => {
      try {
        const detail = await getLookDetail(editingLookId);
        if (cancelled) return;
        setTitle(detail.look.title ?? '');
        setOccasion(detail.look.occasion ?? null);
        setDressCode(detail.look.dressCode ?? null);
        setSetting(detail.look.setting ?? null);
        setNote(detail.look.contextNote ?? '');
        const keys: string[] = [];
        for (const lookItem of detail.items) {
          const sourceId = lookItem.sourceSavedScanId || lookItem.sourceInspirationItemId;
          const sourceType = lookItem.sourceSavedScanId
            ? 'saved_scan'
            : lookItem.sourceInspirationItemId
              ? 'inspiration_item'
              : null;
          if (sourceType && sourceId) {
            const key = `${sourceType}:${sourceId}`;
            if (itemByKey.has(key)) keys.push(key);
          }
        }
        setSelectedKeys(keys);
      } catch {
        if (!cancelled) setSaveError('Unable to load this Look for editing.');
      } finally {
        if (!cancelled) setEditPrefillDone(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editingLookId, editPrefillDone, loading, itemByKey]);

  const selectedItems = selectedKeys
    .map((key) => itemByKey.get(key))
    .filter((item): item is OwnedClosetItem => !!item);

  const toggleSelect = (item: OwnedClosetItem) => {
    if (saving) return;
    const key = ownedItemKey(item);
    setSelectedKeys((current) => {
      if (current.includes(key)) return current.filter((entry) => entry !== key);
      if (current.length >= LOOK_MAX_ITEMS) return current; // block above six
      return [...current, key];
    });
  };

  const moveSelected = (index: number, delta: number) => {
    setSelectedKeys((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
  };

  const canSave = !saving && title.trim().length > 0 && selectedItems.length >= LOOK_MIN_ITEMS;

  const handleSave = useCallback(async () => {
    if (savingRef.current) return; // in-flight guard against rapid taps
    if (selectedItems.length < LOOK_MIN_ITEMS || !title.trim()) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);

    try {
      // Remote-back any local-only scans through the existing cloud-sync path.
      const resolvedItems: OwnedLookItemInput[] = [];
      for (const item of selectedItems) {
        let resolved = item;
        if (!item.remoteBacked || !item.sourceId) {
          const localScan = ((localScans ?? []) as unknown as SavedScanModel[]).find(
            (scan) => scan.id === item.localId,
          );
          resolved = await ensureRemoteBackedOwnedItem(item, { localScan });
        }
        if (!resolved.sourceId) throw new OwnedItemSyncError();
        resolvedItems.push({
          sourceType: resolved.sourceType,
          sourceId: resolved.sourceId,
          role: inferGarmentRole(resolved.category, resolved.subcategory),
        });
      }

      const wasAiLookEdit = editingLookId != null;
      const saved = editingLookId
        ? await updateLookOwnedItems({
            lookId: editingLookId,
            title,
            occasion,
            dressCode,
            setting,
            contextNote: note,
            items: resolvedItems,
          })
        : await createLookFromOwnedItems({
            title,
            source: 'manual',
            occasion,
            dressCode,
            setting,
            contextNote: note,
            items: resolvedItems,
          });

      if (wasAiLookEdit && saved.source === 'ai') {
        void recordAiStylistEvent({
          eventType: 'ai_look_edited',
          signalKey: saved.id,
          payload: { occasion: saved.occasion ?? null },
        });
      }

      router.replace(`/looks/${saved.id}`);
    } catch (err: any) {
      // Draft state (selection, title, context) is intentionally preserved.
      setSaveError(err?.message || 'Unable to save this Look. Please try again.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [selectedItems, title, occasion, dressCode, setting, note, editingLookId, localScans]);

  return (
    <LuxuryScreen safeArea={false} scrollable={false} backgroundColor={LUXURY.colors.ivory}>
      <StatusBar style="dark" />
      <KScanHeader
        title={editingLookId ? 'Edit Look' : 'Create a Look'}
        subtitle="FROM YOUR CLOSET"
        onBack={saving ? undefined : () => router.back()}
        backLabel="Back"
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <SectionHeader
          title="Your pieces"
          subtitle={`Select ${LOOK_MIN_ITEMS}–${LOOK_MAX_ITEMS} items · ${selectedItems.length} selected`}
        />

        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="large" color={LUXURY.colors.plum} />
          </View>
        ) : error ? (
          <InlineNotice variant="error" title="Unable to load closet" body={error} />
        ) : items.length === 0 ? (
          <EmptyStateCard
            title="Nothing in your closet yet"
            subtitle="Scan or upload pieces first, then build outfits from what you own."
          />
        ) : (
          <View style={styles.pickerGrid}>
            {items.map((item) => {
              const key = ownedItemKey(item);
              const selectedIndex = selectedKeys.indexOf(key);
              const selected = selectedIndex >= 0;
              const blocked = !selected && selectedKeys.length >= LOOK_MAX_ITEMS;
              return (
                <TouchableOpacity
                  key={key}
                  style={[styles.pickTile, selected && styles.pickTileSelected, blocked && styles.pickTileBlocked]}
                  onPress={() => toggleSelect(item)}
                  disabled={blocked || saving}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${selected ? 'Remove' : 'Add'} ${item.title}`}
                  testID="look-builder-item"
                >
                  {item.imageUri ? (
                    <Image source={{ uri: item.imageUri }} style={styles.pickImage} resizeMode="cover" />
                  ) : (
                    <View style={[styles.pickImage, styles.thumbFallback]}>
                      <Text style={styles.thumbFallbackText}>
                        {(item.category || item.title || '?').slice(0, 1)}
                      </Text>
                    </View>
                  )}
                  {selected ? (
                    <View style={styles.pickBadge}>
                      <Text style={styles.pickBadgeText}>{selectedIndex + 1}</Text>
                    </View>
                  ) : null}
                  <Text style={styles.pickTitle} numberOfLines={1}>
                    {item.title}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {selectedItems.length > 0 ? (
          <>
            <SectionHeader title="Outfit preview" subtitle="Order sets how the Look reads" />
            <View style={styles.selectedList}>
              {selectedItems.map((item, index) => (
                <SelectedItemRow
                  key={ownedItemKey(item)}
                  item={item}
                  index={index}
                  count={selectedItems.length}
                  onMoveUp={() => moveSelected(index, -1)}
                  onMoveDown={() => moveSelected(index, 1)}
                  onRemove={() => toggleSelect(item)}
                />
              ))}
            </View>
          </>
        ) : null}

        <SectionHeader title="Details" subtitle="Only a name is required" />
        <TextField label="Look name" value={title} onChangeText={setTitle} />
        <OptionChips label="OCCASION" options={OCCASIONS} value={occasion} onChange={setOccasion} />
        <OptionChips label="DRESS CODE" options={DRESS_CODES} value={dressCode} onChange={setDressCode} />
        <OptionChips label="SETTING" options={SETTINGS} value={setting} onChange={setSetting} />
        <TextField label="Note (optional)" value={note} onChangeText={setNote} multiline />

        {saveError ? <InlineNotice variant="error" title="Could not save" body={saveError} /> : null}

        <PrimaryButton
          title={saving ? 'Saving' : editingLookId ? 'Save Changes' : 'Save Look'}
          onPress={handleSave}
          disabled={!canSave}
          accessibilityLabel={editingLookId ? 'Save look changes' : 'Save look'}
          testID="save-look-button"
        />
        {selectedItems.length < LOOK_MIN_ITEMS ? (
          <Text style={styles.saveHint}>Select at least {LOOK_MIN_ITEMS} items to save.</Text>
        ) : null}
      </ScrollView>
    </LuxuryScreen>
  );
}

export default function CreateLookScreen() {
  const { isFeatureEnabled, isLoading } = useFeatureFreeze();
  if (isLoading) {
    return <FeatureFreezeFallback cta="closet" loading />;
  }
  if (!AI_STYLIST_UI_ENABLED || !isFeatureEnabled('aiStylist') || !isFeatureEnabled('outfitRemixLooks')) {
    return <FeatureFreezeFallback cta="closet" />;
  }
  return <CreateLookContent />;
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
    paddingVertical: SPACING.xl,
  },
  pickerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.md,
  },
  pickTile: {
    width: '30%',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.xs,
    gap: SPACING.xs,
  },
  pickTileSelected: {
    borderColor: LUXURY.colors.plum,
    borderWidth: 2,
  },
  pickTileBlocked: {
    opacity: 0.45,
  },
  pickImage: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 10,
    backgroundColor: LUXURY.colors.ivory,
  },
  pickBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: LUXURY.colors.plum,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  pickBadgeText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.pearl,
  },
  pickTitle: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
  },
  thumbFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: LUXURY.colors.ivory,
  },
  thumbFallbackText: {
    ...LUXURY.typography.displayTitle,
    color: LUXURY.colors.goldBrushed,
  },
  selectedList: {
    gap: SPACING.sm,
  },
  selectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.sm,
  },
  selectedThumb: {
    width: 48,
    height: 48,
    borderRadius: 10,
    backgroundColor: LUXURY.colors.ivory,
  },
  selectedMeta: { flex: 1, gap: 2 },
  selectedTitle: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
  },
  selectedSub: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
  },
  moveControls: {
    flexDirection: 'row',
    gap: SPACING.xs,
  },
  moveButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: LUXURY.colors.ivory,
  },
  moveButtonDisabled: { opacity: 0.35 },
  moveButtonText: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.graphite,
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
  saveHint: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
    textAlign: 'center',
  },
});
