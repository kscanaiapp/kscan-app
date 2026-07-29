# Phase 0B — Evaluation privacy, storage and retention policy

Applies to every image admitted to a governed scanner-accuracy evaluation
dataset. It governs the evaluation corpus only. It makes no claim about
production behaviour.

---

## 1. Storage

**Evaluation images are never committed to Git as evaluation assets.** A manifest
carries an opaque reference and a SHA-256, never image bytes.

The eight images currently in scope are an inherited exception, not a model to
follow: they already live in `assets/qa_fixtures/` as **application** assets and
predate this policy. The evaluation dataset references them by governed ref and
hash; it does not copy them.

`<a name="retention"></a>`

## 2. Retention

| Class | Retention | Expiry field |
|---|---|---|
| Governed repository fixture | Lifetime of the fixture in the app | none — `retentionExpiry` omitted |
| Approved tester image | 12 months from `privacyReviewDate` | `retentionExpiry` required |
| Licensed apparel image | Per licence term | `retentionExpiry` required |
| Synthetic image | Lifetime of the dataset version | none |
| Masked derivative | Inherits the source's retention | inherits |
| Run outputs (`cases/`, reports) | 90 days from run completion | recorded in the run manifest |

Run outputs contain model responses, not images. They still fall under this
policy because a response can quote text visible in an image.

Every case records `retentionPolicyRef` pointing at this document, and
`retentionExpiry` where the class requires one. The validator enforces both.

---

## 3. Required fields per case

Enforced by `validateCase(..., { requirePhase0bPrivacy: true })`:

| Field | Rule |
|---|---|
| `imageReferences[].refValue` | Opaque governed ref. Absolute local paths rejected. |
| `imageHashes[]` | `sha256:<64 hex>`, verified against bytes on disk at pre-flight |
| `sourceClass` | From the governed enum |
| `authorizationStatus` | Must be an approved value; `pending_authorization` and `unauthorized` block execution |
| `authorizationReference` | Points at the record that grants use |
| `privacyDisposition` | `blocked_private` blocks execution |
| `privacyReviewDate` | ISO date. Required. |
| `retentionPolicyRef` | Required. |
| `retentionExpiry` | ISO date where the retention class requires one |
| `exifRemoved` | Boolean. **`false` blocks admission.** |
| `faceReviewState` | `not_reviewed` and `face_present_blocked` both block admission |
| `plateReviewState` | `not_reviewed` and `plate_present_blocked` both block admission |
| `derivativeStatus` | Records whether the admitted image is the original or a derivative |
| `governedStorageRef` | Where the bytes actually live |

**No individual reviewer or authorized-user name is stored in a case record.** A
role and a policy reference is sufficient. The validator rejects identity-shaped
keys, and the existing privacy-surface check rejects any email-shaped string
anywhere in a manifest.

---

## 4. Admission procedure

A case is admitted only after all of:

1. **EXIF verified removed.** Verified by parsing JPEG APP segments, not by
   trusting a flag.
2. **Face inspection.** A human or reviewed automated pass. A face that cannot
   be masked blocks the case.
3. **Plate inspection.** Same standard.
4. **Private-background inspection.** Identifiable private interiors, house
   numbers, street signs and documents block the case.
5. **Masked derivative** produced and approved where masking resolves the issue.
6. **Rejection** where privacy cannot be resolved.

Masking does not resolve a **consent** problem. If the subject could not have
consented — or consent cannot be established at all — the case is rejected
regardless of what is masked.

---

## 5. Audit performed 2026-07-29

All eight fixtures in `assets/qa_fixtures/` were opened and reviewed. Metadata
was established by parsing JPEG segments directly.

### EXIF / metadata

| Fixture | EXIF | XMP | Photoshop APP13 | GPS | Camera Make/Model |
|---|---|---|---|---|---|
| accessory.jpg | no | no | no | no | no |
| bottom_jeans.jpg | **yes** | **yes** | **yes** (5632 B) | no | no |
| bottom_skirt.jpg | no | no | yes | no | no |
| dress.jpg | **yes** | no | **yes** | no | no |
| footwear.jpg | no | no | no | no | no |
| non_fashion.jpg | no | no | yes | no | no |
| outerwear.jpg | no | no | no | no | no |
| top.jpg | no | no | no | no | no |

EXIF IFD0 tags found were orientation, resolution, `Software` and `DateTime`
plus the ExifIFD pointer. **No GPS IFD exists in any fixture.** An initial
byte-pattern scan appeared to show a GPS tag in `dress.jpg`; parsing the actual
IFD structure disproved it, and the corrected result is recorded here.

### Face, plate and background

| Fixture | Face | Plate | Private background | Disposition |
|---|---|---|---|---|
| footwear.jpg | none | none | none | **admissible** |
| non_fashion.jpg | none | none | none | **admissible** |
| accessory.jpg | none | none | none | **admissible** |
| bottom_jeans.jpg | none (cropped at neck) | none | none | **admissible after EXIF strip** |
| top.jpg | full frontal, identifiable | none | none | masked derivative required |
| dress.jpg | identifiable model | none | none | masked derivative + EXIF strip required |
| outerwear.jpg | partial (jaw, mouth, chin) | none | none | owner review: mask or admit |
| bottom_skirt.jpg | full, identifiable | none | **identifiable private dwelling** | **REJECTED** |

### Excluded pending provenance

**`assets/qa_fixtures/bottom_skirt.jpg` — excluded, `blocked_private`.**

Observable: one identifiable person, face unobscured, in an interior residential
stairwell with identifying detail; composition characteristic of a casual
personal photograph rather than the commercial imagery the other fixtures use.

Unknown: source, copyright holder, licence, model release, capture date, and the
subject's age. None of these exists in the repository.

The basis for exclusion is **undocumented provenance combined with an
identifiable person in a private setting**. Age, legal status and absence of
permission are *not* asserted — none has been independently verified. Masking
would address identifiability but not the provenance gap, which is why the file
is excluded rather than remediated.

Empirically confirmed to have shipped: all eight fixture md5s appear in a
production Expo export dated 2026-07-13. The `__DEV__` gate was added on
2026-07-28 and has not reached `origin/master` or `release/ios-v18-build-prep`.

Full escalation: `docs/scanner-accuracy/phase0c-fixture-escalation.md`.

### Authorization — unresolved for all eight

No licence, model release, purchase record or provenance record exists in the
repository for **any** of the eight. Phase 0A recorded them as
`approved_qa_fixture` on the basis that they are registered in
`constants/qaFixtures.js`. Registration is not authorization.

Several are recognisably web-sourced stock or catalogue imagery. Until the owner
produces a use record, all eight carry `authorizationStatus:
unverified_claim`, and none is admissible to a frozen dataset.

---

## 6. What this policy does not claim

It does **not** claim production face or plate masking is complete. The V2
request contract states the opposite: `localFaceMaskApplied` and
`localPlateMaskApplied` are typed as the literal `false`. Production sends
unmasked images today. That is a production matter, out of Phase 0B scope, and
nothing here should be read as evidence about it.
