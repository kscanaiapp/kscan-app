/**
 * Scanner-only multi-item brand observations (#612).
 *
 * Kept in its own module, imported ONLY by scan-identify/index.ts, so adding
 * it does not change the deployable source closure of any other function that
 * shares ./brandEvidence.ts. The existing quality gate (brandEvidence.ts and
 * scannerQualityGate.ts) still demands a confidently attributed visible logo
 * or readable wordmark; this module only lets the strict multi-item response
 * schema carry those optional observations to the existing sanitizer.
 */
export const SCANNER_MULTI_ITEM_BRAND_ADDENDUM = [
  'For EACH detectedGarments candidate, inspect only its visible area for legible wordmarks or a distinctive brand logo.',
  'Optional fields on that garment: visible_brand_text, logo_detected, logo_brand, logo_description, logo_confidence (low, medium, high).',
  'A generic letter or decoration is not proof of a brand. Do not infer a brand from a garment silhouette or aesthetic.',
  'Do not borrow evidence from another garment or background object. If uncertain, omit the optional brand fields.',
  'A visible logo cannot establish an exact model, SKU, price or retailer. Do not run shopping during detection.',
].join('\n');

/** Flag OFF returns the identical prompt string. */
export function withScannerMultiItemBrandPrompt(base: string, enabled: boolean): string {
  return enabled ? base + '\n' + SCANNER_MULTI_ITEM_BRAND_ADDENDUM : base;
}

/** Flag OFF returns the identical schema object. New fields remain optional. */
export function withScannerMultiItemBrandSchema<
  T extends { properties: { detectedGarments: { items: { properties: object; required: readonly string[] } } } },
>(schema: T, enabled: boolean): T {
  if (!enabled) return schema;
  const garments = schema.properties.detectedGarments;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      detectedGarments: {
        ...garments,
        items: {
          ...garments.items,
          properties: {
            ...garments.items.properties,
            visible_brand_text: { type: 'STRING' },
            logo_detected: { type: 'BOOLEAN' },
            logo_brand: { type: 'STRING' },
            logo_description: { type: 'STRING' },
            logo_confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
          },
        },
      },
    },
  } as T;
}
