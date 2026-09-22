// Receipt & Purchase Intelligence V1 — one reviewable purchase line.
//
// Nothing on this card writes anything. Every control changes the review model
// held in memory by hooks/usePurchaseImport.ts, and only the screen's explicit
// "Add N items to my Closet" commits.
//
// UNCERTAINTY IS NEVER COLOUR ALONE (spec section 39). A field the customer
// should look at carries the word "Check" and says so to screen readers.
//
// PRICE TRUTH (BLOCK-RPI-29): an amount is shown only in a known currency. A
// printed "$" is not a known currency, so the amount stays hidden until the
// customer picks which one it is.

import React, { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { LUXURY, RADIUS, SPACING, FONTS } from '../../constants/theme';
import { formatCommercePrice } from '../../services/dressingRoomCommerce';
import { PURCHASE_CLOSET_CATEGORIES } from '../../services/purchaseImport/purchaseImportContract';
import type { ReviewCandidate, ReviewField } from '../../services/purchaseImport/purchaseImportNormalizer';
import type { EditableCandidateField } from '../../services/purchaseImport/purchaseImportReview';
import { selectionTick } from '../../services/haptics';

const PROVENANCE_HINT: Record<string, string> = {
  RECEIPT_EXPLICIT: 'From your document',
  MODEL_NORMALIZED: 'Interpreted from your document',
  USER_CONFIRMED: 'Edited by you',
  UNKNOWN: 'Not on your document',
  KSCAN_VERIFIED_PRODUCT: 'Matched to a K Scan product',
};

function EditableRow({
  label,
  field,
  onCommit,
  maxLength,
  placeholder,
  keyboardType,
  testID,
}: {
  label: string;
  field: ReviewField<string>;
  onCommit: (value: string) => void;
  maxLength: number;
  placeholder?: string;
  keyboardType?: 'default' | 'decimal-pad';
  testID: string;
}) {
  const [draft, setDraft] = useState(field.value ?? '');
  useEffect(() => setDraft(field.value ?? ''), [field.value]);
  const check = field.uncertain;
  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowLabel}>{label}</Text>
        {check ? (
          <Text style={styles.checkBadge} accessibilityElementsHidden importantForAccessibility="no">
            ⚑ Check
          </Text>
        ) : null}
        <Text style={styles.provenance}>{PROVENANCE_HINT[field.provenance] ?? ''}</Text>
      </View>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onEndEditing={() => {
          if ((field.value ?? '') !== draft) onCommit(draft);
        }}
        placeholder={placeholder ?? 'Not recorded'}
        placeholderTextColor={LUXURY.colors.stone}
        maxLength={maxLength}
        keyboardType={keyboardType ?? 'default'}
        style={[styles.input, check ? styles.inputCheck : null]}
        accessibilityLabel={`${label}${check ? ', please check this value' : ''}`}
        accessibilityHint={PROVENANCE_HINT[field.provenance]}
        testID={testID}
      />
    </View>
  );
}

