// K+ Packing Intelligence V1 — the visual plan.
//
// THE POINT OF THIS SCREEN IS THE EVIDENCE, NOT THE PROSE. What must land in
// the first second is "those are actually my clothes": the summary numbers, then
// the traveller's own photographs, then the looks built from them. Elise's
// sentence is one line above it, not a wall of text the cards hang off.
//
// EVERY IMAGE COMES FROM THE DEVICE. The plan carries identity (the cloud id
// plus the local `clientId`); the picture is looked up in the local Closet by
// that id. No Closet imagery is ever sent to the model, and a card with no
// local photo degrades to a typographic tile rather than a broken image.
//
// A GAP IS NEVER STYLED LIKE SOMETHING OWNED. The POSSIBLE GAPS section has no
// photograph, no card chrome, nothing to tap and no price -- a thing the
// traveller does not have must never be able to read as a thing they do. The
// general-mode guide uses the same unowned treatment for the same reason.

import React, { useMemo } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { SectionHeader } from '../luxury';
import {
  PACKING_ACTIVITY_LABELS,
  type PackingGeneralGuide,
  type PackingPlan,
  type PackingPlanItem,
} from '../../types/packing';

export interface PackingImageLookup {
  /** Local Closet id (== the plan item's clientId) -> a renderable image uri. */
  (clientId: string | null): string | null;
}

/**
 * Layering role -> the section a traveller actually thinks in (UX-2).
 *
 * The role vocabulary is the Closet's own (inferLayeringRole); this only names
 * it for a human. Ordered the way a suitcase is packed, not alphabetically.
 * Anything unrecognised falls to "Other" rather than being dropped -- a packed
 * item must always appear in exactly one section.
 */
const ROLE_SECTIONS: Array<{ role: string; label: string }> = [
  { role: 'one_piece', label: 'DRESSES & JUMPSUITS' },
  { role: 'base', label: 'TOPS' },
  { role: 'mid', label: 'MID LAYERS' },
  { role: 'outer', label: 'OUTERWEAR' },
  { role: 'bottom', label: 'BOTTOMS' },
  { role: 'shoe', label: 'SHOES' },
  { role: 'accessory', label: 'ACCESSORIES' },
];

interface PackingChecklistSection {
  key: string;
  label: string;
  items: PackingPlanItem[];
}

/** Group the packed items into suitcase sections, preserving plan order within each. */
function groupByRole(items: PackingPlanItem[]): PackingChecklistSection[] {
  const sections: PackingChecklistSection[] = [];
  const claimed = new Set<string>();
  for (const { role, label } of ROLE_SECTIONS) {
    const matching = items.filter((item) => item.layeringRole === role);
    if (matching.length === 0) continue;
    for (const item of matching) claimed.add(item.itemId);
    sections.push({ key: role, label, items: matching });
  }
  const rest = items.filter((item) => !claimed.has(item.itemId));
  if (rest.length > 0) sections.push({ key: 'other', label: 'OTHER', items: rest });
  return sections;
}

function formatDateRange(startDate: string, endDate: string): string {
  const format = (iso: string): string => {
    const parsed = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return iso;
    return parsed.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  };
  return `${format(startDate)} – ${format(endDate)}`.toUpperCase();
}

/**
 * PK-002. The forecast is named for the place the GEOCODER chose, not the string
 * the traveller typed.
 *
 * `count=1` means one candidate comes back and is used silently: "Springfield"
 * is Missouri, "Portland" is Oregon, and "Georgia" is the country, not the
 * state. Showing only what the traveller typed above a confident forecast made
 * a wrong city undetectable while it drove real garment choices. Naming the
 * resolved place is the whole correction -- the traveller can now see that the
 * forecast is for somewhere else and retype the destination.
 */
function weatherLine(plan: PackingPlan): string {
  const at = plan.weather.resolvedLocation ? ` for ${plan.weather.resolvedLocation}` : '';
  switch (plan.weather.provenance) {
    case 'FORECAST':
      // Only this branch may use the word "forecast".
      return `Forecast${at}: ${plan.weather.summary ?? 'unavailable'}`;
    case 'SEASONAL':
      return `Typical conditions${at}: ${plan.weather.summary ?? 'unavailable'}`;
    default:
      return 'Weather unavailable — planned from your trip and occasions';
  }
}

