# Phase 0C Lane A — Internal garment capture specification

For project-owned and tester-owned garments. This is the preferred sourcing
route because it is the only one that resolves ownership, privacy, multi-angle
coverage and verifiable product evidence in a single pass.

---

## 1. Why this route is preferred

| Problem with existing fixtures | How internal capture resolves it |
|---|---|
| No source owner, no licence (INV-1) | The owner holds the garment and can produce a written use record |
| Identifiable faces with no release (INV-3) | Shoot flat, on a mannequin, or crop above the shoulders |
| Zero multi-image same-item sets | Multiple genuine angles of one held item |
| Zero exact-product-knowable cases | The label, SKU and receipt are in hand |
| Unknown capture conditions | Difficulty is staged deliberately, not hoped for |

## 2. Per-garment capture set

Each garment should yield up to six frames. **Each is an independent capture, not
a crop of another.**

| # | Frame | Purpose | Required |
|---|---|---|---|
| 1 | Front, full garment | primary identification | **yes** |
| 2 | Back, full garment | multi-angle consistency | yes for multi-image cases |
| 3 | Side or silhouette | shape and drape | yes for multi-image cases |
| 4 | Label or care tag | brand and size evidence | where a label exists |
| 5 | Logo or hardware detail | direct brand evidence | where visible branding exists |
| 6 | Material close-up | fibre and weave | optional |

Frames 4 and 5 are what make a case brand-evidenced. Without one of them the
brand ground truth is `not_visible`, however obvious the brand looks.

## 3. Privacy requirements — mandatory

- **No faces** unless expressly required and approved in advance. Default to
  flat-lay, mannequin, or a crop below the chin.
- **No licence plates.**
- **Neutral or governed background.** No identifiable private interior, no house
  number, no street sign, no visible document, screen or correspondence.
- **No other people** incidentally in frame.
- **EXIF removed** before the file enters governed storage. Phone cameras embed
  GPS by default — this is not optional.
- **No account identity in filenames.** Filenames are opaque case identifiers,
  never a person's name, handle or device name.
- **Opaque case identifiers** in the manifest, per the existing schema.

## 4. Provenance recorded at capture time

Recorded once per garment, not reconstructed later:

| Field | Example |
|---|---|
| `sourceOwner` | `project` or `tester_pool_a` |
| `ownershipBasis` | owned by the project / owned by a tester who authorized internal evaluation |
| `authorizationReference` | pointer to the written authorization record |
| `captureDate` | ISO date |
| `brandEvidence` | `label_photographed` / `logo_photographed` / `none` |
| `exactProductEvidence` | `sku_recorded` / `receipt_held` / `product_page_verified` / `none` |
| `sku` | recorded **only** when read from the item or its record |

**Brand and exact product are recorded only when independently known.** Knowing
you bought it is a record. Recognising the silhouette is not.

## 5. Multi-angle rules

**A multi-image case requires genuinely independent captures.** Frames 1–3 of the
same garment, shot separately, qualify.

**A crop, rotation, rescale, recompression or filtered version of one source
image is a `transformation_derivative`.** It must be tagged as such. It may be
used to test robustness to degradation, and it must **never** count as
independent multi-angle evidence.

The reason is not bookkeeping. Two crops of one photograph share every
photographic accident — the same lighting, the same occlusion, the same
mis-focus. Treating them as independent angles would make cross-angle agreement
look far higher than it is, and cross-angle agreement is precisely what the
multi-image metric measures.

## 6. Difficulty strata to stage deliberately

The dataset needs these and they will not occur by accident:

| Stratum | Target | How to stage |
|---|---|---|
| Mirror photographs | 5 | Shoot the garment worn, in a mirror, phone visible |
| Low light | ≥3 | Indoor evening, no flash |
| Blur | ≥3 | Slight motion at capture — do **not** post-process a sharp frame |
| Occlusion | ≥3 | Garment partly behind a bag, arm or furniture |
| Store display | 3 | On a rack or mannequin in a retail setting, with permission |
| Screenshot / product page | 5 | See the sourcing plan — needs legal review first |
| Adversarial / misleading | 5 | Garments with brand-like but non-brand graphics |

Blur and low light must be **captured**, not simulated. A Gaussian blur applied
to a clean frame is a `transformation_derivative` and tests a different thing
than a genuinely soft capture.

## 7. Storage

1. Capture to a staging location outside the repository.
2. Strip EXIF.
3. Face / plate / background review per the privacy policy.
4. Move to governed storage; record `governedStorageRef` and the SHA-256.
5. The manifest references the hash and the governed ref. **Image bytes are
   never committed to Git.**

## 8. Effort estimate

| Activity | Rate | For ~45 garments |
|---|---|---|
| Setup (backdrop, lighting, staging area) | one-off | 1–2 h |
| Capture, 3–6 frames per garment | ~6 min each | 4.5 h |
| EXIF strip and privacy review | ~2 min each | 1.5 h |
| Provenance and authorization records | ~2 min each | 1.5 h |
| Governed storage and hashing | scripted | 0.5 h |
| **Total** | | **9–10 h** |

Roughly one to two working days for the bulk of the shortfall — which is
substantially less effort than sourcing and clearing 45 licensed images, and it
is the only route that produces exact-product evidence.
