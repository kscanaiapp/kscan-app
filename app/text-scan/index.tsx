import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Keyboard,
} from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  LuxuryScreen,
  PrimaryButton,
  SecondaryButton,
  SectionHeader,
  EmptyStateCard,
  InlineNotice,
  StatusPill,
} from '../../components/luxury';
import {
  AIStarBadge,
  AttributeGrid,
  ResultFilterTabs,
  TextScanFeatureRow,
  TextScanHeader,
  TextScanInput,
  TextScanProductCard,
  TextScanSuggestionChip,
} from '../../components/text-scan';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import {
  TEXTSCAN_BACKEND_ENABLED,
  TEXTSCAN_DEMO_RESULTS_ENABLED,
  TEXTSCAN_VOICE_PLACEHOLDER_ENABLED,
} from '../../constants/featureFlags';
import {
  analyzeTextWithEdge,
  type TextScanResult,
} from '../../services/textScanEdge';
import {
  validateTextScanQuery,
  toAttributeGrid,
} from '../../services/textScan';
import {
  TEXTSCAN_DEMO_ATTRIBUTES,
  TEXTSCAN_DEMO_PRODUCTS,
  TEXTSCAN_DEMO_SUGGESTIONS,
} from '../../data/textscan-demo';
import { useFeatureFreeze } from '../../hooks/useFeatureFreeze';
import { setStyleChatHandoffContext } from '../../services/style-chat/styleChatHandoffContext';
import type { TextScanFilter } from '../../components/text-scan/ResultFilterTabs';

type ViewState = 'input' | 'processing' | 'results';

const MIN_QUERY_LENGTH = 3;
const MAX_QUERY_LENGTH = 500;
const PROCESSING_TIMEOUT_MS = 2000;
const SUBMIT_DEBOUNCE_MS = 500;

