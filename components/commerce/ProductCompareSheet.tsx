import React from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { COLORS, LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { MODAL_MAX_WIDTH } from '../../services/responsiveLayout';
import { buildCompareRows, type ShelfOfferFacts } from '../../services/commerce/productShelfPresentation';

export const COMPARE_NOT_LISTED = 'Not listed';

export function ProductCompareSheet({
  visible, products, retailerOf, onClose,
}: {
  visible: boolean;
  products: ShelfOfferFacts[];
  retailerOf: (product: ShelfOfferFacts) => string | null;
  onClose: () => void;
}) {
  if (!visible || products.length < 2) return null;
  const rows = buildCompareRows(products, retailerOf);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal testID="product-compare-sheet">
          <Text style={styles.title} accessibilityRole="header">Compare</Text>
          <Text style={styles.subtitle}>Only facts carried by these listings are compared. Missing facts stay missing.</Text>
          <ScrollView style={styles.table} contentContainerStyle={styles.tableContent}>
            {rows.map((row) => (
              <View key={row.label} style={styles.row} testID={`compare-row-${row.label}`}>
                <Text style={styles.rowLabel}>{row.label.toUpperCase()}</Text>
                <View style={styles.cells}>
                  {row.values.map((value, index) => (
                    <Text
                      key={`${row.label}-${index}`}
                      style={[styles.cell, value == null && styles.cellMissing]}
                      accessibilityLabel={`${row.label}, option ${index + 1}: ${value ?? COMPARE_NOT_LISTED}`}
                    >
                      {value ?? COMPARE_NOT_LISTED}
                    </Text>
                  ))}
                </View>
              </View>
            ))}
          </ScrollView>
          <TouchableOpacity style={styles.closeButton} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close comparison">
            <Text style={styles.closeText}>CLOSE</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop:{flex:1,justifyContent:'flex-end',backgroundColor:COLORS.backdrop,padding:SPACING.lg},
  card:{borderRadius:RADIUS.xl,borderWidth:1,borderColor:LUXURY.colors.border,backgroundColor:LUXURY.colors.pearl,padding:SPACING.lg,maxHeight:'88%',width:'100%',maxWidth:MODAL_MAX_WIDTH,alignSelf:'center'},
  title:{...LUXURY.typography.displayTitle,fontSize:22},
  subtitle:{...LUXURY.typography.caption,color:LUXURY.colors.stone,textTransform:'none',marginTop:SPACING.xs,marginBottom:SPACING.md,lineHeight:16},
  table:{flexGrow:0},tableContent:{gap:SPACING.md,paddingBottom:SPACING.sm},
  row:{borderBottomWidth:1,borderBottomColor:LUXURY.colors.border,paddingBottom:SPACING.sm,gap:SPACING.xs},
  rowLabel:{...LUXURY.typography.sectionLabel,fontSize:10},cells:{flexDirection:'row',gap:SPACING.sm},
  cell:{...LUXURY.typography.body,flex:1,fontSize:13,lineHeight:18},
  cellMissing:{color:LUXURY.colors.stone,fontStyle:'italic'},
  closeButton:{minHeight:48,borderRadius:RADIUS.pill,borderWidth:1.5,borderColor:LUXURY.colors.gold,alignItems:'center',justifyContent:'center',marginTop:SPACING.md},
  closeText:{...LUXURY.typography.ctaSecondary},
});
