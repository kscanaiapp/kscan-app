# DR-2 Commerce, Image, and Model Privacy

## Commerce
- DR-1 `normalizePurchaseOptions` / retailer-neutral order preserved.
- Model prompt receives bounded sanitized summaries only; no raw offer URLs.
- "use only what I own" / no-shopping intents exclude commerce (E-4).

## Image
- Durable owner-scoped storage → approved HTTPS → local URI fallback → no-image.
- Prompt never receives storage paths or signed URLs.
- Shared media uses same verified access decision as evidence.

## Prompt privacy
- Untrusted: user/saved/scan/retailer/shared text.
- Never: user/owner IDs, storage paths, signed URLs, share tokens, raw snapshots, full offer arrays, affiliate URLs, secrets, whole Closet dumps.
