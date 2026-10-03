/**
 * Presentational pieces of the K+ membership paywall (Build 35 Phase D).
 *
 * Stateless: every string, price and enabled flag arrives from the pure model
 * (services/kplus/kplusPaywallModel.ts). Nothing here formats a price, names a
 * trial, or decides what the customer owns.
 *
 * Accessibility rules every piece keeps:
 *   - interactive targets are >= 44pt (CTA 52, Free path 48);
 *   - no fixed text heights and no font-scale caps -- cards grow with Dynamic Type;
 *   - plan selection is announced as a radio state AND drawn as a filled, checked
 *     indicator plus a heavier border, so it never depends on colour alone;
 *   - decorative glyphs are hidden from screen readers.
 */
import React from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { LUXURY, SPACING } from '../../constants/theme';
import { KPLUS_PAYWALL_COLORS as P } from '../../constants/kplusPaywallTheme';
import {
  KPLUS_PAYWALL_COPY as COPY,
  KPLUS_PAYWALL_LEGAL_LINKS,
  type KPlusPaywallBanner,
  type KPlusPlanCardView,
} from '../../services/kplus/kplusPaywallModel';

export interface KPlusBenefitRow {
  id: string;
  glyph: string;
  title: string;
  description: string;
}

export function KPlusMonogram() {
  return (
    <View style={styles.monogram} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <Text style={styles.monogramText}>
        K<Text style={styles.monogramPlus}>+</Text>
      </Text>
    </View>
  );
}

export function KPlusPaywallHeader({ compact = false }: { compact?: boolean }) {
  return (
    <View style={[styles.header, compact && styles.headerCompact]} testID="kplus-paywall-header">
      <KPlusMonogram />
      <Text style={styles.eyebrow}>{COPY.eyebrow}</Text>
      {compact ? null : (
        <>
          <Text style={styles.headline} accessibilityRole="header">
            {COPY.headline}
          </Text>
          <Text style={styles.subhead}>{COPY.subhead}</Text>
        </>
      )}
    </View>
  );
}

