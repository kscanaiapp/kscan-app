# Privacy Guide — Scanner Accuracy Evaluation

## Hard prohibitions

Do not commit:

- unapproved faces or plates
- email addresses
- actor IDs / account identifiers
- local device paths
- EXIF location data
- authentication material
- raw signed URLs
- ordinary production user images without explicit authorization

## Repository-safe records

Allowed:

- opaque case IDs
- cryptographic image hashes (`sha256:…`)
- governed fixture references (relative, e.g. `assets/qa_fixtures/top.jpg`)
- normalized labels and uncertainty tokens
- source class, authorization status, privacy disposition
- evaluation outputs and redacted thumbnails only when expressly approved

## Masking

Where a face or plate is present and irrelevant to Scanner accuracy, use an approved masked derivative.
Do **not** claim the current production masking pipeline is complete. Source currently records `localFaceMaskApplied: false` in V2 privacy defaults.

## Correction events (Phase 0A design only)

A privacy-safe correction schema lives at `tools/scanner-evaluation/lib/correctionEventSchema.js`.

Allowed this phase:

- schema design
- local simulator
- import-format definition
- aggregation metric design
- consent / retention / purpose documentation

Not allowed:

- live production collection
- Closet persistence changes
- production endpoints
- identity-linked evaluation rows
- converting corrections into training data
- new Supabase tables

Consent for simulation in this phase: `authorized_internal_qa` only.

## Retention / purpose limitation (policy intent)

Evaluation artifacts exist solely to measure Scanner accuracy and trust.
They must not be reused for advertising, identity analytics, or model fine-tuning without a separate authorization.
