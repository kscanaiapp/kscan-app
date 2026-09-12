# Provenance & attribution

## FashionCLIP (patrickjohncyh/fashion-clip)

This package's `fashionClipAdapter.js`/`fashionClipAdapter.py` are written to
run **the actual public FashionCLIP model** — no reimplementation, no
distillation, no derivative weights of any kind live in this repository.

- Model: `patrickjohncyh/fashion-clip` on the Hugging Face Hub.
- Model card: `https://huggingface.co/patrickjohncyh/fashion-clip`.
- License, as stated on the model card at the time this package was written
  from public documentation: **MIT**.
- Architecture: a fine-tune of `openai/clip-vit-base-patch32` (unchanged
  projection dimension and image/text preprocessing contract — see
  `modelManifest.js`).

**No weights are committed.** `fashionClipAdapter.py` loads the model via
`transformers.CLIPModel.from_pretrained('patrickjohncyh/fashion-clip')` at
run time; nothing from the Hub is vendored into this repository, and
`embeddingCache.js`'s cache directory (`cache/`) is gitignored so a
computed embedding never gets committed either.

**Network verification note — read before trusting `MODEL_REVISION`
elsewhere in this package:** this session's egress proxy returns an
explicit **organization policy denial** (403 CONNECT, logged by the proxy
itself as `connect_rejected` / "policy denial") for `huggingface.co`, and
every mirror tried (`hf-mirror.com`, `cdn.jsdelivr.net`,
`cdn-lfs.huggingface.co`). This means:

- The exact commit SHA `patrickjohncyh/fashion-clip`'s `main` ref currently
  points to could not be resolved or independently verified in this
  session — `modelManifest.js#resolveRevision()` is the real, reusable
  resolution path (it genuinely calls the Hub API), but it fails here with
  `blocker: 'HF_HUB_UNREACHABLE'`, honestly, not by design.
- The MIT license statement above is recorded from public model-card
  knowledge, the same way `tools/fashion-ontology/NOTICE.md` recorded
  Fashionpedia's citation under an identical network restriction during
  Build 35 Workstream 01 — it was **not** independently re-verified live
  against `huggingface.co` in this session.
- Every evaluation report this package produces states its actual
  `modelProvider` (`FASHIONCLIP` or `HARNESS_STUB_NOT_FASHIONCLIP`) and
  `modelRevision` explicitly, so a report can never be mistaken for one
  produced against a verified, pinned FashionCLIP checkout — see
  `runEvaluation.js` and `reportSchema.js`.

Anyone running this package in an environment where `huggingface.co` is
reachable gets the real, verified model and a real, resolved commit SHA
automatically — nothing in this package's code needs to change for that;
only the network policy of the environment it runs in does.

## K Scan's own sources (candidate universe, scoring, corpus binding)

The candidate-product universe, ground truth, and quality scoring this
package evaluates FashionCLIP against are entirely K Scan's own: FMQ's
fixture corpus (`tools/fashion-match-quality/fixtures/synthetic/`, PR #314),
its identity/substitute evaluator (`evaluator/`, unmodified), and Real
Fashion Corpus V2's ontology/manifest/failure-taxonomy authority
(`tools/real-fashion-corpus/`, Build 35 Workstreams 01–02). See each
module's header comment and `docs/DESIGN.md` for the full reuse map.