export function PurchaseCandidateCard({
  candidate,
  photoUri,
  outcome,
  disabled,
  onToggle,
  onEdit,
  onUnits,
  onAddPhoto,
  onRemovePhoto,
}: {
  candidate: ReviewCandidate;
  photoUri: string | null;
  /** The last commit outcome for this line, when one exists. */
  outcome: 'added' | 'failed' | 'partial' | null;
  disabled: boolean;
  onToggle: () => void;
  onEdit: (field: EditableCandidateField, value: unknown) => void;
  onUnits: (units: number) => void;
  onAddPhoto: () => void;
  onRemovePhoto: () => void;
}) {
  const [editingPrice, setEditingPrice] = useState(false);
  const title = candidate.title.value ?? 'Unnamed item';
  const priceLabel =
    candidate.unitPrice.value !== null && candidate.currency.value
      ? formatCommercePrice(candidate.unitPrice.value, candidate.currency.value)
      : null;

  const notices: string[] = [];
  if (candidate.flags.transactionAmbiguous) notices.push('This may be an exchange. Select it only if you kept this item.');
  if (candidate.flags.possibleDuplicate) notices.push('An item with the same product code is already in your Closet. Select it if this is another one.');
  if (candidate.flags.lowConfidence) notices.push('Parts of this line were hard to read.');
  if (candidate.flags.priceInconsistent) notices.push('The price, quantity and total don’t add up. Check the price.');

  return (
    <View
      style={[styles.card, candidate.selected ? styles.cardSelected : null]}
      testID={`purchase-import-candidate-${candidate.lineIndex}`}
    >
      <Pressable
        onPress={() => {
          if (disabled) return;
          selectionTick();
          onToggle();
        }}
        style={styles.selectRow}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: candidate.selected, disabled }}
        accessibilityLabel={`${title}${candidate.selected ? ', will be added' : ', will not be added'}`}
        accessibilityHint="Double tap to include or exclude this item"
        testID={`purchase-import-candidate-toggle-${candidate.lineIndex}`}
      >
        <View style={[styles.checkbox, candidate.selected ? styles.checkboxOn : null]}>
          <Text style={styles.checkmark}>{candidate.selected ? '✓' : ''}</Text>
        </View>
        <View style={styles.selectText}>
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          {candidate.sourceLine ? (
            <Text style={styles.sourceLine} numberOfLines={2}>
              As printed: {candidate.sourceLine}
            </Text>
          ) : null}
        </View>
        {outcome ? (
          <Text
            style={[styles.outcome, outcome === 'added' ? styles.outcomeOk : styles.outcomeFail]}
            accessibilityLiveRegion="polite"
          >
            {outcome === 'added' ? 'Added' : outcome === 'partial' ? 'Partly added' : 'Not added'}
          </Text>
        ) : null}
      </Pressable>

      {notices.map((text) => (
        <Text key={text} style={styles.notice} accessibilityRole="text">
          ⚑ {text}
        </Text>
      ))}

      {candidate.selected ? (
        <View style={styles.fields}>
          <EditableRow
            label="Name"
            field={candidate.title}
            maxLength={200}
            onCommit={(v) => onEdit('title', v)}
            testID={`purchase-import-field-title-${candidate.lineIndex}`}
          />
          <EditableRow
            label="Brand"
            field={candidate.brand}
            maxLength={120}
            placeholder="Not on your document"
            onCommit={(v) => onEdit('brand', v)}
            testID={`purchase-import-field-brand-${candidate.lineIndex}`}
          />

          <View style={styles.row}>
            <Text style={styles.rowLabel}>Category</Text>
            <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel="Category">
              {PURCHASE_CLOSET_CATEGORIES.map((cat) => {
                const selected = candidate.category.value === cat;
                return (
                  <Pressable
                    key={cat}
                    onPress={() => onEdit('category', selected ? '' : cat)}
                    style={[styles.chip, selected ? styles.chipOn : null]}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    accessibilityLabel={cat}
                    testID={`purchase-import-category-${candidate.lineIndex}-${cat}`}
                  >
                    <Text style={[styles.chipText, selected ? styles.chipTextOn : null]}>{cat}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <EditableRow
            label="Type"
            field={candidate.subtype}
            maxLength={80}
            placeholder="e.g. ribbed tank"
            onCommit={(v) => onEdit('subtype', v)}
            testID={`purchase-import-field-subtype-${candidate.lineIndex}`}
          />
          <EditableRow
            label="Colour"
            field={candidate.primaryColor}
            maxLength={60}
            onCommit={(v) => onEdit('primaryColor', v)}
            testID={`purchase-import-field-color-${candidate.lineIndex}`}
          />
          <EditableRow
            label="Size purchased"
            field={candidate.size}
            maxLength={40}
            placeholder="As on the label, e.g. M or W32 L34"
            onCommit={(v) => onEdit('size', v)}
            testID={`purchase-import-field-size-${candidate.lineIndex}`}
          />

          <View style={styles.row}>
            <View style={styles.rowHeader}>
              <Text style={styles.rowLabel}>Price paid</Text>
              {candidate.unitPrice.uncertain || candidate.currency.uncertain ? (
                <Text style={styles.checkBadge} accessibilityElementsHidden importantForAccessibility="no">
                  ⚑ Check
                </Text>
              ) : null}
            </View>
            {priceLabel && !editingPrice ? (
              <Pressable
                onPress={() => setEditingPrice(true)}
                accessibilityRole="button"
                accessibilityLabel={`Price paid ${priceLabel}. Double tap to edit`}
                testID={`purchase-import-price-${candidate.lineIndex}`}
              >
                <Text style={styles.price}>{priceLabel}</Text>
              </Pressable>
            ) : candidate.flags.currencyAmbiguous && candidate.currencyOptions.length > 0 ? (
              <View>
                <Text style={styles.helper}>
                  The document shows a currency symbol several currencies share. Choose which one it is to keep
                  the price.
                </Text>
                <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel="Currency">
                  {candidate.currencyOptions.map((code) => (
                    <Pressable
                      key={code}
                      onPress={() => onEdit('currency', code)}
                      style={styles.chip}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: false }}
                      accessibilityLabel={code}
                      testID={`purchase-import-currency-${candidate.lineIndex}-${code}`}
                    >
                      <Text style={styles.chipText}>{code}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : (
              <PriceEditor
                amount={candidate.unitPrice.value}
                currency={candidate.currency.value}
                onSave={(amount, currency) => {
                  onEdit('unitPrice', amount);
                  onEdit('currency', currency);
                  setEditingPrice(false);
                }}
                lineIndex={candidate.lineIndex}
              />
            )}
          </View>

          {candidate.quantity > 1 ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>How many to add</Text>
              <View style={styles.stepper}>
                <Pressable
                  onPress={() => onUnits(candidate.unitsToAdd - 1)}
                  style={styles.stepButton}
                  accessibilityRole="button"
                  accessibilityLabel="Add one fewer"
                  testID={`purchase-import-units-minus-${candidate.lineIndex}`}
                >
                  <Text style={styles.stepText}>−</Text>
                </Pressable>
                <Text style={styles.stepValue} accessibilityLiveRegion="polite">
                  {candidate.unitsToAdd} of {candidate.quantity}
                </Text>
                <Pressable
                  onPress={() => onUnits(candidate.unitsToAdd + 1)}
                  style={styles.stepButton}
                  accessibilityRole="button"
                  accessibilityLabel="Add one more"
                  testID={`purchase-import-units-plus-${candidate.lineIndex}`}
                >
                  <Text style={styles.stepText}>+</Text>
                </Pressable>
              </View>
              <Text style={styles.helper}>Each one becomes its own Closet item.</Text>
            </View>
          ) : null}

          <View style={styles.photoRow}>
            {photoUri ? (
              <>
                <Image source={{ uri: photoUri }} style={styles.photo} accessibilityLabel="Garment photo you added" />
                <Pressable
                  onPress={onRemovePhoto}
                  accessibilityRole="button"
                  accessibilityLabel="Remove garment photo"
                  testID={`purchase-import-photo-remove-${candidate.lineIndex}`}
                >
                  <Text style={styles.link}>Remove photo</Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                onPress={onAddPhoto}
                style={styles.photoAdd}
                accessibilityRole="button"
                accessibilityLabel="Add a photo of this item, optional"
                accessibilityHint="A photo helps you recognise it in your Closet. You can skip this."
                testID={`purchase-import-photo-add-${candidate.lineIndex}`}
              >
                <Text style={styles.link}>+ Add a photo of the item</Text>
                <Text style={styles.helper}>Optional. Without one it’s added with a placeholder.</Text>
              </Pressable>
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function PriceEditor({
  amount,
  currency,
  onSave,
  lineIndex,
}: {
  amount: number | null;
  currency: string | null;
  onSave: (amount: string, currency: string) => void;
  lineIndex: number;
}) {
  const [value, setValue] = useState(amount !== null ? amount.toFixed(2) : '');
  const [code, setCode] = useState(currency ?? '');
  const valid = /^\d+(\.\d{1,2})?$/.test(value.replace(/,/g, '')) && /^[A-Za-z]{3}$/.test(code);
  return (
    <View style={styles.priceEditor}>
      <TextInput
        value={value}
        onChangeText={setValue}
        placeholder="Amount"
        placeholderTextColor={LUXURY.colors.stone}
        keyboardType="decimal-pad"
        style={[styles.input, styles.amountInput]}
        accessibilityLabel="Price paid amount"
        testID={`purchase-import-price-amount-${lineIndex}`}
      />
      <TextInput
        value={code}
        onChangeText={(t) => setCode(t.toUpperCase())}
        placeholder="USD"
        placeholderTextColor={LUXURY.colors.stone}
        autoCapitalize="characters"
        maxLength={3}
        style={[styles.input, styles.codeInput]}
        accessibilityLabel="Currency code, three letters"
        testID={`purchase-import-price-currency-${lineIndex}`}
      />
      <Pressable
        onPress={() => valid && onSave(value, code)}
        disabled={!valid}
        style={[styles.saveButton, !valid ? styles.saveDisabled : null]}
        accessibilityRole="button"
        accessibilityState={{ disabled: !valid }}
        accessibilityLabel="Save price"
        testID={`purchase-import-price-save-${lineIndex}`}
      >
        <Text style={styles.saveText}>Save</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.warmWhite,
    borderRadius: RADIUS.md,
    padding: SPACING.lg,
    gap: SPACING.sm,
  },
  cardSelected: { borderColor: LUXURY.colors.hairline, backgroundColor: LUXURY.colors.pearl },
  selectRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.md, minHeight: 44 },
  selectText: { flex: 1, gap: SPACING.xxs },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: LUXURY.colors.plum,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  checkboxOn: { backgroundColor: LUXURY.colors.plum },
  checkmark: { color: LUXURY.colors.inverse, fontSize: 15, fontWeight: '700', fontFamily: FONTS.sans },
  title: { fontFamily: FONTS.serif, fontSize: 18, lineHeight: 24, color: LUXURY.colors.ink },
  sourceLine: { fontFamily: FONTS.mono, fontSize: 12, color: LUXURY.colors.stone },
  outcome: { fontFamily: FONTS.sans, fontSize: 12, fontWeight: '700', letterSpacing: 0.6 },
  outcomeOk: { color: LUXURY.colors.success },
  outcomeFail: { color: LUXURY.colors.error },
  notice: { fontFamily: FONTS.sans, fontSize: 13, lineHeight: 19, color: LUXURY.colors.goldText },
  fields: { gap: SPACING.md, paddingTop: SPACING.sm },
  row: { gap: SPACING.xs },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, flexWrap: 'wrap' },
  rowLabel: { ...LUXURY.typography.sectionLabel, fontSize: 11, letterSpacing: 1.8 },
  checkBadge: {
    fontFamily: FONTS.sans,
    fontSize: 11,
    fontWeight: '700',
    color: LUXURY.colors.goldText,
    letterSpacing: 0.6,
  },
  provenance: { fontFamily: FONTS.sans, fontSize: 11, color: LUXURY.colors.stone, marginLeft: 'auto' },
  input: {
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    borderRadius: RADIUS.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    minHeight: 44,
    fontFamily: FONTS.sans,
    fontSize: 15,
    color: LUXURY.colors.ink,
    backgroundColor: LUXURY.colors.warmWhite,
  },
  inputCheck: { borderColor: LUXURY.colors.goldBrushed, borderWidth: 1.5 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
  chip: {
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    minHeight: 32,
    justifyContent: 'center',
  },
  chipOn: { backgroundColor: LUXURY.colors.plum, borderColor: LUXURY.colors.plum },
  chipText: { fontFamily: FONTS.sans, fontSize: 13, color: LUXURY.colors.graphite },
  chipTextOn: { color: LUXURY.colors.inverse },
  price: { fontFamily: FONTS.serif, fontSize: 18, color: LUXURY.colors.ink },
  helper: { fontFamily: FONTS.sans, fontSize: 12, lineHeight: 17, color: LUXURY.colors.stone },
  priceEditor: { flexDirection: 'row', gap: SPACING.sm, alignItems: 'center' },
  amountInput: { flex: 1 },
  codeInput: { width: 72, textAlign: 'center' },
  saveButton: {
    minHeight: 44,
    paddingHorizontal: SPACING.lg,
    borderRadius: RADIUS.sm,
    backgroundColor: LUXURY.colors.plum,
    justifyContent: 'center',
  },
  saveDisabled: { opacity: 0.4 },
  saveText: { color: LUXURY.colors.inverse, fontFamily: FONTS.sans, fontWeight: '600' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  stepButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: { fontSize: 20, color: LUXURY.colors.plum, fontFamily: FONTS.sans },
  stepValue: { fontFamily: FONTS.sans, fontSize: 15, color: LUXURY.colors.ink, minWidth: 64, textAlign: 'center' },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  photo: { width: 56, height: 56, borderRadius: RADIUS.sm },
  photoAdd: { gap: SPACING.xxs, paddingVertical: SPACING.xs },
  link: { fontFamily: FONTS.sans, fontSize: 14, fontWeight: '600', color: LUXURY.colors.plum },
});
