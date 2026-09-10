# Provenance & attribution

## Fashionpedia (reference only)

This package's field selection — the idea of treating garment **category**,
**silhouette**, **color**, **material**, and **pattern** as separate,
independently-resolvable axes of a fashion attribute ontology — was informed
by the public structure of the **Fashionpedia** project as one reference
point among several (alongside K Scan's own existing research labs, which
were the primary and controlling source — see `README.md` "Compatibility").

- Project: Fashionpedia — "Ontology, Segmentation, and an Attribute
  Localization Dataset."
- Citation: Jia, M., Shi, M., Sirotenko, M., Cui, Y., Cardie, C., Hariharan,
  B., Adam, H., Belongie, S. *Fashionpedia: Ontology, Segmentation, and an
  Attribute Localization Dataset.* ECCV 2020.
- Repository consulted: `github.com/cvdfoundation/fashionpedia`.

**What was used:** the general shape of the public ontology/annotation
taxonomy (that a fashion ontology sensibly separates category-level
classification from finer attributes like silhouette, color, material, and
pattern) informed this package's decision to make those the seven V1 fields.

**What was NOT used, per this workstream's explicit scope:**
- No Fashionpedia schema was copied. `categories.js`, `colors.js`,
  `materials.js`, `patterns.js`, and `silhouettes.js` in this package are
  K Scan's own vocabularies, built from K Scan's existing research-lab field
  usage (Fashion Match Quality, Real Fashion Corpus, Canonical Product
  Identity, Scanner, Closet — see `README.md`), not translated or copied
  from Fashionpedia's category/attribute lists.
- No Fashionpedia image data, annotation files, or any other corpus content
  was downloaded, ingested, stored, or committed anywhere in this repository.
  This package contains no images and no Fashionpedia-derived data files.

**License verification note:** this session's outbound network access could
not reach `fashionpedia.github.io`, `huggingface.co`, `arxiv.org`, or
`paperswithcode.com` to independently re-verify Fashionpedia's current
license terms at the time of writing (network egress in this environment is
restricted to an allowlist that did not include those hosts). The GitHub
repository's README, which was reachable, did not itself state license
terms in the section retrieved. Because this package uses Fashionpedia only
as a structural reference — no Fashionpedia data, images, or verbatim
schema text is redistributed here — no license grant from Fashionpedia is
exercised by this package. Anyone extending this ontology to actually
ingest Fashionpedia data (out of scope for this V1 workstream — see spec
section 5, "Do not ingest Fashionpedia's image corpus during this task")
must independently verify the current license and attribution terms at the
authoritative source before doing so.

## K Scan's own sources (primary, controlling)

Every canonical value and alias in this package is grounded in K Scan's own
existing code and research labs, cited inline in each module's header
comments and enumerated in `compatibility.js`'s `CONTRACT_FIELD_COMPATIBILITY`
matrix. These — not Fashionpedia — are the authoritative source for this
ontology's actual vocabulary, per spec section 5: "K Scan owns its own
domain model."
