/** Future policy contract only. No caller in organic retrieval or primary commerce. */
import { rankCatalog } from './engine.ts';
import type { CatalogRow, DiscoveryInput, DiscoveryProduct } from './contracts.ts';
export type FuturePlacementEvidence = {
  merchantAuthorized: boolean; agreementEffective: boolean; campaignApproved: boolean;
  liveCatalogProduct: boolean; fashionRelevancePassed: boolean; trustworthyOffer: boolean;
  marketAndInventoryPassed: boolean; disclosureApproved: boolean; disclosureText: string;
  productionActivationApproved: boolean;
};
export function futurePlacementRequirementsPass(e: FuturePlacementEvidence): boolean {
  return e.merchantAuthorized === true && e.agreementEffective === true && e.campaignApproved === true
    && e.liveCatalogProduct === true && e.fashionRelevancePassed === true && e.trustworthyOffer === true
    && e.marketAndInventoryPassed === true && e.disclosureApproved === true && e.disclosureText.trim().length > 0
    && e.productionActivationApproved === true;
}
/** Missing/true/false config all leave V1 inert. Activation is a separate release. */
export function sponsoredPlacementsEnabled(_configuredValue?: string): boolean { return false; }
export function selectSponsoredPlacements(_evidence: FuturePlacementEvidence[]): never[] { return []; }

export type TestCampaign = {
  id: string; partnerId: string; merchantId: string; state: string;
  productIds: string[]; categories: string[]; markets: string[];
  startsAt: string; endsAt: string; disclosureApproved: boolean; disclosureText: string;
};
export type TestPartner = {
  id: string; merchantId: string; status: string; contractStatus: string;
  agreementRef: string | null; effectiveFrom: string; effectiveUntil: string;
};
/** Executable, side-effect-free sponsorship certification seam. No endpoint,
 * database insertion, paid ranking bonus or production activation is provided.
 * Approved test campaigns exist only in the calling test's isolated memory. */
export const SPONSORED_DISCLOSURE = { label: 'Sponsored', explanation: 'Paid placement. Selected for relevance to your scan.' } as const;
export type SandboxContext = { environment: string; isolatedFixtures: boolean; staffAuthenticated: boolean; sponsoredEnabled: boolean; sandboxEnabled: boolean };
export function previewSponsoredPlacements(context: SandboxContext, input: DiscoveryInput, rows: CatalogRow[], partner: TestPartner, campaign: TestCampaign, now: number): SponsoredPreview[] {
  if (!['test','development','staging'].includes(context.environment) || context.isolatedFixtures !== true || context.staffAuthenticated !== true || context.sponsoredEnabled !== true || context.sandboxEnabled !== true) return [];
  return evaluateSponsorshipPolicy(input, rows, [partner], [campaign], now).placements;
}
export type SponsorshipReason = 'eligible' | 'no_campaign' | 'unapproved' | 'invalid_agreement' | 'inactive_period' | 'market_mismatch' | 'category_mismatch' | 'missing_disclosure' | 'invalid_offer' | 'relevance_failed' | 'timeout' | 'unavailable';
export type SponsorshipSnapshot = { rows: CatalogRow[]; partners: TestPartner[]; campaigns: TestCampaign[] };
function evaluateCampaign(input: DiscoveryInput, rows: CatalogRow[], partner: TestPartner | undefined, campaign: TestCampaign, now: number): { reason: SponsorshipReason; placements: SponsoredPreview[] } {
  const reject = (reason: SponsorshipReason) => ({ reason, placements: [] });
  if (campaign.state !== 'approved') return reject('unapproved');
  if (!partner || partner.id !== campaign.partnerId || partner.merchantId !== campaign.merchantId || partner.status !== 'active' || partner.contractStatus !== 'signed' || !partner.agreementRef) return reject('invalid_agreement');
  const dates = [partner.effectiveFrom, partner.effectiveUntil, campaign.startsAt, campaign.endsAt].map(Date.parse);
  if (dates.some((d) => !Number.isFinite(d)) || dates[0]>now || dates[1]<=now || dates[2]>now || dates[3]<=now) return reject('inactive_period');
  if (!campaign.disclosureApproved || typeof campaign.disclosureText !== 'string' || campaign.disclosureText.trim() !== SPONSORED_DISCLOSURE.label) return reject('missing_disclosure');
  if (!campaign.categories.includes(input.garment.item_type)) return reject('category_mismatch');
  if (!campaign.markets.includes(input.market)) return reject('market_mismatch');
  const candidates = rows.filter((r) => r.merchant_id === campaign.merchantId && campaign.productIds.includes(r.id)
    && r.price_amount != null && Number(r.price_amount)>0 && Number.isFinite(Number(r.price_amount)) && !!r.currency && /^[A-Z]{3}$/.test(r.currency));
  if (!candidates.length) return reject('invalid_offer');
  const placements: SponsoredPreview[] = rankCatalog(input, candidates, { discovery: true, badges: true, sponsored: false }, now)
    .map((product) => ({ ...product, placementType: 'sponsored' as const, campaignId: campaign.id, disclosure: SPONSORED_DISCLOSURE.label, previewOnly: true as const }));
  return { reason: placements.length ? 'eligible' : 'relevance_failed', placements };
}
export type SponsoredPreview = Omit<DiscoveryProduct,'placementType'> & { placementType: 'sponsored'; campaignId: string; disclosure: 'Sponsored'; previewOnly: true };
/** Shared pure evaluator for isolated DB tests and metadata-only shadow work.
 * Its results are never attached to live commerce responses. */
export function evaluateSponsorshipPolicy(input: DiscoveryInput, rows: CatalogRow[], partners: TestPartner[], campaigns: TestCampaign[], now: number): { reason: SponsorshipReason; placements: SponsoredPreview[] } {
  let reason: SponsorshipReason = 'no_campaign';
  for (const campaign of campaigns.slice(0,20)) {
    const decision = evaluateCampaign(input, rows, partners.find((p) => p.id === campaign.partnerId), campaign, now);
    if (decision.placements.length) return decision;
    reason = decision.reason;
  }
  return { reason, placements: [] };
}
