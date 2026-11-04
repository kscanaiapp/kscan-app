import { buildUntrustedSection } from "../../aiSecurity/promptEnvelope.ts";
import type { Result } from "./broker.ts";

/** Only server-held broker results may enter here. Never expose internal provenance, URLs or merchant evidence to Gemini. */
export function renderToolResultForModel(result: Result): string {
  const body = JSON.stringify({
    version: result.version,
    status: result.status,
    reason: result.reason,
    products: result.products.slice(0, 8).map((p) => ({
      ref: p.ref,
      title: p.title,
      merchant: p.merchant,
      ...(p.price ? { listedPrice: p.price } : {}),
      ...(p.currency ? { currency: p.currency } : {}),
      // Ownership is deliberately omitted here. Existing CI trusted-context assembly/finalization owns ownership prose.
    })),
  });
  // Bounds are checked before enveloping, so no partial JSON is silently truncated.
  if (body.length > 6000) {
    return buildUntrustedSection(
      "commerce_context",
      JSON.stringify({
        status: "error",
        reason: "projection_limit",
        products: [],
      }),
      6000,
    );
  }
  return buildUntrustedSection("commerce_context", body, 6000);
}