export default function TextScanScreen() {
  const { isFeatureEnabled, isLoading: featureFreezeLoading } = useFeatureFreeze();
  const styleChatEnabled = !featureFreezeLoading && isFeatureEnabled('styleChat');

  const [viewState, setViewState] = useState<ViewState>('input');
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<TextScanFilter>('all');
  const [textScanResult, setTextScanResult] = useState<TextScanResult | null>(null);
  const [textScanError, setTextScanError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastSubmitAt, setLastSubmitAt] = useState(0);

  const isQueryValid = query.trim().length >= MIN_QUERY_LENGTH;

  const handleSubmit = () => {
    if (!isQueryValid || isSubmitting) return;

    // Debounce
    const now = Date.now();
    if (now - lastSubmitAt < SUBMIT_DEBOUNCE_MS) return;
    setLastSubmitAt(now);

    Keyboard.dismiss();
    setTextScanResult(null);
    setTextScanError(null);
    setIsSubmitting(true);
    setViewState('processing');
  };

  // Processing effect: demo mode uses a timer; backend mode calls the API.
  useEffect(() => {
    if (viewState !== 'processing') return;

    if (!TEXTSCAN_BACKEND_ENABLED) {
      const timer = setTimeout(() => {
        setViewState('results');
        setIsSubmitting(false);
      }, PROCESSING_TIMEOUT_MS);
      return () => clearTimeout(timer);
    }

    let cancelled = false;

    const runBackend = async () => {
      try {
        const validation = validateTextScanQuery(query);
        if (validation.valid === false) {
          if (!cancelled) {
            setTextScanError(validation.message);
            setViewState('results');
            setIsSubmitting(false);
          }
          return;
        }

        const result = await analyzeTextWithEdge(query, { source: 'text-scan' });
        if (!cancelled) {
          setTextScanResult(result);
          setViewState('results');
          setIsSubmitting(false);
        }
      } catch (err) {
        if (!cancelled) {
          setTextScanError(
            err?.userMessage || 'Unable to analyze this style request. Please try again.'
          );
          setViewState('results');
          setIsSubmitting(false);
        }
      }
    };

    runBackend();
    return () => { cancelled = true; };
  }, [viewState]);

  const retailProducts = TEXTSCAN_DEMO_PRODUCTS.filter((p) => p.type === 'retail');
  const resaleProducts = TEXTSCAN_DEMO_PRODUCTS.filter((p) => p.type === 'resale');

  const handleBack = () => {
    if (viewState === 'input') {
      router.back();
    } else {
      setViewState('input');
    }
  };

  const renderInputState = () => (
    <>
      <View style={styles.introCard}>
        <Text style={styles.introSparkle}>✦</Text>
        <Text style={styles.introBody}>
          Describe fashion in natural language and shop it across retail + resale.
        </Text>
      </View>

      <TextScanInput
        value={query}
        onChangeText={setQuery}
        minLength={MIN_QUERY_LENGTH}
        maxLength={MAX_QUERY_LENGTH}
        placeholder="e.g., oversized wool coat in camel"
        style={styles.inputCard}
        accessibilityLabel="TextScan fashion query"
      />

      <View style={styles.suggestionsRow}>
        {TEXTSCAN_DEMO_SUGGESTIONS.map((suggestion) => (
          <TextScanSuggestionChip
            key={suggestion}
            label={suggestion}
            onPress={() => setQuery(suggestion)}
            accessibilityLabel={`Use suggestion: ${suggestion}`}
          />
        ))}
      </View>

      <PrimaryButton
        testID="textscan-submit-button"
        title="Analyze Request"
        onPress={handleSubmit}
        disabled={!isQueryValid || isSubmitting}
        accessibilityLabel="Analyze request"
        accessibilityHint="Starts interpreting your fashion query"
        style={styles.submitButton}
      />

      <TextScanFeatureRow
        showVoicePlaceholder={TEXTSCAN_VOICE_PLACEHOLDER_ENABLED}
        style={styles.featureRow}
      />
    </>
  );

  const renderProcessingState = () => (
    <View style={styles.processingContainer}>
      <View style={styles.processingHeader}>
        <Text style={styles.processingSparkle}>✦</Text>
        <Text style={styles.processingTitle}>Parsing your request...</Text>
      </View>

      {TEXTSCAN_BACKEND_ENABLED && (
        <View style={styles.refiningCard}>
          <Text style={styles.refiningTitle}>Analyzing style...</Text>
          <Text style={styles.refiningBody}>
            Interpreting your fashion query.
          </Text>
        </View>
      )}

      {TEXTSCAN_DEMO_RESULTS_ENABLED && (
        <View style={styles.attributesCard}>
          <SectionHeader
            title="Interpreted Attributes"
            actionLabel="Edit"
            onAction={() => setViewState('input')}
            actionAccessibilityLabel="Edit search query"
          />
          <AttributeGrid attributes={TEXTSCAN_DEMO_ATTRIBUTES} />
        </View>
      )}

      {TEXTSCAN_DEMO_RESULTS_ENABLED && (
        <View style={styles.refiningCard}>
          <Text style={styles.refiningTitle}>Refining results...</Text>
          <Text style={styles.refiningBody}>
            Finding the best matches across retail and resale.
          </Text>
        </View>
      )}

      {TEXTSCAN_DEMO_RESULTS_ENABLED && (
        <View style={styles.composerShell} pointerEvents="none">
          <Text style={styles.composerLabel}>Preview only</Text>
          <View style={styles.composerField}>
            <Text style={styles.composerPlaceholder}>
              Ask me anything about style...
            </Text>
          </View>
        </View>
      )}
    </View>
  );

  const handleScanAgain = () => {
    setQuery('');
    setTextScanResult(null);
    setTextScanError(null);
    setViewState('input');
  };

  const renderResultsState = () => {
    // ── Backend result branch ────────────────────────────────────────────────
    if (TEXTSCAN_BACKEND_ENABLED && (textScanResult || textScanError)) {
      const isNonFashion = textScanResult?.type === 'non_fashion_text';
      const attributes = textScanResult?.metadata?.attributes
        ? toAttributeGrid(textScanResult.metadata.attributes)
        : { category: '—', silhouette: '—', color: '—', material: '—', style: '—', budget: '—' };

      return (
        <View style={styles.resultsContainer}>
          {/* User Request Card */}
          <View style={styles.requestCard}>
            <Text style={styles.requestLabel}>YOUR REQUEST</Text>
            <Text style={styles.requestQuery}>{query}</Text>
            <View style={styles.badgeWrap}>
              <StatusPill
                label="TextScan"
                variant="neutral"
                accessibilityLabel="TextScan source"
              />
            </View>
          </View>

          {/* Analysis Summary */}
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>ANALYSIS</Text>
            {textScanError ? (
              <Text style={styles.summaryBody}>{textScanError}</Text>
            ) : isNonFashion ? (
              <Text style={styles.summaryBody}>
                {textScanResult?.result || "This doesn't appear to be a fashion query. Try describing a garment, style, or outfit."}
              </Text>
            ) : (
              <Text style={styles.summaryBody}>
                {textScanResult?.result || 'Analysis complete.'}
              </Text>
            )}
          </View>

          {/* Interpreted Attributes */}
          {!textScanError && (
            <View style={styles.attributesCard}>
              <SectionHeader
                title="Interpreted Attributes"
                actionLabel="Edit"
                onAction={() => setViewState('input')}
                actionAccessibilityLabel="Edit search query"
              />
              <AttributeGrid attributes={attributes} />
            </View>
          )}

          {/* Safe empty state for non-fashion */}
          {!textScanError && isNonFashion && (
            <View style={styles.refiningCard}>
              <Text style={styles.refiningTitle}>Not a fashion query</Text>
              <Text style={styles.refiningBody}>
                Try describing a garment, style, or outfit.
              </Text>
            </View>
          )}

          {/* Actions */}
          <View style={styles.actionStack}>
            {styleChatEnabled && !textScanError && !isNonFashion && (
              <SecondaryButton
                title="Ask StyleChat"
                onPress={() => {
                  setStyleChatHandoffContext({
                    source: 'text-scan',
                    query: query.trim(),
                    textScanId: textScanResult?.id ?? null,
                    category: textScanResult?.metadata?.attributes?.category ?? null,
                    color: textScanResult?.metadata?.attributes?.color ?? null,
                    silhouette: textScanResult?.metadata?.attributes?.silhouette ?? null,
                    material: textScanResult?.metadata?.attributes?.material ?? null,
                    descriptors: textScanResult?.metadata?.attributes?.styleTags ?? null,
                    analysisText: textScanResult?.result ?? null,
                    createdAt: new Date().toISOString(),
                  });
                  router.push('/style-chat');
                }}
                accessibilityLabel="Ask StyleChat about this request"
                testID="textscan-ask-stylechat"
              />
            )}
            <SecondaryButton
              title="Save to Closet"
              disabled
              onPress={() => {}}
              accessibilityLabel="Save coming soon for TextScan"
              testID="textscan-save-library"
            />
            <SecondaryButton
              title="Add to Dressing Room"
              disabled
              onPress={() => {}}
              accessibilityLabel="Add to Room coming soon for TextScan"
              testID="textscan-add-room"
            />
            <PrimaryButton
              title="Scan Again"
              onPress={handleScanAgain}
              accessibilityLabel="Start a new TextScan query"
              testID="textscan-scan-again"
            />
          </View>
        </View>
      );
    }

    // ── Demo branch ──────────────────────────────────────────────────────────
    if (TEXTSCAN_DEMO_RESULTS_ENABLED) {
      return (
        <View style={styles.resultsContainer}>
          <InlineNotice
            variant="info"
            title="Demo preview"
            body={`${TEXTSCAN_DEMO_PRODUCTS.length} sample results for your search`}
            style={styles.demoNotice}
          />

          <ResultFilterTabs
            activeFilter={activeFilter}
            onFilterChange={setActiveFilter}
            style={styles.filterTabs}
          />

          {activeFilter !== 'resale' && retailProducts.length > 0 && (
            <>
              <SectionHeader
                title="Retail Matches"
                actionLabel="See all >"
                onAction={() => {}}
                actionAccessibilityLabel="See all retail matches"
              />
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.productShelf}
              >
                {retailProducts.map((product) => (
                  <TextScanProductCard
                    key={product.id}
                    product={product}
                    style={styles.productCard}
                  />
                ))}
              </ScrollView>
            </>
          )}

          {activeFilter !== 'retail' && resaleProducts.length > 0 && (
            <>
              <SectionHeader
                title="Resale Matches"
                actionLabel="See all >"
                onAction={() => {}}
                actionAccessibilityLabel="See all resale matches"
              />
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.productShelf}
              >
                {resaleProducts.map((product) => (
                  <TextScanProductCard
                    key={product.id}
                    product={product}
                    style={styles.productCard}
                  />
                ))}
              </ScrollView>
            </>
          )}

          <PrimaryButton
            title="Edit Search"
            onPress={() => setViewState('input')}
            accessibilityLabel="Edit search query"
            style={styles.editSearchButton}
          />
        </View>
      );
    }

    // ── Fallback / preview branch ───────────────────────────────────────────
    return (
      <View style={styles.resultsContainer}>
        {/* User Request Card */}
        <View style={styles.requestCard}>
          <Text style={styles.requestLabel}>YOUR REQUEST</Text>
          <Text style={styles.requestQuery}>{query}</Text>
          <View style={styles.badgeWrap}>
            <StatusPill
              label="TextScan"
              variant="neutral"
              accessibilityLabel="TextScan source"
            />
          </View>
        </View>

        {/* Analysis Summary */}
        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>ANALYSIS</Text>
          <Text style={styles.summaryBody}>
            {TEXTSCAN_BACKEND_ENABLED
              ? 'Text analysis is coming soon.'
              : 'Live TextScan matching is being prepared.'}
          </Text>
        </View>

        {/* Attribute Placeholders */}
        <View style={styles.attributesCard}>
          <SectionHeader
            title="Interpreted Attributes"
            actionLabel="Edit"
            onAction={() => setViewState('input')}
            actionAccessibilityLabel="Edit search query"
          />
          <AttributeGrid
            attributes={{
              category: '—',
              silhouette: '—',
              color: '—',
              material: '—',
              style: '—',
              budget: '—',
            }}
          />
        </View>

        {/* Actions */}
        <View style={styles.actionStack}>
          {styleChatEnabled && (
            <SecondaryButton
              title="Ask StyleChat"
              onPress={() => {
                setStyleChatHandoffContext({
                  source: 'text-scan',
                  query: query.trim(),
                  createdAt: new Date().toISOString(),
                });
                router.push('/style-chat');
              }}
              accessibilityLabel="Ask StyleChat about this request"
              testID="textscan-ask-stylechat"
            />
          )}
          <SecondaryButton
            title="Save to Closet"
            disabled
            onPress={() => {}}
            accessibilityLabel="Save support for TextScan is being prepared"
            testID="textscan-save-library"
          />
          <SecondaryButton
            title="Add to Dressing Room"
            disabled
            onPress={() => {}}
            accessibilityLabel="Dressing Room support for TextScan is being prepared"
            testID="textscan-add-room"
          />
          <PrimaryButton
            title="Scan Again"
            onPress={handleScanAgain}
            accessibilityLabel="Start a new TextScan query"
            testID="textscan-scan-again"
          />
        </View>
      </View>
    );
  };

  return (
    <LuxuryScreen
      testID="text-scan-screen"
      backgroundColor={LUXURY.colors.ivory}
      scrollable
      safeArea
      accessibilityLabel="TextScan screen"
    >
      <StatusBar style="dark" />

      <TextScanHeader
        title="TextScan"
        onBack={handleBack}
        backLabel="Back"
        rightAction={<AIStarBadge />}
      />

      {viewState === 'input' && renderInputState()}
      {viewState === 'processing' && renderProcessingState()}
      {viewState === 'results' && renderResultsState()}
    </LuxuryScreen>
  );
}

