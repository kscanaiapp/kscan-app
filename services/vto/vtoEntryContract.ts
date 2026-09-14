/**
 * The typed VTO entry contract -- the ONLY thing a Commerce/product surface
 * is allowed to know about Virtual Try-On.
 *
 * THE BOUNDARY THIS DRAWS. A product surface supplies a VERIFIED PRODUCT
 * REFERENCE and renders a VTO-owned component. It never learns, and must
 * never be able to learn:
 *
 *   - an `assetKey` or any bundled-asset identity
 *   - that MediaPipe, a pose model, or a camera exists
 *   - a native capability shape, a permission state, or a runtime version
 *   - clean-frame / person-frame internals
 *   - a provider name, endpoint, credential, or quota
 *
 * and conversely VTO never learns, and must never be able to learn, anything
 * Commerce owns: price, currency, stock, availability, retailer choice,
 * ranking, or where "Shop" goes. Those arrive as opaque callbacks the product
 * surface already owns (`onShop`, `onWatch`), and VTO calls them without
 * inspecting them.
 *
 * WHY A CONTRACT RATHER THAN A CONVENTION. Both halves of that boundary were
 * previously enforced only by review. `__tests__/vtoEntryContract.test.js`
 * asserts it mechanically: the shared surfaces may import the VTO entry
 * component and this contract's types, and nothing else from `services/vto/`
 * or `types/vtoLive`.
 *
 * NOTE ON `productRef`. It is a correlation handle for the commerce candidate
 * the customer is looking at -- never an authorization input. The server
 * re-derives eligibility and takes actor identity from the verified JWT.
 */

import type { VtoGarmentInput, VtoOrigin } from '../../types/vto';
import type { VtoMode, VtoModeDecision } from './vtoModeAuthority';

/**
 * The verified product reference a product surface hands to VTO.
 *
 * Deliberately the EXISTING `VtoGarmentInput` produced by the one shared
 * derivation (services/vto/vtoCommerceGarment.ts) rather than a new shape: a
 * second product-identity type is exactly how "product A's try-on" becomes
 * product B's.
 */
export type VerifiedProductRef = VtoGarmentInput;

/** Opaque handle to a try-on the customer already started. VTO owns what is
 *  inside it; a product surface may only carry it back. */
export interface VtoSessionRef {
  /** The product the session is anchored to. */
  productRef: string;
  /** The mode it was started in. */
  mode: Exclude<VtoMode, 'UNAVAILABLE'>;
  /** Where it was started from, for telemetry only. */
  origin: VtoOrigin;
}

/** Outcome of asking VTO to begin. Never throws: a surface that cannot start
 *  a try-on gets a reason, not an exception in an event handler. */
export type VtoStartOutcome =
  | { started: true; session: VtoSessionRef }
  | { started: false; reason: 'mode_unavailable' | 'product_reference_invalid' };

/**
 * What a VTO entry point implements. One object, three questions, no leakage
 * in either direction.
 */
export interface VtoEntryContract {
  /** The single mode authority's answer for this product. Cheap, synchronous,
   *  static-facts-only -- safe to call during render. */
  resolveMode(product: VerifiedProductRef): VtoModeDecision;
  /** Begin a try-on in a mode `resolveMode` already returned. Refuses any
   *  mode that is not currently on offer rather than trusting the caller. */
  startTryOn(product: VerifiedProductRef, decision: VtoModeDecision): VtoStartOutcome;
  /** Re-open a try-on the customer minimized or navigated away from. */
  resumeTryOn(session: VtoSessionRef): VtoStartOutcome;
}

/**
 * Builds a session handle from an accepted decision, and refuses everything
 * else. The refusal is the point: `startTryOn` must not be able to open a
 * Live surface for a product whose decision said PHOTOREAL_STILL, or open
 * anything at all for UNAVAILABLE -- even if a caller passes a stale
 * decision object from a previous product.
 */
export function sessionRefForDecision(
  product: VerifiedProductRef | null | undefined,
  decision: VtoModeDecision,
  origin: VtoOrigin,
): VtoStartOutcome {
  const productRef =
    product && typeof product.productRef === 'string' && product.productRef.trim()
      ? product.productRef.trim()
      : null;
  if (!productRef) return { started: false, reason: 'product_reference_invalid' };
  // A decision about a DIFFERENT product cannot start this one. This is the
  // structural half of the product-switch safety rule: a stale decision is
  // refused here, not merely superseded later.
  if (decision.productRef !== productRef) {
    return { started: false, reason: 'product_reference_invalid' };
  }
  if (decision.mode === 'UNAVAILABLE') return { started: false, reason: 'mode_unavailable' };
  return { started: true, session: { productRef, mode: decision.mode, origin } };
}
