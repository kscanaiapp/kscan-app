// Receipt & Purchase Intelligence V1 — "Import from an Order".
//
//   SHOP -> PURCHASE -> PURCHASE EVIDENCE -> REVIEW -> CONFIRM -> OWN
//
// The customer gives K Scan an order confirmation or receipt, frames the
// purchased items (the required crop is the privacy boundary), reviews what was
// read, and explicitly confirms. Only that confirmation writes to the Closet.
//
// FLAG OFF (BLOCK-RPI-33): the route redirects to the Closet and renders
// nothing. There is no extraction path to reach.

import React, { useCallback, useEffect } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { InlineNotice, KScanHeader, LuxuryScreen, PrimaryButton, SecondaryButton } from '../../components/luxury';
import { PurchaseCropStep } from '../../components/purchase-import/PurchaseCropStep';
import { PurchaseCandidateCard } from '../../components/purchase-import/PurchaseCandidateCard';
import { LUXURY, RADIUS, SPACING, FONTS } from '../../constants/theme';
import { usePurchaseImport } from '../../hooks/usePurchaseImport';
import { hasUsablePhotoLibraryAccess } from '../../services/photoLibraryAccess';
import { errorPulse, successPulse, warningPulse } from '../../services/haptics';
import type { PurchaseImportInputTier } from '../../services/purchaseImport/purchaseImportContract';
import { PURCHASE_IMPORT_ERRORS } from '../../services/purchaseImport/purchaseImportErrors';

const TIERS: Array<{ id: PurchaseImportInputTier; label: string; hint: string }> = [
  {
    id: 'order_confirmation',
    label: 'Order confirmation',
    hint: 'A screenshot of an online order email or page. Usually the most detail.',
  },
  { id: 'digital_receipt', label: 'Digital receipt', hint: 'A screenshot of an e-receipt.' },
  {
    id: 'paper_receipt',
    label: 'Paper receipt',
    hint: 'A photo of a printed receipt. Short item codes may need more correcting.',
  },
];

function goToCloset() {
  router.replace({ pathname: '/library', params: { section: 'closet' } });
}

async function pickImage(source: 'camera' | 'library'): Promise<ImagePicker.ImagePickerAsset | null> {
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (permission.status !== 'granted') {
      Alert.alert('Camera Access Required', 'Allow K Scan AI to use your camera in Settings to photograph a receipt.', [
        { text: 'OK' },
      ]);
      return null;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, allowsEditing: false });
    return result.canceled ? null : result.assets?.[0] ?? null;
  }
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!hasUsablePhotoLibraryAccess(permission)) {
    Alert.alert('Photo Access Required', 'Allow K Scan AI to access your photos in Settings to choose a screenshot.', [
      { text: 'OK' },
    ]);
    return null;
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 1,
    allowsEditing: false,
    allowsMultipleSelection: false,
    // EXIF and GPS are not requested. The crop step re-encodes anyway.
    exif: false,
  });
  return result.canceled ? null : result.assets?.[0] ?? null;
}