function itemSubtitle(item: PackingPlanItem): string | null {
  const parts = [item.primaryColor, item.subtype ?? item.category].filter(
    (part): part is string => Boolean(part),
  );
  if (parts.length === 0) return null;
  // Do not repeat a word the title already says.
  const title = item.title.toLowerCase();
  const kept = parts.filter((part) => !title.includes(part.toLowerCase()));
  return kept.length > 0 ? kept.join(' · ') : null;
}

function ClosetItemCard({
  item,
  imageUri,
  onRemove,
  compact,
}: {
  item: PackingPlanItem;
  imageUri: string | null;
  onRemove?: (itemId: string) => void;
  compact?: boolean;
}) {
  const subtitle = itemSubtitle(item);
  return (
    <View
      style={[styles.itemCard, compact && styles.itemCardCompact]}
      testID={`packing-item-${item.itemId}`}
    >
      <View style={[styles.itemThumb, compact && styles.itemThumbCompact]}>
        {imageUri ? (
          <Image source={{ uri: imageUri }} style={styles.itemImage} resizeMode="cover" />
        ) : (
          // No invented placeholder garment: the initial of the item the
          // traveller actually named, on a plain tile.
          <Text style={styles.itemFallback}>{item.title.slice(0, 1).toUpperCase()}</Text>
        )}
      </View>
      <Text style={styles.itemTitle} numberOfLines={2}>
        {item.title}
      </Text>
      {subtitle ? (
        <Text style={styles.itemSubtitle} numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
      {!compact && item.scarcitySignal ? (
        // A Closet fact the server counted, not a compliment the model paid.
        <Text style={styles.itemScarcity}>{item.scarcitySignal}</Text>
      ) : null}
      {!compact && item.usedInOutfits > 1 ? (
        // Derived from the rendered plan, never claimed by the model.
        <Text style={styles.itemReuse}>{`Works across ${item.usedInOutfits} looks`}</Text>
      ) : null}
      {!compact && item.reason ? (
        <Text style={styles.itemReason} numberOfLines={2}>
          {item.reason}
        </Text>
      ) : null}
      {!compact && onRemove ? (
        <Pressable
          onPress={() => onRemove(item.itemId)}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${item.title} from this trip`}
          testID={`packing-remove-${item.itemId}`}
          style={styles.removeButton}
        >
          <Text style={styles.removeLabel}>REMOVE</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * One checklist row (UX-2).
 *
 * LOCAL ONLY. Ticking this marks the traveller's own suitcase. It calls nothing,
 * writes nothing to user_closet_items, and cannot add, remove or alter an owned
 * item -- ownership is not something a checkbox may change. The tick lives in
 * actor-scoped state and is mirrored to the device cache so it survives a
 * restart; it never leaves the phone.
 *
 * React.memo because a plan can carry 24 rows and every tick re-renders the
 * list; without it each tap would re-render every row. The comparator is
 * explicit about the only three things that can change a row.
 */
const PackingChecklistRow = React.memo(
  function PackingChecklistRow({
    item,
    imageUri,
    checked,
    onToggle,
  }: {
    item: PackingPlanItem;
    imageUri: string | null;
    checked: boolean;
    onToggle?: (itemId: string) => void;
  }) {
    const subtitle = itemSubtitle(item);
    return (
      <Pressable
        onPress={onToggle ? () => onToggle(item.itemId) : undefined}
        disabled={!onToggle}
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        // Names the garment and its evidence, so the row is not "checkbox" to a
        // screen reader. "In your Closet" is a fact the server proved.
        accessibilityLabel={`${item.title}${subtitle ? `, ${subtitle}` : ''}, in your Closet`}
        accessibilityHint={checked ? 'Double tap to mark as not packed' : 'Double tap to mark as packed'}
        testID={`packing-check-${item.itemId}`}
        style={[styles.checkRow, checked && styles.checkRowDone]}
      >
        <View style={[styles.checkBox, checked && styles.checkBoxChecked]}>
          {checked ? <Text style={styles.checkMark}>✓</Text> : null}
        </View>
        <View style={styles.checkThumb}>
          {imageUri ? (
            <Image source={{ uri: imageUri }} style={styles.itemImage} resizeMode="cover" />
          ) : (
            <Text style={styles.itemFallback}>{item.title.slice(0, 1).toUpperCase()}</Text>
          )}
        </View>
        <View style={styles.checkBody}>
          <Text style={[styles.checkTitle, checked && styles.checkTitleDone]} numberOfLines={1}>
            {item.title}
          </Text>
          {subtitle ? (
            <Text style={styles.checkSubtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
          <View style={styles.badgeRow}>
            {/* UX-3. Every item here was resolved by the server against this
                actor's own user_closet_items row, so the badge states evidence
                rather than decorating. A gap can never render this treatment --
                gaps have their own section, no photograph and nothing to tap. */}
            <Text style={styles.ownedBadge}>IN YOUR CLOSET</Text>
            {item.scarcitySignal ? (
              <Text style={styles.scarcityBadge}>{item.scarcitySignal}</Text>
            ) : null}
            {item.usedInOutfits > 1 ? (
              <Text style={styles.reuseBadge}>{`${item.usedInOutfits} LOOKS`}</Text>
            ) : null}
          </View>
        </View>
      </Pressable>
    );
  },
  (prev, next) =>
    prev.checked === next.checked &&
    prev.item === next.item &&
    prev.imageUri === next.imageUri &&
    prev.onToggle === next.onToggle,
);

export function PackingPlanView({
  plan,
  message,
  resolveImage,
  onRemoveItem,
  busy,
  packedOff,
  onToggleItemPacked,
}: {
  plan: PackingPlan;
  message: string | null;
  resolveImage: PackingImageLookup;
  onRemoveItem?: (itemId: string) => void;
  busy?: boolean;
  /** Item ids the traveller has ticked off. Device-local. */
  packedOff?: string[];
  onToggleItemPacked?: (itemId: string) => void;
}) {
  const itemsById = useMemo(() => {
    const map = new Map<string, PackingPlanItem>();
    for (const item of plan.packedItems) map.set(item.itemId, item);
    return map;
  }, [plan.packedItems]);

  const sections = useMemo(() => groupByRole(plan.packedItems), [plan.packedItems]);
  const checked = useMemo(() => new Set(packedOff ?? []), [packedOff]);
  // Counted from the items actually rendered, so the header can never claim a
  // tick for an item this plan does not contain.
  const checkedCount = plan.packedItems.filter((item) => checked.has(item.itemId)).length;

  return (
    <View testID="packing-plan">
      <Text style={styles.destination}>{plan.trip.destination.toUpperCase()}</Text>
      <Text style={styles.dates}>{formatDateRange(plan.trip.startDate, plan.trip.endDate)}</Text>
      <Text style={styles.weather} testID="packing-weather">
        {weatherLine(plan)}
      </Text>

      <View style={styles.summaryRow} testID="packing-summary">
        <SummaryStat value={plan.counts.items} label={plan.counts.items === 1 ? 'ITEM' : 'ITEMS'} />
        <SummaryStat
          value={plan.counts.outfits}
          label={plan.counts.outfits === 1 ? 'LOOK' : 'LOOKS'}
        />
        <SummaryStat
          value={plan.counts.shoes}
          label={plan.counts.shoes === 1 ? 'PAIR OF SHOES' : 'PAIRS OF SHOES'}
        />
        {plan.counts.gaps > 0 ? (
          <SummaryStat
            value={plan.counts.gaps}
            label={plan.counts.gaps === 1 ? 'POSSIBLE GAP' : 'POSSIBLE GAPS'}
          />
        ) : null}
      </View>

      {message ? (
        <Text style={styles.eliseLine} testID="packing-message">
          {message}
        </Text>
      ) : null}

      <SectionHeader title="PACK" />
      {/* UX-2. A vertical, grouped, tickable list rather than a horizontal strip
          of cards: this is the surface someone uses standing over an open
          suitcase, so it is ordered the way a suitcase is filled and every row
          is a target. Not a FlatList -- the plan is bounded at 24 items by the
          contract, so a plain map inside the screen's existing scroll view
          avoids nesting a virtualized list inside another scroller, and each
          row is memoized so one tick does not re-render the rest. */}
      <Text style={styles.checkProgress} testID="packing-check-progress">
        {`${checkedCount} of ${plan.packedItems.length} packed`}
      </Text>
      <View testID="packing-items">
        {sections.map((section) => (
          <View key={section.key} style={styles.checkSection}>
            <Text style={styles.checkSectionLabel}>{section.label}</Text>
            {section.items.map((item) => (
              <PackingChecklistRow
                key={item.itemId}
                item={item}
                imageUri={resolveImage(item.clientId)}
                checked={checked.has(item.itemId)}
                onToggle={onToggleItemPacked}
              />
            ))}
          </View>
        ))}
      </View>
      {onRemoveItem && !busy ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.itemRow}
          testID="packing-items-detail"
        >
          {plan.packedItems.map((item) => (
            <ClosetItemCard
              key={item.itemId}
              item={item}
              imageUri={resolveImage(item.clientId)}
              onRemove={onRemoveItem}
            />
          ))}
        </ScrollView>
      ) : null}

      <SectionHeader title="LOOKS" />
      {plan.outfits.map((outfit) => (
        <View key={outfit.outfitId} style={styles.outfitCard} testID={`packing-outfit-${outfit.outfitId}`}>
          <Text style={styles.outfitLabel}>
            {(outfit.activity ? PACKING_ACTIVITY_LABELS[outfit.activity] : outfit.label).toUpperCase()}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.outfitRow}>
            {outfit.itemIds.map((itemId) => {
              const item = itemsById.get(itemId);
              if (!item) return null;
              return (
                <ClosetItemCard
                  key={`${outfit.outfitId}-${itemId}`}
                  item={item}
                  imageUri={resolveImage(item.clientId)}
                  compact
                />
              );
            })}
          </ScrollView>
          {outfit.reason ? <Text style={styles.outfitReason}>{outfit.reason}</Text> : null}
        </View>
      ))}

      {plan.gaps.length > 0 ? (
        <>
          <SectionHeader title="POSSIBLE GAPS" />
          <View testID="packing-gaps">
            {plan.gaps.map((gap) => (
              // Deliberately a different treatment from an owned item: no
              // photograph, no card chrome, no price and nothing to tap. A gap
              // is a thing the traveller does not have, and it must never be
              // able to read as a thing they do.
              <View key={gap.code} style={styles.gapRow} testID={`packing-gap-${gap.code}`}>
                <Text style={styles.gapLabel}>{gap.label}</Text>
                <Text style={styles.gapRationale}>{gap.rationale}</Text>
              </View>
            ))}
          </View>
        </>
      ) : null}

      {plan.assumptions.length > 0 ? (
        <>
          <SectionHeader title="ASSUMPTIONS" />
          <View style={styles.assumptionCard}>
            {plan.assumptions.map((assumption) => (
              <Text key={assumption} style={styles.assumption}>
                {`• ${assumption}`}
              </Text>
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

function SummaryStat({ value, label }: { value: number; label: string }) {
  return (
    <View style={styles.summaryStat}>
      <Text style={styles.summaryValue}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

/**
 * General mode. Visibly NOT a plan: no photographs, no item cards, no owned
 * styling — a checklist of categories with the reason personalization is
 * limited stated plainly.
 */
export function PackingGeneralGuideView({
  guide,
  message,
}: {
  guide: PackingGeneralGuide;
  message: string | null;
}) {
  return (
    <View testID="packing-general-guide">
      <Text style={styles.generalBadge}>GENERAL GUIDE</Text>
      {message ? <Text style={styles.eliseLine}>{message}</Text> : null}
      {guide.sections.map((section) => (
        <View key={section.label} style={styles.generalSection}>
          <Text style={styles.generalSectionLabel}>{section.label.toUpperCase()}</Text>
          {section.categories.map((entry) => (
            <Text key={entry} style={styles.generalEntry}>
              {`• ${entry}`}
            </Text>
          ))}
        </View>
      ))}
      {guide.notes.length > 0 ? (
        <View style={styles.assumptionCard}>
          {guide.notes.map((note) => (
            <Text key={note} style={styles.assumption}>
              {note}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  destination: {
    ...LUXURY.typography.displayHero,
    letterSpacing: 2,
  },
  dates: {
    ...LUXURY.typography.caption,
    marginTop: SPACING.xs,
  },
  weather: {
    ...LUXURY.typography.body,
    marginTop: SPACING.sm,
  },
  summaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: SPACING.lg,
    marginBottom: SPACING.sm,
  },
  checkProgress: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    marginBottom: SPACING.sm,
  },
  checkSection: {
    marginBottom: SPACING.lg,
  },
  checkSectionLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    letterSpacing: 1,
    marginBottom: SPACING.sm,
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.sm,
    borderRadius: RADIUS.sm,
    // 48pt minimum target: this is used one-handed over an open suitcase.
    minHeight: 56,
  },
  checkRowDone: {
    opacity: 0.55,
  },
  checkBox: {
    width: 24,
    height: 24,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkBoxChecked: {
    backgroundColor: LUXURY.colors.plum,
    borderColor: LUXURY.colors.plum,
  },
  checkMark: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.pearl,
  },
  checkThumb: {
    width: 44,
    height: 44,
    borderRadius: RADIUS.sm,
    overflow: 'hidden',
    backgroundColor: LUXURY.colors.champagne,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkBody: {
    flexShrink: 1,
    flexGrow: 1,
  },
  checkTitle: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.ink,
  },
  checkTitleDone: {
    textDecorationLine: 'line-through',
  },
  checkSubtitle: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    marginTop: SPACING.xxs,
  },
  ownedBadge: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    letterSpacing: 0.5,
  },
  scarcityBadge: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
  },
  reuseBadge: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
  },
  summaryStat: {
    marginRight: SPACING.xl,
    marginBottom: SPACING.sm,
  },
  summaryValue: {
    ...LUXURY.typography.displayTitle,
    fontSize: 30,
    lineHeight: 34,
  },
  summaryLabel: {
    ...LUXURY.typography.caption,
    marginTop: SPACING.xxs,
  },
  eliseLine: {
    ...LUXURY.typography.body,
    marginTop: SPACING.sm,
    marginBottom: SPACING.md,
  },
  itemRow: {
    paddingVertical: SPACING.sm,
    paddingRight: SPACING.lg,
  },
  itemCard: {
    width: 148,
    marginRight: SPACING.md,
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LUXURY.colors.border,
    padding: SPACING.sm,
    ...SHADOWS.editorialSmall,
  },
  itemCardCompact: {
    width: 104,
  },
  itemThumb: {
    height: 150,
    borderRadius: RADIUS.sm,
    backgroundColor: LUXURY.colors.champagne,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginBottom: SPACING.sm,
  },
  itemThumbCompact: {
    height: 104,
  },
  itemImage: {
    width: '100%',
    height: '100%',
  },
  itemFallback: {
    ...LUXURY.typography.displayTitle,
    color: LUXURY.colors.stone,
  },
  itemTitle: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 14,
    lineHeight: 19,
  },
  itemSubtitle: {
    ...LUXURY.typography.body,
    fontSize: 12,
    lineHeight: 17,
    marginTop: SPACING.xxs,
  },
  itemScarcity: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
    marginTop: SPACING.xs,
  },
  gapRow: {
    borderLeftWidth: 2,
    borderLeftColor: LUXURY.colors.stone,
    paddingLeft: SPACING.md,
    paddingVertical: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  gapLabel: {
    ...LUXURY.typography.bodyStrong,
  },
  gapRationale: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 19,
    marginTop: SPACING.xxs,
  },
  itemReuse: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldText,
    marginTop: SPACING.xs,
  },
  itemReason: {
    ...LUXURY.typography.body,
    fontSize: 12,
    lineHeight: 17,
    marginTop: SPACING.xs,
  },
  removeButton: {
    marginTop: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  removeLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
  },
  outfitCard: {
    backgroundColor: LUXURY.colors.cream,
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LUXURY.colors.border,
    padding: SPACING.md,
    marginBottom: SPACING.md,
  },
  outfitLabel: {
    ...LUXURY.typography.sectionLabel,
    marginBottom: SPACING.sm,
  },
  outfitRow: {
    paddingRight: SPACING.sm,
  },
  outfitReason: {
    ...LUXURY.typography.body,
    fontSize: 13,
    marginTop: SPACING.sm,
  },
  assumptionCard: {
    backgroundColor: LUXURY.colors.champagne,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    marginTop: SPACING.sm,
  },
  assumption: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
  },
  generalBadge: {
    ...LUXURY.typography.sectionLabel,
    color: LUXURY.colors.graphite,
    marginBottom: SPACING.sm,
  },
  generalSection: {
    marginBottom: SPACING.lg,
  },
  generalSectionLabel: {
    ...LUXURY.typography.sectionLabel,
    marginBottom: SPACING.xs,
  },
  generalEntry: {
    ...LUXURY.typography.body,
    fontSize: 14,
    lineHeight: 22,
  },
});
