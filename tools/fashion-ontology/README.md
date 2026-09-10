# Fashion Ontology (V1)

K Scan's deterministic internal vocabulary for fashion attributes — Build 35
research/engineering infrastructure. Nothing here is wired into the app: no
new runtime API calls, no new Scanner network calls, no new providers, no
production or Scanner behavior change. This is a standalone package with
zero dependencies on any other `tools/` lab or production code.

## What this is

`CanonicalFashionAttributesV1` — a versioned contract with seven fields:

```
category
subtype
primaryColor
secondaryColor
silhouette
material
pattern
```

Every field is deterministic and every field has an explicit unknown state.
Equivalent inputs — including different phrasing, casing, or whitespace —
resolve to the same canonical value on every run. Low-confidence or absent
evidence is never forced into a guessed canonical value: an unresolved
field comes back with `value: null` (and, for color fields, `family: null`)
rather than an invented answer.

This is not an attempt at a complete fashion ontology. It standardizes the
attributes already important to K Scan's real matching problems — see
`compatibility.js` for exactly which existing fields it replaces or maps
onto.

**Semantic hardening pass.** Before this ontology becomes ground truth for
Real Fashion Corpus, every hard alias in `colors.js`, `materials.js`,
`patterns.js`, `silhouettes.js`, and `categories.js` was hostile-reviewed
against one doctrine: *"a hard alias means the terms can safely be treated
as the same canonical fashion concept for K Scan matching" — shared color
family, relatedness, subtype membership, or common retail misuse are not
sufficient.* Several V1 collapses did not survive that review (e.g. gold
was not actually a shade of yellow, houndstooth is not the same pattern as
plaid, a hoodie is not the same subtype as a crewneck sweatshirt, flare and
wide-leg are different cuts) and were split into their own canonical
values; a smaller number were reviewed and explicitly retained (e.g.
oxblood as a burgundy naming variant, a pump as structurally a heel). Every
module's header comment documents its own pass in full, including the
reasoning for what was split and what was deliberately kept merged.

## Quickstart

```bash
# Full test suite
node --test tools/fashion-ontology/tests/*.test.js

# Canonicalize one record
node -e "
const { canonicalizeFashionAttributes } = require('./tools/fashion-ontology/canonicalize');
console.log(JSON.stringify(canonicalizeFashionAttributes({
  category: 'outerwear',
  subtype: 'flight jacket',
  primaryColor: 'wine',
  material: 'lambskin',
  pattern: 'checkered',
}), null, 2));
"
```

## Package layout

| File | What it is |
|---|---|
| `schema.js` | The `CanonicalFashionAttributesV1` contract shape, the unknown-value factories, and a non-throwing validator. |
| `categories.js` | Canonical categories + subtypes, each subtype bound to one parent category. |
| `colors.js` | Canonical color families + canonical color names + aliases (spec section 9). |
| `materials.js` | Canonical material vocabulary (spec section 10) — leather/faux_leather/suede kept distinct. |
| `patterns.js` | Canonical pattern vocabulary (spec section 11). |
| `silhouettes.js` | Canonical, fashion-specific silhouette vocabulary (spec section 12). |
| `aliases.js` | A read-only aggregator over every domain module's alias table (no second source of truth). |
| `canonicalize.js` | The one normalization path: `canonicalizeCategory`, `canonicalizeSubtype`, `canonicalizeColor`, `canonicalizeSilhouette`, `canonicalizeMaterial`, `canonicalizePattern`, and `canonicalizeFashionAttributes` (the full-record entry point). |
| `compatibility.js` | The DIRECT/ALIAS/TRANSFORM/NOT_CURRENTLY_REPRESENTED mapping matrix against FMQ, Real Fashion Corpus, Canonical Product Identity, Scanner, and Closet — plus adapter functions that convert each system's existing shape into a `CanonicalFashionAttributesV1` record. |
| `NOTICE.md` | Fashionpedia attribution/provenance record. |
| `VERSION` | The contract version string. |
| `tests/` | `node:test` files — determinism, alias resolution, fashion-specific hard cases, and compatibility-adapter tests. |

## Determinism & unknown handling

- Alias lookup is case/whitespace-insensitive (`normalizeRawString` lowercases,
  trims, and collapses internal whitespace before lookup) but never fuzzy —
  an unrecognized string resolves to `value: null`, never a nearest guess.
- A field given an array (Scanner's `material[]`, Closet's `secondaryColors[]`)
  resolves to the first array entry that has an alias-table match, in array
  order — deterministic and documented per-field in `compatibility.js`.
- Malformed input (numbers, booleans, objects, `null`) never throws and
  never becomes a valid taxonomy value — it resolves the same as "absent."
- Tokens observed in Scanner's own raw provider layer as its unknown
  sentinel (`'unknown'`, `'n/a'`, `'none'`, etc. — see `UNKNOWN_TOKENS` in
  `canonicalize.js`) are treated as absent, not as a canonical value named
  "unknown."

## Compatibility

`compatibility.js` classifies each of the seven fields against each of
K Scan's existing fashion-attribute shapes:

- **Fashion Match Quality** (`tools/fashion-match-quality/`)
- **Real Fashion Corpus** (`tools/real-fashion-corpus/`)
- **Canonical Product Identity** (`tools/canonical-product-identity/`)
- **Scanner** — the production contract, `fashion-identification-v2`
  (`supabase/functions/_shared/fashionIdentificationV2.ts`)
- **Closet** — both the committed item taxonomy (`services/closetLibrary.js`)
  and the separate, unrelated `OwnedClosetItem` read projection
  (`types/ownedClosetItem.ts`)

as `DIRECT` (same field, same concept), `ALIAS` (same concept, different
name), `TRANSFORM` (same concept, different shape — e.g. an array where this
ontology has one canonical value), or `NOT_CURRENTLY_REPRESENTED` (no
equivalent field exists in that system today). See
`CONTRACT_FIELD_COMPATIBILITY` in `compatibility.js` for the full matrix
with source-field citations, and `tests/compatibility.test.js` for adapter
tests against realistic fixtures shaped like each system's real records.

Notable findings from that mapping (see `compatibility.js` for the full
matrix):

- No inspected system today has a `subtype` field except Scanner (`subtype`)
  and Closet's committed item (`subtype`) and `OwnedClosetItem`
  (`subcategory`, aliased). FMQ, Real Fashion Corpus, and CPI have no
  subtype-equivalent field at all.
- No inspected system has a true `secondaryColor` concept; Scanner and
  Closet's committed item carry a `secondary` **array**, which this ontology
  transforms into one canonical value.
- Closet's committed item schema (`services/closetLibrary.js`) has no
  `silhouette` or `pattern` field at all — both are confirmed dropped at the
  candidate-to-committed projection boundary
  (`services/closetIdentificationV2.ts`), before this ontology or any other
  consumer ever sees them.

This package does not modify Scanner, Closet, or any existing lab's
behavior — the adapters in `compatibility.js` are pure, read-only functions
that accept a plain object shaped like each system's existing record and
return a `CanonicalFashionAttributesV1` record. No other tool's source is
imported, called, or changed.

## Provenance

See `NOTICE.md` for the Fashionpedia attribution/reference record. This
ontology's actual vocabulary is K Scan's own, grounded in K Scan's existing
research labs and production contracts — Fashionpedia informed only the
general shape of separating category from finer attributes, and no
Fashionpedia data, images, or schema text was copied or ingested.