const styles = StyleSheet.create({
  introCard: {
    alignItems: 'center',
    backgroundColor: LUXURY.colors.warmWhite,
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    padding: SPACING.xl,
    marginBottom: SPACING.xl,
    ...SHADOWS.editorialRaised,
  },
  introSparkle: {
    fontSize: 28,
    color: LUXURY.colors.goldBrushed,
    marginBottom: SPACING.md,
  },
  introBody: {
    ...LUXURY.typography.body,
    textAlign: 'center',
    color: LUXURY.colors.graphite,
  },
  inputCard: {
    marginBottom: SPACING.lg,
  },
  suggestionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    marginBottom: SPACING.xl,
  },
  submitButton: {
    alignSelf: 'stretch',
    minWidth: undefined,
    marginBottom: SPACING.xxl,
  },
  featureRow: {
    marginBottom: SPACING.xxl,
  },

  processingContainer: {
    gap: SPACING.lg,
  },
  processingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    marginBottom: SPACING.md,
  },
  processingSparkle: {
    fontSize: 18,
    color: LUXURY.colors.goldBrushed,
  },
  processingTitle: {
    ...LUXURY.typography.displayTitle,
    fontSize: 20,
    color: LUXURY.colors.plumDeep,
  },
  attributesCard: {
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.lg,
    marginBottom: SPACING.lg,
    ...SHADOWS.editorialSmall,
  },
  refiningCard: {
    backgroundColor: LUXURY.colors.warmWhite,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    padding: SPACING.lg,
    marginBottom: SPACING.lg,
  },
  refiningTitle: {
    ...LUXURY.typography.sectionLabel,
    color: LUXURY.colors.plum,
    marginBottom: SPACING.xs,
  },
  refiningBody: {
    ...LUXURY.typography.body,
    fontSize: 14,
    color: LUXURY.colors.graphite,
  },
  composerShell: {
    marginBottom: SPACING.xxl,
  },
  composerLabel: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    color: LUXURY.colors.stone,
    marginBottom: SPACING.xs,
    marginLeft: SPACING.sm,
  },
  composerField: {
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    minHeight: 48,
    justifyContent: 'center',
  },
  composerPlaceholder: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.stone,
  },

  resultsContainer: {
    gap: SPACING.lg,
  },
  demoNotice: {
    marginBottom: SPACING.sm,
  },
  filterTabs: {
    marginBottom: SPACING.md,
  },
  productShelf: {
    gap: SPACING.md,
    paddingBottom: SPACING.md,
  },
  productCard: {
    marginRight: SPACING.md,
  },
  editSearchButton: {
    alignSelf: 'stretch',
    minWidth: undefined,
    marginTop: SPACING.lg,
    marginBottom: SPACING.xxl,
  },
  emptyIcon: {
    fontSize: 32,
    color: LUXURY.colors.goldBrushed,
  },
  requestCard: {
    backgroundColor: LUXURY.colors.warmWhite,
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    padding: SPACING.lg,
    ...SHADOWS.editorialRaised,
  },
  requestLabel: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 2.0,
    color: LUXURY.colors.goldBrushed,
    marginBottom: SPACING.xs,
  },
  requestQuery: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 16,
    lineHeight: 22,
    color: LUXURY.colors.plumDeep,
    marginBottom: SPACING.md,
  },
  badgeWrap: {
    alignSelf: 'flex-start',
  },
  summaryCard: {
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.lg,
    ...SHADOWS.editorialSmall,
  },
  summaryLabel: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 2.0,
    color: LUXURY.colors.goldBrushed,
    marginBottom: SPACING.xs,
  },
  summaryBody: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
  },
  actionStack: {
    gap: SPACING.md,
    marginTop: SPACING.lg,
    marginBottom: SPACING.xxl,
  },
});


