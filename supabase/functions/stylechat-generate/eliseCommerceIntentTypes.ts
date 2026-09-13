/**
 * The one shape this function shares with #409's Commerce intent reducer.
 *
 * Declared structurally rather than imported: `stylechat-generate` and
 * `scan-identify` are separate Edge Function bundles, and a cross-bundle
 * import would drag the whole Commerce tree into this function's deploy. The
 * consumer (`commerceShoppingIntent.parseContextContributions`) re-validates
 * every field it receives, so this is a transport shape, not a trust boundary.
 */
export interface IntentContribution {
  provenance: 'USER_EXPLICIT' | 'PACKING' | 'CONCIERGE' | 'SCANNER' | 'CLOSET' | 'SIGNATURE_STYLE' | 'DERIVED';
  actorId?: string | null;
  category?: string;
  subtype?: string;
  color?: string;
  material?: string;
  silhouette?: string;
  pattern?: string;
  occasion?: string;
  formality?: string;
  functionalRequirements?: string[];
  budgetCeiling?: { amount: number; currency: string };
  exclusions?: Array<{ axis: 'material' | 'color' | 'attribute'; token: string }>;
  relevantOwned?: Array<{ descriptor: string; category?: string | null; color?: string | null; material?: string | null }>;
  matchIntent?: 'exact' | 'substitute';
  signatureStyleTokens?: string[];
  gapRelationship?: { gapCode: string; label: string; certainty: 'confirmed' | 'unconfirmed' };
}
