import { createDiscoveryAuthenticator } from "../../../black-owned-discovery/accountAuthorization.ts";
import type { Adapters, Batch } from "./adapters.ts";
import { matchesRefinement, relevant } from "./adapters.ts";
import {
  amount,
  asRecommended,
  identity,
  normalizeProduct,
  type Product,
} from "./products.ts";
import {
  type Capability,
  type Failure,
  parseToolRequest,
  TOOL_VERSION,
  ToolError,
} from "./request.ts";

export const LIMITS = Object.freeze({
  requestsPerTurn: 2,
  concurrency: 1,
  deadlineMs: 2500,
  candidates: 8,
  sessionRecords: 32,
  recordTtlMs: 30_000,
});
export type Metadata = {
  version: typeof TOOL_VERSION;
  tool: Capability | "invalid";
  permitted: boolean;
  durationMs: number;
  serviceCalls: number;
  providerCallCeiling: number;
  candidateCount: number;
  resultCount: number;
  cacheHit: boolean | null;
  failure: Failure | null;
  costUsd: null;
};
export type Result = {
  version: typeof TOOL_VERSION;
  status: "ready" | "empty" | "denied" | "error";
  reason: Failure | null;
  products: Product[];
};
type Actor = { id: string; isAnonymous: boolean };
export type Dependencies = {
  enabled: () => boolean;
  authenticate: (request: Request) => Promise<Actor>;
  assertActive: (actorId: string) => Promise<void>;
  /** Must verify current consent and server quota/entitlement policy; never use model claims. */
  permitTurn: (actorId: string) => Promise<boolean>;
  allowedMarkets: readonly string[];
  adapters: Adapters;
  emit?: (metadata: Metadata) => void;
};
const response = (
  status: Result["status"],
  reason: Failure | null,
  products: Product[] = [],
): Result => ({ version: TOOL_VERSION, status, reason, products });
/** One broker per isolate; one session per verified actor/conversation. No client body is accepted as trusted context. */
export function createReadOnlyBroker(deps: Dependencies) {
  const authenticate = createDiscoveryAuthenticator(
    deps.authenticate,
    deps.assertActive,
  );
  let occupied = false;
  return {
    async openSession(request: Request) {
      if (deps.enabled() !== true) throw new ToolError("disabled");
      const actor = await authenticate(request);
      if (!actor.id || actor.isAnonymous) throw new ToolError("unauthorized");
      const records = new Map<string, Product>();
      // This object, and all result refs, stay on the server. It must never be deserialized from a request.
      return {
        async executeTurn(inputs: readonly unknown[]): Promise<Result[]> {
          const started = performance.now();
          const deadline = started + LIMITS.deadlineMs;
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new ToolError("deadline"));
            }, LIMITS.deadlineMs);
          });
          const bounded = <T>(p: Promise<T>) => Promise.race([p, timeout]);
          const abort = () => controller.abort();
          request.signal.addEventListener("abort", abort, { once: true });
          if (request.signal.aborted) controller.abort();
          const existing = new Map(
            [...records].filter(([, p]) => p.provenance.expiresAt > Date.now()),
          );
          records.clear();
          existing.forEach((p, k) => records.set(k, p));
          const outputs: Result[] = [];
          // A turn snapshots existing refs: requests in the same turn cannot chain.
          try {
            if (
              !Array.isArray(inputs) || inputs.length === 0 ||
              inputs.length > LIMITS.requestsPerTurn
            ) {
              try {
                deps.emit?.({
                  version: TOOL_VERSION,
                  tool: "invalid",
                  permitted: false,
                  durationMs: 0,
                  serviceCalls: 0,
                  providerCallCeiling: 0,
                  candidateCount: 0,
                  resultCount: 0,
                  cacheHit: false,
                  failure: "limit",
                  costUsd: null,
                });
              } catch { /* telemetry only */ }
              return [response("denied", "limit")];
            }
            let authorized = false;
            try {
              if (deps.enabled() !== true || controller.signal.aborted) {
                throw new ToolError("disabled");
              }
              const current = await bounded(authenticate(request));
              authorized = current.id === actor.id && !current.isAnonymous &&
                await bounded(deps.permitTurn(actor.id));
            } catch {
              authorized = false;
            }
            for (const input of inputs) {
              const t = performance.now();
              const meta: Metadata = {
                version: TOOL_VERSION,
                tool: "invalid",
                permitted: false,
                durationMs: 0,
                serviceCalls: 0,
                providerCallCeiling: 0,
                candidateCount: 0,
                resultCount: 0,
                cacheHit: false,
                failure: null,
                costUsd: null,
              };
              try {
                if (deps.enabled() !== true) throw new ToolError("disabled");
                if (
                  controller.signal.aborted || performance.now() >= deadline
                ) throw new ToolError("deadline");
                if (!authorized) throw new ToolError("unauthorized");
                const parsed = parseToolRequest(input, deps.allowedMarkets);
                meta.tool = parsed.capability;
                const a = parsed.arguments;
                const referenceKeys = "productRefs" in a
                  ? a.productRefs
                  : "previousRefs" in a
                  ? a.previousRefs
                  : [];
                const previous = referenceKeys.map((ref) => {
                  const p = existing.get(ref);
                  if (!p || p.provenance.expiresAt <= Date.now()) {
                    throw new ToolError("foreign_or_stale_reference");
                  }
                  return p;
                });
                meta.permitted = true;
                let products: Product[];
                if (parsed.capability === "compare_products") {
                  // Comparison is a closed table of supported records; no generated conclusions or unavailable attributes.
                  products = previous;
                  meta.cacheHit = true;
                } else {
                  if (occupied) throw new ToolError("busy");
                  occupied = true;
                  // Keep the slot until the service settles, even when the response deadline has fired.
                  meta.serviceCalls = 1;
                  meta.providerCallCeiling =
                    parsed.capability === "discover_black_owned" ? 0 : 2;
                  meta.cacheHit = null; // Existing service caches do not expose hit/call counters.
                  const work = Promise.resolve().then(() =>
                    parsed.capability === "discover_black_owned"
                      ? deps.adapters.blackOwned(
                        parsed.arguments,
                        controller.signal,
                      )
                      : deps.adapters.shopping(
                        parsed.arguments,
                        Math.max(1, deadline - performance.now()),
                        controller.signal,
                      )
                  );
                  void work.finally(() => {
                    occupied = false;
                  }).catch(() => {});
                  const batch: Batch = await bounded(work);
                  if (
                    controller.signal.aborted || performance.now() >= deadline
                  ) throw new ToolError("deadline");
                  if (
                    !batch || !Array.isArray(batch.products) ||
                    batch.products.length > LIMITS.candidates ||
                    !(parsed.capability === "discover_black_owned"
                      ? batch.provider === "eligible_catalog"
                      : ["serper", "brave", "none"].includes(batch.provider)) ||
                    (batch.provider === "none" && batch.products.length > 0)
                  ) throw new ToolError("malformed_provider");
                  meta.candidateCount = batch.products.length;
                  meta.cacheHit = batch.cacheHit === true
                    ? true
                    : batch.cacheHit === false
                    ? false
                    : null;
                  const seen = new Set<string>();
                  products = [];
                  for (const raw of batch.products) {
                    if (batch.provider === "none") {
                      throw new ToolError("malformed_provider");
                    }
                    const p = normalizeProduct(raw, batch.provider, Date.now());
                    if (!p) throw new ToolError("malformed_provider");
                    const sourceKey =
                      `${p.provenance.provider}:${p.provenance.sourceId}`;
                    if (seen.has(identity(p)) || seen.has(sourceKey)) continue;
                    seen.add(identity(p));
                    seen.add(sourceKey);
                    if (
                      parsed.capability !== "discover_black_owned" &&
                      !relevant(asRecommended(p), parsed.arguments)
                    ) continue;
                    if (
                      parsed.capability === "refine_products" &&
                      !matchesRefinement(p.title, parsed.arguments)
                    ) continue;
                    if (
                      parsed.arguments.currency &&
                      p.currency !== parsed.arguments.currency
                    ) continue;
                    if (
                      parsed.arguments.maxPrice !== undefined &&
                      (amount(p) === null ||
                        amount(p)! > parsed.arguments.maxPrice)
                    ) continue;
                    if (
                      "excludePreviousMerchants" in parsed.arguments &&
                      parsed.arguments.excludePreviousMerchants &&
                      previous.some((old) => old.merchant === p.merchant)
                    ) continue;
                    products.push(p);
                  }
                  for (const p of products) {
                    if (records.size >= LIMITS.sessionRecords) {
                      records.delete(records.keys().next().value!);
                    }
                    records.set(p.ref, structuredClone(p));
                  }
                }
                meta.resultCount = products.length;
                outputs.push(
                  response(
                    products.length ? "ready" : "empty",
                    null,
                    structuredClone(products),
                  ),
                );
              } catch (error) {
                const code = error instanceof ToolError
                  ? error.code
                  : "provider_failure";
                meta.failure = code;
                outputs.push(
                  response(
                    ["provider_failure", "malformed_provider", "deadline"]
                        .includes(code)
                      ? "error"
                      : "denied",
                    code,
                  ),
                );
              } finally {
                meta.durationMs = Math.max(
                  0,
                  Math.round(performance.now() - t),
                );
                try {
                  deps.emit?.(meta);
                } catch { /* telemetry cannot affect results */ }
              }
            }
            return outputs;
          } finally {
            clearTimeout(timer);
            controller.abort();
            request.signal.removeEventListener("abort", abort);
          }
        },
      };
    },
  };
}
