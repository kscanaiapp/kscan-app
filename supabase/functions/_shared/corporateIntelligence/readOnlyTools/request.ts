import { sanitizeGarment } from "../../../black-owned-discovery/validation.ts";
import type { FashionAttributes } from "../../../black-owned-discovery/contracts.ts";

export const TOOL_VERSION = "oc-read-only-v1" as const;
export const TOOL_REGISTRY = Object.freeze({
  discover_products: Object.freeze({
    readOnly: true,
    provider: "scanner_shopping",
  }),
  refine_products: Object.freeze({
    readOnly: true,
    provider: "scanner_shopping",
  }),
  discover_black_owned: Object.freeze({
    readOnly: true,
    provider: "eligible_catalog",
  }),
  compare_products: Object.freeze({
    readOnly: true,
    provider: "session_records",
  }),
});
export type Capability = keyof typeof TOOL_REGISTRY;
export type Search = {
  garment: FashionAttributes;
  market: string;
  intent?: string;
  maxPrice?: number;
  currency?: string;
};
export type ToolRequest =
  | {
    version: typeof TOOL_VERSION;
    capability: "discover_products" | "discover_black_owned";
    arguments: Search;
  }
  | {
    version: typeof TOOL_VERSION;
    capability: "refine_products";
    arguments: Search & {
      previousRefs: string[];
      excludePreviousMerchants?: boolean;
    };
  }
  | {
    version: typeof TOOL_VERSION;
    capability: "compare_products";
    arguments: { productRefs: string[] };
  };
export type Failure =
  | "invalid_request"
  | "unknown_capability"
  | "invalid_arguments"
  | "forbidden_text"
  | "disabled"
  | "unauthorized"
  | "limit"
  | "busy"
  | "deadline"
  | "foreign_or_stale_reference"
  | "provider_failure"
  | "malformed_provider";
export class ToolError extends Error {
  constructor(public readonly code: Failure) {
    super(code);
  }
}
function object(v: unknown): Record<string, unknown> {
  if (
    !v || typeof v !== "object" || Array.isArray(v) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(v))
  ) throw new ToolError("invalid_arguments");
  return v as Record<string, unknown>;
}
function closed(v: Record<string, unknown>, keys: string[]) {
  if (Object.keys(v).some((k) => !keys.includes(k))) {
    throw new ToolError("invalid_arguments");
  }
}
function refs(v: unknown, minimum = 2): string[] {
  if (
    !Array.isArray(v) || v.length < minimum || v.length > 8 ||
    v.some((r) => typeof r !== "string" || !/^p_[a-f0-9-]{36}$/.test(r)) ||
    new Set(v).size !== v.length
  ) throw new ToolError("invalid_arguments");
  return [...v];
}
/** Text is search data only. This conservative screen is defense in depth, never an authorization control. */
function searchText(v: unknown): string {
  if (
    typeof v !== "string" || !v.trim() || v.length > 160 ||
    !/^[\p{L}\p{N} ,.'()&+-]+$/u.test(v) ||
    /\b(ignore|instructions?|system|developer|credentials?|tokens?|permissions?|sql|rpc|https?|verified|black.owned|purchase|checkout)\b/i
      .test(v)
  ) throw new ToolError("forbidden_text");
  return v.trim();
}
export function parseToolRequest(
  value: unknown,
  allowedMarkets: readonly string[],
): ToolRequest {
  const v = object(value);
  closed(v, ["version", "capability", "arguments"]);
  if (v.version !== TOOL_VERSION) throw new ToolError("invalid_request");
  if (
    typeof v.capability !== "string" ||
    !Object.hasOwn(TOOL_REGISTRY, v.capability)
  ) throw new ToolError("unknown_capability");
  const a = object(v.arguments);
  if (v.capability === "compare_products") {
    closed(a, ["productRefs"]);
    return {
      version: TOOL_VERSION,
      capability: v.capability,
      arguments: { productRefs: refs(a.productRefs) },
    };
  }
  const refine = v.capability === "refine_products";
  closed(a, [
    "garment",
    "market",
    "intent",
    "maxPrice",
    "currency",
    ...(refine ? ["previousRefs", "excludePreviousMerchants"] : []),
  ]);
  if (
    typeof a.market !== "string" || !/^[A-Z]{2}$/.test(a.market) ||
    !allowedMarkets.includes(a.market)
  ) throw new ToolError("invalid_arguments");
  const g = object(a.garment);
  for (const val of Object.values(g)) {
    if (Array.isArray(val)) val.forEach(searchText);
    else searchText(val);
  }
  let garment: FashionAttributes;
  try {
    garment = sanitizeGarment(g);
  } catch {
    throw new ToolError("invalid_arguments");
  }
  if (
    a.maxPrice !== undefined &&
    (typeof a.maxPrice !== "number" || !Number.isFinite(a.maxPrice) ||
      a.maxPrice <= 0 || a.maxPrice > 100_000 || typeof a.currency !== "string")
  ) throw new ToolError("invalid_arguments");
  if (
    a.currency !== undefined &&
    (typeof a.currency !== "string" || !/^[A-Z]{3}$/.test(a.currency))
  ) throw new ToolError("invalid_arguments");
  const args: Search = {
    garment,
    market: a.market,
    ...(a.intent === undefined ? {} : { intent: searchText(a.intent) }),
    ...(a.maxPrice === undefined ? {} : { maxPrice: a.maxPrice as number }),
    ...(a.currency === undefined ? {} : { currency: a.currency as string }),
  };
  if (refine) {
    if (
      a.excludePreviousMerchants !== undefined &&
      typeof a.excludePreviousMerchants !== "boolean"
    ) throw new ToolError("invalid_arguments");
    return {
      version: TOOL_VERSION,
      capability: "refine_products",
      arguments: {
        ...args,
        previousRefs: refs(a.previousRefs, 1),
        ...(a.excludePreviousMerchants === undefined
          ? {}
          : { excludePreviousMerchants: a.excludePreviousMerchants }),
      },
    };
  }
  return {
    version: TOOL_VERSION,
    capability: v.capability as "discover_products" | "discover_black_owned",
    arguments: args,
  };
}
