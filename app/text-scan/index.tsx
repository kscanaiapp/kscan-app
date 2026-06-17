import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  LuxuryScreen,
  PrimaryButton,
  SectionHeader,
  EmptyStateCard,
  InlineNotice,
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
  TEXTSCAN_DEMO_RESULTS_ENABLED,
  TEXTSCAN_VOICE_PLACEHOLDER_ENABLED,
} from '../../constants/featureFlags';
import {
  TEXTSCAN_DEMO_ATTRIBUTES,
  TEXTSCAN_DEMO_PRODUCTS,
  TEXTSCAN_DEMO_SUGGESTIONS,
} from '../../data/textscan-demo';
import type { TextScanFilter } from '../../components/text-scan/ResultFilterTabs';

type ViewState = 'input' | 'processing' | 'results';

const MIN_QUERY_LENGTH = 3;
const MAX_QUERY_LENGTH = 240;
const PROCESSING_TIMEOUT_MS = 2000;

export default function TextScanScreen() {
  const [viewState, setViewState] = useState<ViewState>('input');
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<TextScanFilter>('all');

  const isQueryValid = query.trim().length >= MIN_QUERY_LENGTH;

  const handleSubmit = () => {
    if (!isQueryValid) return;
    setViewState('processing');
  };

  // Simulate a brief processing state, then land on results/prepared.
  useEffect(() => {
    if (viewState !== 'processing') return;

    const timer = setTimeout(() => {
      setViewState('results');
    }, PROCESSING_TIMEOUT_MS);

    return () => clearTimeout(timer);
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
        title="Scan Search ✧"
        onPress={handleSubmit}
        disabled={!isQueryValid}
        accessibilityLabel="Scan search"
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

      <View style={styles.attributesCard}>
        <SectionHeader
          title="Interpreted Attributes"
          actionLabel="Edit"
          onAction={() => setViewState('input')}
          actionAccessibilityLabel="Edit search query"
        />
        <AttributeGrid attributes={TEXTSCAN_DEMO_ATTRIBUTES} />
      </View>

      <View style={styles.refiningCard}>
        <Text style={styles.refiningTitle}>Refining results...</Text>
        <Text style={styles.refiningBody}>
          Finding the best matches across retail and resale.
        </Text>
      </View>

      <View style={styles.composerShell} pointerEvents="none">
        <Text style={styles.composerLabel}>Preview only</Text>
        <View style={styles.composerField}>
          <Text style={styles.composerPlaceholder}>
            Ask me anything about style...
          </Text>
        </View>
      </View>
    </View>
  );

  const renderResultsState = () => {
    if (!TEXTSCAN_DEMO_RESULTS_ENABLED) {
      return (
        <View style={styles.resultsContainer}>
          <EmptyStateCard
            title="TextScan matching is being prepared."
            subtitle="Camera Scan is available now. Your TextScan UI is ready for backend wiring."
            icon={<Text style={styles.emptyIcon}>✦</Text>}
            action={{
              label: 'Edit Search',
              onPress: () => setViewState('input'),
              accessibilityLabel: 'Edit search query',
              testID: 'textscan-edit-search-button',
            }}
            testID="textscan-prepared-state"
          />
        </View>
      );
    }

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
        rightAction={<AIStarBadge label="AI STAR" />}
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
});