export function KPlusBenefitsList({ benefits }: { benefits: KPlusBenefitRow[] }) {
  if (benefits.length === 0) return null;
  return (
    <View style={styles.benefits} testID="kplus-paywall-benefits">
      {benefits.map((benefit) => (
        <View
          key={benefit.id}
          style={styles.benefitRow}
          accessible
          accessibilityLabel={`${benefit.title}. ${benefit.description}`}
          testID={`kplus-paywall-benefit-${benefit.id}`}
        >
          <View style={styles.benefitGlyph} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
            <Text style={styles.benefitGlyphText}>{benefit.glyph}</Text>
          </View>
          <View style={styles.benefitCopy}>
            <Text style={styles.benefitTitle}>{benefit.title}</Text>
            <Text style={styles.benefitBody}>{benefit.description}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

export function KPlusPlanCard({ plan, onSelect }: { plan: KPlusPlanCardView; onSelect: (kind: KPlusPlanCardView['kind']) => void }) {
  return (
    <Pressable
      testID={`kplus-plan-${plan.kind.toLowerCase()}`}
      onPress={() => onSelect(plan.kind)}
      disabled={plan.disabled}
      accessibilityRole="radio"
      accessibilityState={{ selected: plan.selected, checked: plan.selected, disabled: plan.disabled }}
      accessibilityLabel={plan.accessibilityLabel}
      style={[styles.planCard, plan.selected ? styles.planCardSelected : styles.planCardIdle]}
    >
      <View
        style={[styles.planIndicator, plan.selected ? styles.planIndicatorOn : styles.planIndicatorOff]}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        {plan.selected ? <Text style={styles.planIndicatorMark}>✓</Text> : null}
      </View>
      <View style={styles.planCopy}>
        <View style={styles.planNameRow}>
          <Text style={styles.planName}>{plan.name}</Text>
          {plan.badge ? (
            <View style={styles.planBadge} testID={`kplus-plan-${plan.kind.toLowerCase()}-badge`}>
              <Text style={styles.planBadgeText}>{plan.badge}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.planSubline}>{plan.subline}</Text>
      </View>
      <View style={styles.planPrice}>
        <Text style={styles.planPriceText} testID={`kplus-plan-${plan.kind.toLowerCase()}-price`}>
          {plan.price}
        </Text>
        <Text style={styles.planPriceUnit}>{plan.priceUnit}</Text>
      </View>
    </Pressable>
  );
}

export function KPlusDisclosure({ text, showTrialReminder }: { text: string; showTrialReminder: boolean }) {
  return (
    <View testID="kplus-paywall-disclosure-block">
      <View style={styles.disclosure}>
        <Text style={styles.disclosureText} testID="kplus-paywall-disclosure">
          {text}
        </Text>
      </View>
      {showTrialReminder ? (
        <Text style={styles.reminder} testID="kplus-paywall-trial-reminder">
          {COPY.trialReminder}
        </Text>
      ) : null}
    </View>
  );
}

export function KPlusPrimaryCta({
  label,
  enabled,
  busy,
  accessibilityLabel,
  onPress,
  testID,
}: {
  label: string;
  enabled: boolean;
  busy?: boolean;
  accessibilityLabel?: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={!enabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !enabled, busy: Boolean(busy) }}
      style={[styles.cta, !enabled && styles.ctaInactive]}
    >
      {busy ? <ActivityIndicator size="small" color={P.pearl} /> : null}
      <Text style={styles.ctaText}>{label}</Text>
    </Pressable>
  );
}

export function KPlusTextAction({
  label,
  onPress,
  testID,
  disabled = false,
  tone = 'plum',
  hint,
}: {
  label: string;
  onPress: () => void;
  testID: string;
  disabled?: boolean;
  tone?: 'plum' | 'graphite';
  hint?: string;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      style={styles.textAction}
    >
      <Text style={[styles.textActionLabel, tone === 'graphite' && styles.textActionGraphite]}>{label}</Text>
    </Pressable>
  );
}

/** "Continue with K Scan AI Free": normal contrast, full width, 48pt, no guilt copy. */
export function KPlusFreePath({ onPress, disabled = false }: { onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      testID="kplus-paywall-free-path"
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={COPY.freePath}
      accessibilityHint="Finishes setup without a K+ membership"
      accessibilityState={{ disabled }}
      style={styles.freePath}
    >
      <Text style={styles.freePathText}>{COPY.freePath}</Text>
    </Pressable>
  );
}

export function KPlusLegalFooter() {
  return (
    <View style={styles.legal} testID="kplus-paywall-legal">
      {KPLUS_PAYWALL_LEGAL_LINKS.map((link) => (
        <Pressable
          key={link.label}
          onPress={() => void Linking.openURL(link.url)}
          style={styles.legalTarget}
          accessibilityRole="link"
          accessibilityLabel={link.label}
        >
          <Text style={styles.legalText}>{link.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function KPlusBanner({ banner }: { banner: KPlusPaywallBanner }) {
  const tone = banner.tone === 'calm_error' ? styles.bannerError : banner.tone === 'info' ? styles.bannerInfo : styles.bannerNeutral;
  const text = banner.tone === 'calm_error' ? styles.bannerErrorText : banner.tone === 'info' ? styles.bannerInfoText : styles.bannerNeutralText;
  return (
    <View style={[styles.banner, tone]} testID={`kplus-paywall-banner-${banner.tone}`} accessibilityLiveRegion="polite">
      <Text style={[styles.bannerText, text]}>{banner.text}</Text>
    </View>
  );
}

export function KPlusGoldCheck() {
  return <Text style={styles.goldCheck}>✓</Text>;
}

export function KPlusStatusPanel({
  icon,
  title,
  body,
  children,
  testID,
}: {
  icon: React.ReactNode;
  title: string;
  body?: string | null;
  children?: React.ReactNode;
  testID: string;
}) {
  return (
    <View style={styles.panel} testID={testID}>
      <View style={styles.panelIcon} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        {icon}
      </View>
      <Text style={styles.panelTitle} accessibilityRole="header">
        {title}
      </Text>
      {body ? <Text style={styles.panelBody}>{body}</Text> : null}
      {children ? <View style={styles.panelActions}>{children}</View> : null}
    </View>
  );
}

export function KPlusSkeleton({ style }: { style?: object }) {
  return <View style={[styles.skeleton, style]} />;
}

export const kplusPaywallStyles = StyleSheet.create({
  stack: { gap: SPACING.md },
  plans: { gap: SPACING.sm },
  secondaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    columnGap: SPACING.lg,
  },
  skeletonCard: { minHeight: 68, borderRadius: 18 },
  skeletonLine: { height: 12, borderRadius: 6 },
  loadingPill: {
    minHeight: 52,
    borderRadius: 999,
    backgroundColor: 'rgba(51, 32, 61, 0.12)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
  },
  loadingPillText: { ...LUXURY.typography.body, fontSize: 14, color: P.graphite, textAlign: 'center' },
  keepOpen: { ...LUXURY.typography.body, fontSize: 12, lineHeight: 18, color: P.graphiteLight, textAlign: 'center' },
  overlayHost: { position: 'relative' },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: P.scrim,
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
  },
});

const styles = StyleSheet.create({
  monogram: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: P.brushedGold,
    backgroundColor: P.pearl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monogramText: { fontFamily: LUXURY.typography.displayTitle.fontFamily, fontSize: 18, fontWeight: '600', color: P.deepPlum },
  monogramPlus: { color: P.brushedGold },
  header: { alignItems: 'center', gap: SPACING.xs, paddingTop: SPACING.md },
  headerCompact: { paddingTop: SPACING.xl },
  eyebrow: {
    ...LUXURY.typography.sectionLabel,
    fontSize: 11,
    letterSpacing: 3,
    color: P.goldDeep,
    marginTop: SPACING.sm,
    textAlign: 'center',
  },
  headline: {
    ...LUXURY.typography.displayHeadline,
    color: P.ink,
    textAlign: 'center',
  },
  subhead: { ...LUXURY.typography.body, fontSize: 14, lineHeight: 21, color: P.graphite, textAlign: 'center' },
  benefits: { gap: SPACING.md },
  benefitRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.md },
  benefitGlyph: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: P.champagneSoft,
    borderWidth: 1,
    borderColor: P.goldHairline,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  benefitGlyphText: { fontSize: 12, color: P.goldDeep },
  benefitCopy: { flex: 1, gap: 2 },
  benefitTitle: { ...LUXURY.typography.body, fontSize: 14, lineHeight: 20, fontWeight: '600', color: P.ink },
  benefitBody: { ...LUXURY.typography.body, fontSize: 13, lineHeight: 18, color: P.graphite },
  planCard: {
    minHeight: 64,
    borderRadius: 18,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: SPACING.md,
    rowGap: SPACING.xs,
  },
  planCardIdle: { backgroundColor: P.pearl, borderWidth: 1, borderColor: P.plumHairline },
  planCardSelected: { backgroundColor: P.champagneSoft, borderWidth: 2, borderColor: P.brushedGold },
  planIndicator: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  planIndicatorOn: { backgroundColor: P.deepPlum, borderColor: P.deepPlum },
  planIndicatorOff: { backgroundColor: 'transparent', borderColor: P.graphiteLight },
  planIndicatorMark: { color: P.pearl, fontSize: 12, fontWeight: '700' },
  planCopy: { flexGrow: 1, flexShrink: 1, flexBasis: 140, gap: 2 },
  planNameRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.xs },
  planName: { ...LUXURY.typography.body, fontSize: 15, lineHeight: 21, fontWeight: '600', color: P.ink },
  planBadge: {
    backgroundColor: P.champagne,
    borderWidth: 1,
    borderColor: P.goldHairline,
    borderRadius: 999,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
  },
  planBadgeText: { ...LUXURY.typography.sectionLabel, fontSize: 10, letterSpacing: 1.4, color: P.goldDeep },
  planSubline: { ...LUXURY.typography.body, fontSize: 12, lineHeight: 17, color: P.graphite },
  planPrice: { alignItems: 'flex-end', marginLeft: 'auto', flexShrink: 0 },
  planPriceText: { ...LUXURY.typography.body, fontSize: 15, lineHeight: 21, fontWeight: '600', color: P.ink },
  planPriceUnit: { ...LUXURY.typography.body, fontSize: 11, lineHeight: 15, color: P.graphiteLight },
  disclosure: {
    borderRadius: 14,
    backgroundColor: P.champagneSoft,
    borderWidth: 1,
    borderColor: P.goldHairline,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  disclosureText: { ...LUXURY.typography.body, fontSize: 12.5, lineHeight: 19, color: P.graphite, textAlign: 'center' },
  reminder: { ...LUXURY.typography.body, fontSize: 12, lineHeight: 18, color: P.graphite, textAlign: 'center', marginTop: SPACING.xs },
  cta: {
    minHeight: 52,
    borderRadius: 999,
    backgroundColor: P.deepPlum,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
  },
  ctaInactive: { opacity: 0.7 },
  ctaText: { ...LUXURY.typography.body, fontSize: 15, lineHeight: 21, fontWeight: '600', color: P.pearl, textAlign: 'center' },
  textAction: { minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: SPACING.xs },
  textActionLabel: {
    ...LUXURY.typography.body,
    fontSize: 13.5,
    fontWeight: '500',
    color: P.plum800,
    textDecorationLine: 'underline',
    textAlign: 'center',
  },
  textActionGraphite: { color: P.graphite, textDecorationLine: 'none' },
  freePath: {
    minHeight: 48,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
  },
  freePathText: { ...LUXURY.typography.body, fontSize: 14.5, fontWeight: '600', color: P.ink, textAlign: 'center' },
  legal: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    columnGap: SPACING.md,
  },
  legalTarget: { minHeight: 44, justifyContent: 'center', paddingHorizontal: SPACING.xs },
  legalText: { ...LUXURY.typography.body, fontSize: 12, lineHeight: 17, color: P.graphite, textDecorationLine: 'underline' },
  banner: { borderRadius: 14, borderWidth: 1, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  bannerNeutral: { backgroundColor: P.champagneSoft, borderColor: P.goldHairline },
  bannerError: { backgroundColor: P.calmErrorSurface, borderColor: P.calmErrorBorder },
  bannerInfo: { backgroundColor: P.plumTint, borderColor: 'rgba(65, 41, 78, 0.2)' },
  bannerText: { ...LUXURY.typography.body, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  bannerNeutralText: { color: P.graphite },
  bannerErrorText: { color: P.calmErrorText },
  bannerInfoText: { color: P.plum800 },
  goldCheck: { fontSize: 20, color: P.goldDeep, fontWeight: '700' },
  panel: {
    borderRadius: 20,
    backgroundColor: P.pearl,
    borderWidth: 1,
    borderColor: P.plumHairline,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.xl,
    alignItems: 'center',
    gap: SPACING.sm,
  },
  panelIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: P.champagneSoft,
    borderWidth: 1,
    borderColor: P.goldHairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panelTitle: { ...LUXURY.typography.displayTitle, color: P.ink, textAlign: 'center', marginTop: SPACING.xs },
  panelBody: { ...LUXURY.typography.body, fontSize: 14, lineHeight: 21, color: P.graphite, textAlign: 'center' },
  panelActions: { alignSelf: 'stretch', gap: SPACING.xs, marginTop: SPACING.sm },
  skeleton: { backgroundColor: P.skeleton },
});
