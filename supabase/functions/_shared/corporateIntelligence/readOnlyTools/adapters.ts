import {
  buildShoppingQuery,
  getShoppingResults,
  type ShoppingResult,
} from "../../../scan-identify/shoppingProvider.ts";
import {
  AGREEMENT_USABLE_THRESHOLD,
  scoreProductAgreement,
} from "../../../scan-identify/commerceRelevanceAgreement.ts";
import {
  createDiscoveryService,
  type DiscoveryDependencies,
} from "../../../black-owned-discovery/engine.ts";
import type {
  DiscoveryInput,
  DiscoveryResponse,
} from "../../../black-owned-discovery/contracts.ts";
import { type Search, ToolError } from "./request.ts";

export type Provider = "serper" | "brave" | "eligible_catalog";
/** Reserved for normalization/response after the shopping service returns. */
export const PRIMARY_MARGIN_MS = 150;
export type Batch = {
  provider: Provider | "none";
  products: unknown[];
  serviceCalls: number;
  providerCallCeiling: number;
  cacheHit: boolean | null;
};
/** Server code supplies these ports; none is selected or constructed from model arguments. */
export type Adapters = {
  shopping: (
    input: Search,
    timeoutMs: number,
    signal: AbortSignal,
  ) => Promise<Batch>;
  blackOwned: (input: Search, signal: AbortSignal) => Promise<Batch>;
};
export function createExistingAdapters(deps: {
  discovery: DiscoveryDependencies;
  /** Injectable existing service for offline verification. Production uses getShoppingResults. */
  shopping?: typeof getShoppingResults;
}): Adapters {
  return {
    shopping: async (input, timeoutMs, signal) => {
      if (signal.aborted) throw new ToolError("deadline");
      // Market is explicit search data, never a provider/country credential selector.
      const attributes = buildShoppingQuery({
        category: input.garment.subtype ?? input.garment.item_type,
        color: input.garment.primary_color,
        material: input.garment.material_estimate,
        silhouette: input.garment.silhouette,
        style: input.garment.distinctive_features?.join(" "),
      });
      const query = buildShoppingQuery({
        searchQueries: [
          [input.market, input.intent, attributes].filter(Boolean).join(" "),
        ],
      });
      const result: ShoppingResult =
        await (deps.shopping ?? getShoppingResults)({
          query,
          limit: 8,
          // Live Staging evidence (Build 35 probe): halving the remaining turn
          // budget left the primary provider ~1 s and it timed out, while the
          // web-search fallback's page results never survive relevance.
          // The primary now gets the remaining budget less a small margin; the
          // broker's 2,500 ms deadline still bounds the whole turn.
          timeoutMs: Math.max(1, Math.floor(timeoutMs - PRIMARY_MARGIN_MS)),
        });
      if (signal.aborted) throw new ToolError("deadline");
      if (!result || !Array.isArray(result.products)) {
        throw new ToolError("malformed_provider");
      }
      if (
        result.provider === "none" && result.products.length === 0 &&
        result.errorType === "no_results"
      ) {
        return {
          provider: "none",
          products: [],
          serviceCalls: 1,
          providerCallCeiling: 2,
          cacheHit: null,
        };
      }
      if (result.errorType) throw new ToolError("provider_failure");
      if (!["serper", "brave"].includes(result.provider)) {
        throw new ToolError("malformed_provider");
      }
      return {
        provider: result.provider as Provider,
        products: result.products,
        serviceCalls: 1,
        providerCallCeiling: 2,
        cacheHit: null,
      };
    },
    blackOwned: async (input, signal) => {
      // Retain the eligibility horizon from authoritative rows: the public discovery
      // response intentionally omits it, but session comparison must never outlive it.
      const horizons = new Map<string, number>();
      const discover = createDiscoveryService({
        ...deps.discovery,
        candidates: async (...args) => {
          const snapshot = await deps.discovery.candidates(...args);
          if (
            !Array.isArray(snapshot.rows) || snapshot.rows.length > 160
          ) throw new ToolError("malformed_provider");
          for (const row of snapshot.rows) {
            horizons.set(
              row.id,
              Math.min(
                Date.parse(row.expires_at),
                Date.parse(row.verified_until),
                Date.parse(row.synced_at) + 86_400_000,
                row.eligible_until ? Date.parse(row.eligible_until) : Infinity,
              ),
            );
          }
          return snapshot;
        },
      });
      const request: DiscoveryInput = {
        garment: input.garment,
        market: input.market,
        primaryProducts: [],
      };
      const result: DiscoveryResponse = await discover(request, {
        discovery: true,
        badges: true,
        sponsored: false,
      }, signal);
      if (result.status === "unavailable") {
        throw new ToolError("provider_failure");
      }
      return {
        provider: "eligible_catalog",
        products: result.products.map((p) => ({
          ...p,
          eligibleUntil: horizons.get(p.id),
        })),
        serviceCalls: 1,
        providerCallCeiling: 0,
        cacheHit: false,
      };
    },
  };
}
export function relevant(
  product: Parameters<typeof scoreProductAgreement>[0],
  input: Search,
): boolean {
  const result = scoreProductAgreement(product, input.garment);
  return !result.clearCategoryConflict &&
    result.score >= AGREEMENT_USABLE_THRESHOLD;
}

/** Refinement filters require literal provider-title evidence; similarity alone cannot satisfy a requested change. */
export function matchesRefinement(title: string, input: Search): boolean {
  const words = (value: string) =>
    value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const evidence = ` ${words(title)} `;
  return [
    input.garment.subtype,
    input.garment.primary_color,
    input.garment.material_estimate,
    input.garment.silhouette,
  ]
    .filter((value): value is string => Boolean(value))
    .every((value) => evidence.includes(` ${words(value)} `));
}
