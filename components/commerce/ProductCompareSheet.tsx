/**
 * Compare 2-3 offers already on the shelf (Build 35 Commerce UX §21-23).
 *
 * LOCAL AND READ-ONLY. Every cell comes from `buildCompareRows`, which reads
 * only facts the offers already carry; a fact no offer carries is not a row,
 * and a fact one offer lacks reads "Not listed" -- never estimated, never
 * lifted out of a retailer title, never asked of a model. Opening this sheet
 * makes no request.
 *
 * NO SECOND ACTION IMPLEMENTATION. Shop, Save and Watch are handed in by the
 * shelf that owns them (`renderActions`), bound to the exact product object in
 * that column, so a Compare tap and a card tap are the same call.
 */

import React from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { COLORS, LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { MODAL_MAX_WIDTH } from '../../services/responsiveLayout';
import {
  buildCompareRows,
  type ShelfOfferFacts,
} from '../../services/commerce/productShelfPresentation';

export interface CompareAction {
  label: string;
  /** null = a state, not an action (e.g. "Watching"). */
  onPress: (() => void) | null;
  emphasis?: 'primary' | 'secondary';
}

export interface CompareColumnActions {
  primary: CompareAction | null;
  save: CompareAction | null;
  watch: CompareAction | null;
}

export const COMPARE_NOT_LISTED = 'Not listed';

export function ProductCompareSheet({
  visible,
  products,
  retailerOf,
  onClose,
  renderActions,
}: {
  visible: boolean;
  products: ShelfOfferFacts[];
  retailerOf: (product: ShelfOfferFacts) => string | null;
  onClose: () => void;
  renderActions: (product: ShelfOfferFacts, index: number) => CompareColumnActions | null;
}) {
  if (!visible || products.length < 2) return null;
  const rows = buildCompareRows(products, retailerOf);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal testID="product-compare-sheet">
          <Text style={styles.title} accessibilityRole="header">
            Compare
          </Text>
          <Text style={styles.subtitle}>
            Only what the listings state. Anything a retailer didn't list reads “{COMPARE_NOT_LISTED}”.
          </Text>

          <ScrollView style={styles.table} contentContainerStyle={styles.tableContent}>
            {rows.map((row) => (
              <View key={row.label} style={styles.row} testID={`compare-row-${row.label}`}>
                <Text style={styles.rowLabel}>{row.label.toUpperCase()}</Text>
                <View style={styles.cells}>
                  {row.values.map((value, index) => (
                    <Text
                      // Column order is selection order; the index is stable
                      // for the life of this sheet.
                      key={`${row.label}-${index}`}
                      style={[styles.cell, value === null && styles.cellMissing]}
                      accessibilityLabel={`${row.label}, option ${index + 1}: ${value ?? COMPARE_NOT_LISTED}`}
                    >
                      {value ?? COMPARE_NOT_LISTED}
                    </Text>
                  ))}
                </View>
              </View>
            ))}

            <View style={styles.row}>
              <Text style={styles.rowLabel}>ACTIONS</Text>
              <View style={styles.cells}>
                {products.map((product, index) => {
                  const actions = renderActions(product, index);
                  return (
                    <View key={`actions-${index}`} style={styles.actionCell}>
                      {actions?.primary?.onPress ? (
                        <TouchableOpacity
                          style={actions.primary.emphasis === 'primary' ? styles.primaryButton : styles.secondaryButton}
                          onPress={actions.primary.onPress}
                          accessibilityRole="link"
                          accessibilityLabel={`${actions.primary.label}, option ${index + 1}`}
                          testID={`compare-primary-${index}`}
                        >
                          <Text
                            style={actions.primary.emphasis === 'primary' ? styles.primaryText : styles.secondaryText}
                            numberOfLines={2}
                          >
                            {actions.primary.label}
                          </Text>
                        </TouchableOpacity>
                      ) : null}
                      {[actions?.save, actions?.watch].map((action, actionIndex) =>
                        action ? (
                          action.onPress ? (
                            <TouchableOpacity
                              key={`${action.label}-${actionIndex}`}
                              style={styles.secondaryButton}
                              onPress={action.onPress}
                              accessibilityRole="button"
                              accessibilityLabel={`${action.label}, option ${index + 1}`}
                              testID={`compare-${actionIndex === 0 ? 'save' : 'watch'}-${index}`}
                            >
                              <Text style={styles.secondaryText}>{action.label}</Text>
                            </TouchableOpacity>
                          ) : (
                            <Text
                              key={`${action.label}-${actionIndex}`}
                              style={styles.stateText}
                              testID={`compare-state-${index}`}
                            >
                              {action.label}
                            </Text>
                          )
                        ) : null,
                      )}
                    </View>
                  );
                })}
              </View>
            </View>
          </ScrollView>

          <TouchableOpacity
            style={styles.closeButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close comparison"
            testID="product-compare-close"
          >
            <Text style={styles.closeText}>CLOSE</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: COLORS.backdrop,
    padding: SPACING.lg,
  },
  card: {
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.lg,
    maxHeight: '88%',
    width: '100%',
    maxWidth: MODAL_MAX_WIDTH,
    alignSelf: 'center',
  },
  title: {
    ...LUXURY.typography.displayTitle,
    fontSize: 22,
  },
  subtitle: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    textTransform: 'none',
    marginTop: SPACING.xs,
    marginBottom: SPACING.md,
    lineHeight: 16,
  },
  table: {
    flexGrow: 0,
  },
  tableContent: {
    gap: SPACING.md,
    paddingBottom: SPACING.sm,
  },
  row: {
    borderBottomWidth: 1,
    borderBottomColor: LUXURY.colors.border,
    paddingBottom: SPACING.sm,
    gap: SPACING.xs,
  },
  rowLabel: {
    ...LUXURY.typography.sectionLabel,
    fontSize: 10,
  },
  cells: {
    flexDirection: 'row',
    gap: SPACING.sm,
  },
  cell: {
    ...LUXURY.typography.body,
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  cellMissing: {
    color: LUXURY.colors.stone,
    fontStyle: 'italic',
  },
  actionCell: {
    flex: 1,
    gap: SPACING.xs,
  },
  primaryButton: {
    minHeight: 44,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.plum,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xs,
  },
  primaryText: {
    ...LUXURY.typography.caption,
    color: COLORS.textInverse,
    fontSize: 10,
    textAlign: 'center',
  },
  secondaryButton: {
    minHeight: 44,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.plum,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xs,
  },
  secondaryText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    fontSize: 10,
    textAlign: 'center',
  },
  stateText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    textAlign: 'center',
    paddingVertical: SPACING.sm,
  },
  closeButton: {
    minHeight: 48,
    borderRadius: RADIUS.pill,
    borderWidth: 1.5,
    borderColor: LUXURY.colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: SPACING.md,
  },
  closeText: {
    ...LUXURY.typography.ctaSecondary,
  },
});
