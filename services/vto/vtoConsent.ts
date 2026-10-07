/**
 * The wording and the gate for VTO's third-party AI consent.
 *
 * WHY THIS EXISTS. Virtual Try-On sends a photo the customer chose of
 * themselves -- which may show their face or body -- through K Scan's server to
 * an external AI service. Before this module the customer was shown one passive
 * sentence that disappeared once a photo was chosen, and was never asked at the
 * moment the photo left the device. The sheet now asks first
 * (components/vto/VtoConsentStep.tsx), and the store refuses the real transport
 * without a proof that the customer said yes (services/vto/vtoRequestStore.ts).
 *
 * VTO_CONSENT_COPY_LEGAL_REVIEW_REQUIRED=YES. The MECHANISM ships now: the ask,
 * the record, the gate. The final WORDING is counsel and owner review, and this
 * text is neutral and factual on purpose -- it states what is sent, to whom and
 * why, and it makes no claim about how long the service keeps anything, because
 * this repository holds no contract that says. Any change to the wording, to the
 * provider disclosures or to anything else the customer is shown MUST bump
 * VTO_CONSENT_VERSION, so that every customer who accepted the old wording is
 * asked again. __tests__/vtoThirdPartyConsent.test.js pins the wording, the
 * disclosures, the Privacy Policy link and the version by digest and fails until
 * the version is bumped.
 *
 * SINGLE SOURCE. The consent step and the tests read the copy from here. The
 * provider names are built from VTO_PROVIDER_DISCLOSURES below, so a new provider
 * changes the words the customer reads instead of being sent to silently.
 *
 * PURE. The only import is the shared consent service, which owns persistence.
 * This module holds no storage and no network client, which is what lets it be
 * enrolled in the VTO import allowlist without an exemption.
 */

import {
  hasThirdPartyAiConsentNow,
  loadThirdPartyAiConsent,
  recordThirdPartyAiConsent,
  type ThirdPartyAiFeature,
} from '../thirdPartyAiConsent';

export const VTO_CONSENT_FEATURE: ThirdPartyAiFeature = 'virtual_try_on';

/**
 * The version of the wording, the provider disclosures and everything else the
 * customer agrees to. Bump it on ANY change to them.
 */
export const VTO_CONSENT_VERSION = 'vto-third-party-v2';

/*
 * VERSION HISTORY
 *   v1  "...the photo you chose, together with the product image..."
 *   v2  Names BOTH images that leave the device -- the photo of the customer
 *       that they selected and the garment image that they selected -- and the
 *       recipient as a virtual try-on AI service. A garment can now come from a
 *       photo the customer gave Elise, so it is not always a product image, and
 *       it is sent as it is: it can include people or background content, which
 *       K Scan AI does not remove. The copy says so.
 *       No claim about retention was added or removed, and nothing here claims
 *       garment-only processing. Everyone who accepted v1 is asked again.
 *       v2 was finalized before it ever shipped, which is why its wording
 *       changed once under one version. From the first release that carries it,
 *       any further change bumps the version.
 *       VTO_CONSENT_COPY_LEGAL_REVIEW_REQUIRED remains YES.
 */

/** The Privacy Policy the consent step links to. */
export const VTO_PRIVACY_POLICY_URL = 'https://kscan.app/legal/privacy';

export interface VtoProviderDisclosure {
  /** The company that runs the generation. */
  readonly vendor: string;
  /** The gateway the request travels through to reach it. */
  readonly gateway: string;
}

/**
 * Who a customer's photo can be sent to, keyed by the SERVER's provider id
 * (supabase/functions/vto-generate/providers). Closed on purpose: a provider the
 * server can call but this map does not name is a recipient the consent copy
 * never disclosed, and __tests__/vtoThirdPartyConsent.test.js fails until the
 * two agree.
 */
export const VTO_PROVIDER_DISCLOSURES: Readonly<Record<string, VtoProviderDisclosure>> = Object.freeze({
  ailabtools_tryon_clothes_pro: Object.freeze({ vendor: 'AILabTools', gateway: 'RapidAPI' }),
});

const INTRO_LEAD =
  'To create your try-on, K Scan AI sends the photo of yourself that you selected and the garment image that you selected to an external virtual try-on AI service: ';

/** The intro sentence, with every disclosed provider named. */
export function buildVtoConsentIntro(
  disclosures: Readonly<Record<string, VtoProviderDisclosure>> = VTO_PROVIDER_DISCLOSURES,
): string {
  const recipients = Object.values(disclosures).map((entry) => `${entry.vendor}, through ${entry.gateway}`);
  const named = recipients.length <= 1
    ? recipients.join('')
    : `${recipients.slice(0, -1).join('; ')}; or ${recipients[recipients.length - 1]}`;
  return `${INTRO_LEAD}${named}.`;
}

export interface VtoConsentCopy {
  readonly title: string;
  readonly intro: string;
  readonly points: readonly string[];
  readonly policyLinkLabel: string;
  readonly continueLabel: string;
  readonly continueA11yLabel: string;
  readonly cancelLabel: string;
  readonly persistFailure: string;
}

export const VTO_CONSENT_COPY: VtoConsentCopy = Object.freeze({
  title: 'Send your photo and the garment image to an AI service?',
  intro: buildVtoConsentIntro(),
  points: Object.freeze([
    'Purpose: to generate an AI visualization of this item on your photo.',
    'Your photo may show your face or body. K Scan AI removes its metadata first, but does not blur or mask it.',
    'The garment image is sent as it is. It can include people or background content, and K Scan AI does not remove them.',
    'K Scan AI does not add your photo or the result to your Closet. How long the service keeps them is set by its own privacy policy.',
  ]),
  policyLinkLabel: 'Read the K Scan AI Privacy Policy',
  continueLabel: 'Continue',
  continueA11yLabel: 'Continue and send my photo and the garment image',
  cancelLabel: 'Cancel',
  persistFailure: 'We could not save your choice, so nothing was sent. Please try again.',
});

/**
 * Synchronous: has the current account agreed to THIS wording? The check every
 * transmission runs at the moment of the tap.
 */
export function hasVtoConsent(): boolean {
  return hasThirdPartyAiConsentNow(VTO_CONSENT_FEATURE, VTO_CONSENT_VERSION);
}

/** Warms the answer from device storage, ahead of the tap. */
export function loadVtoConsent(): Promise<boolean> {
  return loadThirdPartyAiConsent(VTO_CONSENT_FEATURE, VTO_CONSENT_VERSION);
}

/** Records the current account's agreement. Resolves false if it could not be saved. */
export function grantVtoConsent(): Promise<boolean> {
  return recordThirdPartyAiConsent(VTO_CONSENT_FEATURE, VTO_CONSENT_VERSION);
}