export default function PurchaseImportScreen() {
  const flow = usePurchaseImport();
  const { state } = flow;

  useEffect(() => {
    if (!flow.enabled) goToCloset();
  }, [flow.enabled]);

  // Completion and failure are announced, not only drawn (spec section 39).
  useEffect(() => {
    if (state.step === 'done' && state.commit) {
      successPulse();
      AccessibilityInfo.announceForAccessibility(
        `${state.commit.addedCount} ${state.commit.addedCount === 1 ? 'item' : 'items'} added to your Closet`,
      );
    } else if (state.step === 'review' && state.errorClass === 'partial_closet_persistence' && state.commit) {
      warningPulse();
      AccessibilityInfo.announceForAccessibility(
        `${state.commit.addedCount} added, ${state.commit.failedCount} not added. You can retry the ones that failed.`,
      );
    } else if (state.step === 'error' && state.errorClass) {
      errorPulse();
      AccessibilityInfo.announceForAccessibility(PURCHASE_IMPORT_ERRORS[state.errorClass].title);
    }
  }, [state.step, state.errorClass, state.commit]);

  const choose = useCallback(
    async (source: 'camera' | 'library') => {
      const asset = await pickImage(source);
      if (!asset) return;
      await flow.acceptPickedImage({
        uri: asset.uri,
        width: asset.width,
        height: asset.height,
        mimeType: asset.mimeType ?? null,
        fileName: asset.fileName ?? null,
      });
    },
    [flow],
  );

  const addPhotoFor = useCallback(
    (lineIndex: number) => {
      Alert.alert('Add a photo of this item', 'Optional. It helps you recognise the item in your Closet.', [
        {
          text: 'Take Photo',
          onPress: async () => {
            const asset = await pickImage('camera');
            if (asset) flow.setPhoto(lineIndex, asset.uri);
          },
        },
        {
          text: 'Choose from Library',
          onPress: async () => {
            const asset = await pickImage('library');
            if (asset) flow.setPhoto(lineIndex, asset.uri);
          },
        },
        { text: 'Skip', style: 'cancel' },
      ]);
    },
    [flow],
  );

  const exit = useCallback(async () => {
    await flow.cancel();
    goToCloset();
  }, [flow]);

  if (!flow.enabled) return null;

  const outcomeFor = (lineIndex: number): 'added' | 'failed' | 'partial' | null => {
    const outcomes = state.commit?.outcomes.filter((o) => o.lineIndex === lineIndex) ?? [];
    if (outcomes.length === 0) return null;
    const ok = outcomes.filter((o) => o.status === 'added' || o.status === 'already_added').length;
    if (ok === outcomes.length) return 'added';
    return ok === 0 ? 'failed' : 'partial';
  };

  const committedLines = new Set(
    (state.commit?.outcomes ?? [])
      .filter((o) => o.status === 'added' || o.status === 'already_added')
      .map((o) => o.lineIndex),
  );
  const partial = state.errorClass === 'partial_closet_persistence' && state.commit;
  const busy = state.step === 'committing';

  return (
    <LuxuryScreen scrollable testID="purchase-import-screen">
      <KScanHeader
        title="Import from an Order"
        onBack={exit}
        backLabel="Closet"
        accessibilityLabel="Import from an order"
      />

      <View style={styles.body}>
        {!flow.signedIn ? (
          <InlineNotice
            variant="info"
            title={PURCHASE_IMPORT_ERRORS.unauthorized.title}
            body={PURCHASE_IMPORT_ERRORS.unauthorized.message}
            action={{ label: 'Sign In', onPress: () => router.push('/auth') }}
            testID="purchase-import-signed-out"
          />
        ) : null}

        {state.step === 'choose' && flow.signedIn ? (
          <View style={styles.section} testID="purchase-import-choose">
            <Text style={styles.kicker}>Step 1 of 3 · Choose</Text>
            <Text style={styles.heading}>Add what you bought</Text>
            <Text style={styles.copy}>
              Share an order confirmation or receipt for clothing, shoes, bags or accessories. You’ll crop it to the
              purchased items, review what we read, and choose what goes in your Closet. Nothing is added until you
              confirm, and the image isn’t kept.
            </Text>

            <View style={styles.tiers} accessibilityRole="radiogroup" accessibilityLabel="What are you importing?">
              {TIERS.map((tier) => {
                const selected = state.inputTier === tier.id;
                return (
                  <Pressable
                    key={tier.id}
                    onPress={() => flow.setInputTier(tier.id)}
                    style={[styles.tier, selected ? styles.tierOn : null]}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    accessibilityLabel={`${tier.label}. ${tier.hint}`}
                    testID={`purchase-import-tier-${tier.id}`}
                  >
                    <Text style={[styles.tierLabel, selected ? styles.tierLabelOn : null]}>{tier.label}</Text>
                    <Text style={styles.tierHint}>{tier.hint}</Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.actions}>
              <PrimaryButton
                title={state.inputTier === 'paper_receipt' ? 'Take Photo of Receipt' : 'Choose Screenshot'}
                onPress={() => choose(state.inputTier === 'paper_receipt' ? 'camera' : 'library')}
                testID="purchase-import-choose-primary"
              />
              <SecondaryButton
                title={state.inputTier === 'paper_receipt' ? 'Choose from Library' : 'Take Photo Instead'}
                onPress={() => choose(state.inputTier === 'paper_receipt' ? 'library' : 'camera')}
                testID="purchase-import-choose-secondary"
              />
            </View>
          </View>
        ) : null}

        {state.step === 'crop' && state.staged ? (
          <PurchaseCropStep
            imageUri={state.staged.stagedUri}
            imageWidth={state.staged.width}
            imageHeight={state.staged.height}
            onConfirm={(crop) => void flow.extract(crop)}
            onCancel={() => void flow.cancel()}
          />
        ) : null}

        {state.step === 'extracting' ? (
          <View style={styles.loading} accessibilityLiveRegion="polite" testID="purchase-import-extracting">
            <ActivityIndicator color={LUXURY.colors.plum} size="large" />
            <Text style={styles.heading}>Reading your purchases</Text>
            <Text style={styles.copy}>Only the area you cropped is being read.</Text>
            <SecondaryButton title="Cancel" onPress={() => void flow.cancel()} testID="purchase-import-extract-cancel" />
          </View>
        ) : null}

        {(state.step === 'review' || state.step === 'committing') && state.review ? (
          <View style={styles.section} testID="purchase-import-review">
            <Text style={styles.kicker}>Step 3 of 3 · Review</Text>
            <Text style={styles.heading} accessibilityRole="header">
              We found {state.candidates.length} fashion {state.candidates.length === 1 ? 'purchase' : 'purchases'}
            </Text>
            <DocumentSummary review={state.review} />

            {partial ? (
              <InlineNotice
                variant="warning"
                title={`${state.commit!.addedCount} added · ${state.commit!.failedCount} not added`}
                body={PURCHASE_IMPORT_ERRORS.partial_closet_persistence.message}
                action={{
                  label: 'Retry Failed Items',
                  onPress: () => void flow.retryFailed(),
                  testID: 'purchase-import-retry',
                }}
                accessibilityRole="alert"
                testID="purchase-import-partial"
              />
            ) : null}

            {state.candidates.map((candidate) => (
              <PurchaseCandidateCard
                key={candidate.lineIndex}
                candidate={candidate}
                photoUri={state.photos.get(candidate.lineIndex) ?? null}
                outcome={outcomeFor(candidate.lineIndex)}
                disabled={busy || committedLines.has(candidate.lineIndex)}
                onToggle={() => flow.toggleCandidate(candidate.lineIndex)}
                onEdit={(field, value) => flow.editCandidate(candidate.lineIndex, field, value)}
                onUnits={(units) => flow.setUnits(candidate.lineIndex, units)}
                onAddPhoto={() => addPhotoFor(candidate.lineIndex)}
                onRemovePhoto={() => flow.setPhoto(candidate.lineIndex, null)}
              />
            ))}

            {!partial ? (
              <View style={styles.actions}>
                <PrimaryButton
                  title={
                    flow.selectedUnits === 0
                      ? 'Select Items to Add'
                      : `Add ${flow.selectedUnits} ${flow.selectedUnits === 1 ? 'Item' : 'Items'} to My Closet`
                  }
                  onPress={() => void flow.confirm()}
                  disabled={busy || flow.selectedUnits === 0}
                  loading={busy}
                  accessibilityHint="Adds the selected items to your Closet. Nothing is added before this."
                  testID="purchase-import-confirm"
                />
                <SecondaryButton title="Cancel" onPress={exit} disabled={busy} testID="purchase-import-review-cancel" />
              </View>
            ) : (
              <SecondaryButton title="Done" onPress={exit} testID="purchase-import-partial-done" />
            )}
          </View>
        ) : null}

        {state.step === 'done' && state.commit ? (
          <View style={styles.section} testID="purchase-import-done">
            <Text style={styles.heading} accessibilityRole="header">
              {state.commit.addedCount} {state.commit.addedCount === 1 ? 'item' : 'items'} added to your Closet
            </Text>
            <Text style={styles.copy}>
              Your order image has been discarded. You can edit these items any time in your Closet.
            </Text>
            <PrimaryButton title="View My Closet" onPress={exit} testID="purchase-import-view-closet" />
          </View>
        ) : null}

        {state.step === 'error' && state.errorClass ? (
          <View style={styles.section} testID="purchase-import-error">
            <InlineNotice
              variant="error"
              title={PURCHASE_IMPORT_ERRORS[state.errorClass].title}
              body={PURCHASE_IMPORT_ERRORS[state.errorClass].message}
              accessibilityRole="alert"
              testID={`purchase-import-error-${state.errorClass}`}
            />
            <View style={styles.actions}>
              {PURCHASE_IMPORT_ERRORS[state.errorClass].recovery === 'sign_in' ? (
                <PrimaryButton title="Sign In" onPress={() => router.push('/auth')} />
              ) : PURCHASE_IMPORT_ERRORS[state.errorClass].recovery === 'close' ? (
                <PrimaryButton title="Back to Closet" onPress={exit} testID="purchase-import-error-close" />
              ) : (
                <PrimaryButton
                  title={
                    PURCHASE_IMPORT_ERRORS[state.errorClass].recovery === 'retry' ? 'Try Again' : 'Choose Another Image'
                  }
                  onPress={() => void flow.cancel()}
                  testID="purchase-import-error-restart"
                />
              )}
              <SecondaryButton title="Back to Closet" onPress={exit} />
            </View>
          </View>
        ) : null}
      </View>
    </LuxuryScreen>
  );
}

function DocumentSummary({ review }: { review: NonNullable<ReturnType<typeof usePurchaseImport>['state']['review']> }) {
  const { document, excluded } = review;
  const lines: string[] = [];
  if (document.merchant.value) lines.push(`From ${document.merchant.value}`);
  if (document.purchaseDate.value) lines.push(`Purchased ${document.purchaseDate.value}`);
  const skipped: string[] = [];
  if (excluded.returned) skipped.push(`${excluded.returned} returned or refunded`);
  if (excluded.not_closet_fashion) skipped.push(`${excluded.not_closet_fashion} beauty or fragrance`);
  if (excluded.non_fashion) skipped.push(`${excluded.non_fashion} not fashion`);
  if (excluded.not_an_item) skipped.push(`${excluded.not_an_item} shipping, tax or discount`);
  if (excluded.unreadable_line) skipped.push(`${excluded.unreadable_line} unreadable`);
  return (
    <View style={styles.summary}>
      {lines.length ? <Text style={styles.summaryText}>{lines.join(' · ')}</Text> : null}
      {document.returnDeadline.value ? (
        <Text style={styles.summaryText}>
          Return by {document.returnDeadline.value}, as printed on this document. It applies to every item from it.
        </Text>
      ) : null}
      {skipped.length ? (
        <Text style={styles.summaryMuted}>Not included: {skipped.join(', ')}. These won’t be added.</Text>
      ) : null}
      <Text style={styles.summaryMuted}>
        Check each item. Anything marked ⚑ Check was hard to read or doesn’t add up.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: SPACING.lg, paddingBottom: SPACING.xxxl, gap: SPACING.lg },
  section: { gap: SPACING.md },
  kicker: { ...LUXURY.typography.sectionLabel },
  heading: { ...LUXURY.typography.displayTitle },
  copy: { ...LUXURY.typography.body },
  tiers: { gap: SPACING.sm },
  tier: {
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    borderRadius: RADIUS.md,
    padding: SPACING.lg,
    gap: SPACING.xxs,
    backgroundColor: LUXURY.colors.warmWhite,
  },
  tierOn: { borderColor: LUXURY.colors.plum, backgroundColor: LUXURY.colors.pearl },
  tierLabel: { fontFamily: FONTS.serif, fontSize: 17, color: LUXURY.colors.ink },
  tierLabelOn: { color: LUXURY.colors.plum },
  tierHint: { fontFamily: FONTS.sans, fontSize: 13, lineHeight: 19, color: LUXURY.colors.graphite },
  actions: { gap: SPACING.sm, paddingTop: SPACING.sm },
  loading: { alignItems: 'center', gap: SPACING.md, paddingVertical: SPACING.xxxl },
  summary: {
    gap: SPACING.xs,
    borderLeftWidth: 2,
    borderLeftColor: LUXURY.colors.goldChampagne,
    paddingLeft: SPACING.md,
  },
  summaryText: { fontFamily: FONTS.sans, fontSize: 14, lineHeight: 20, color: LUXURY.colors.ink },
  summaryMuted: { fontFamily: FONTS.sans, fontSize: 13, lineHeight: 19, color: LUXURY.colors.stone },
});
