# Elise contextual Virtual Try-On (Build 35)

When a customer gives Elise a photo of a garment K Scan can genuinely visualize,
the **application** appends one offer to her reply:

```
Would you like to try that on?
[ TRY IT ON ]
```

Virtual Try-On stays a contextual capability. There is no standalone VTO
destination, no second sheet, no second provider and no second eligibility
system. This document is the lane's record: who decides what, what is stored
where, what the prose guard can and cannot do, and what is **not** proven.

## 1. The mechanism

```
ready Elise send snapshot  (drafts, sent fashion context, explicit focus)
        │
        ▼
normal fashion context ─────────────►  Elise  ─► fashion advice only
        │                                              │
        │                                validate / guard assistant prose
        ▼                                              │
deterministically correlate ONE offerable garment      │
        │                                              │
        ▼                                              ▼
create actor-scoped device-local binding ──► append app-owned elise_vto_offer block
                                                       │
                                  persist assistant message (opaque id only)
                                                       │
                                                       ▼
                                Would you like to try that on?  [ TRY IT ON ]
```

The model does not write the sentence, does not emit the block, does not choose
the garment and does not decide eligibility. `try_on_item` is not on the model
action allowlist (`supabase/functions/stylechat-generate/actions.ts`) and is
dropped if emitted. No candidate id, binding id or media identity is put in the
prompt.

The sentence and the button are **one UI object**
(`components/style-chat/EliseVtoOffer.tsx`). They render together from the block
or not at all.

## 2. Authority map

| Question | Owner (unchanged unless noted) |
| --- | --- |
| Garment local ownership / actor scope | Existing `ClosetCandidate` actor-scoped store (`services/closetCandidateLibrary.js`) |
| Garment identity | Fashion Identification V2 canonical result |
| Elise styling projection | `EliseFashionContextV2` |
| Elise offer correlation | Send snapshot + `selectEliseVtoOfferGarment` (`services/style-chat/eliseVtoOffer.ts`) — **new, pure** |
| Elise offer persisted marker | Synced app-owned `ui_block` carrying an opaque local binding id only — **new** |
| Elise local source binding | `services/style-chat/eliseVtoOfferBindings.ts`, actor-scoped device storage — **new** |
| VTO client offerability | `services/vto/vtoEligibility.ts` via `hooks/useVtoAvailability.ts`, extended neutrally (`inlineMediaReady`) |
| VTO server category | `supabase/functions/vto-generate/vtoEligibility.ts` → `_shared/scanHelpers.normalizeCategory` |
| K+ (client) | Canonical reader `hooks/useKPlusEntitlement.ts`, through `useVtoAvailability` and the shared `KPlusGate` |
| K+ (server) | `vto-generate/vtoEntitlement.ts` → `kplus_has_active_entitlement`, read twice |
| VTO feature enabled | `app_config.vto_generation` via the existing readers |
| VTO consent | `services/vto/vtoConsent.ts` + the store backstop in `vtoRequestStore.ts` |
| VTO generation | Existing `vto-generate` |
| VTO provider | Existing server registry `vto-generate/providers/index.ts` |
| VTO result | Existing validated result pipeline |

`NEW_CLASSIFIER_ADDED=NO`, `NEW_TAXONOMY_ADDED=NO`,
`CLIENT_SERVER_CATEGORY_PARITY=PRESERVED`. Category chain: canonical
identification `category` → `candidate.category` → `toCanonicalVtoCategory`
(client mirror) → server `normalizeCategory` → `supportedCategories` allowlist.

## 3. What is stored, and where

**Synced (cloud, `style_chat_messages.ui_blocks`):**

```json
{ "type": "elise_vto_offer", "contractVersion": "1", "localBindingId": "<32 hex, random>" }
```

Nothing else. Not the candidate id, not the content hash, not a category, not a
path, not bytes. A block this build cannot read exactly (another
`contractVersion`, a malformed id) renders as nothing; it is never repaired and
never reaches the generic block view.

**Device-local, actor-scoped (`AsyncStorage`, key
`kscan.eliseVtoOfferBindings.v1:<actorId>`):**

```
localBindingId, sessionId,
candidateId, contentHash, contentHashVersion, canonicalCategory, classificationVersion,
createdAt, expiresAt
```

- One key per account; every record is stamped with its account; every read
  answers only for the account that is current when it finishes.
- Bounded (60, newest first) and self-pruning at the candidate's own expiry. The
  7-day `ClosetCandidate` lifetime is **not** changed or extended.
- Survives an app restart on the same device. Does not exist on another device.
- Holds no photo, bytes, URL, provider response, K+ state or model output.

The binding **authorizes nothing**. It only says which candidate to ask the
candidate store about.

## 4. Which garment gets the offer

Correlation is taken from the send snapshot, never from prose:

```
draftId ↔ device-local candidate ↔ this draft's canonical context item
        ↔ its position in the sent context ↔ local fingerprint
```

| Snapshot | Result |
| --- | --- |
| exactly one offerable direct image | that garment |
| several, and the customer **explicitly** focused one of them | that exact garment |
| several, no explicit focus on one of them | **no offer** |
| none | no offer |

The composer also focuses the first attachment by default. That default is
tracked separately (`explicitFocusBySession` in `hooks/useStyleChatAttachments.ts`)
and is **not** a choice: only the customer's own focus action counts. Nothing in
the policy consults order. At most one automatic offer per assistant turn, and
at most one per garment fingerprint per conversation.

### Offerability is not entitlement

An offer requires: an authenticated actor, one deterministically correlated
garment, a canonical category the existing VTO authority accepts, usable local
candidate media, a live candidate, a build that carries VTO, and a readable,
enabled remote control. It does **not** require K+: a Free customer sees the
offer, and it is their way into the existing K+ acquisition flow.

### Partial identifications (P1-05)

No second threshold was invented. The existing VTO rule is the category. A
`partial` identity that still carries a category (or, failing that, a subtype —
the same precedence the attachment used when it filed the candidate) which the
canonicalizer accepts is offered exactly like a `ready` one. A partial identity
with no usable category is not.

## 5. Every tap revalidates

On every tap the binding is re-read under the **current** account, the candidate
is reloaded through the candidate authority, and its present fingerprint must
equal the stored one field for field (`candidateId`, `contentHash`,
`contentHashVersion`, canonical category, `classificationVersion`), with media
present. A candidate reclassified from one supported category to another is
still a different interpretation; the old action does not follow it.

Any failure → `Try It On isn't available for this upload anymore.` Never a
re-identification, never another attachment, never a replacement upload.

The garment's bytes are read at a third, separate moment: inside an explicit,
consented generation, by a loader the VTO store is handed. The loader verifies
again and recomputes the hash on the device before returning anything.

## 6. Transport and the server

Reuses the existing `vto-generate` endpoint. New source: `user_supplied_garment`.

- **Neutral by name.** It means "the authenticated client is supplying bounded
  garment media for this explicit request." Not owned, not purchased, not saved,
  not a verified retailer product, not "from Elise".
- **Origin is not authority.** §9 of the brief said "origin must be elise" and
  §25 said origin must not grant authorization. Both are honoured: the request
  is refused unless `origin === 'elise'`, as a *contract-shape* rule (the one
  client that produces this source labels itself so), and that comparison can
  only refuse. Identity, account guard, kill switch, K+ (twice), quota
  reservation and provider choice run identically for every origin.
- **Authority order unchanged:** drain body → authenticate → account guard →
  feature control → K+ → source contract + garment validation → eligibility →
  person input → provider resolution → K+ recheck → reservation → generation →
  result validation.
- **Garment validation** (`vtoUserSuppliedGarment.ts`): source shape, encoded
  ceiling, JPEG-only MIME allowlist, data-URI shape, well-formed Base64, decoded
  floor and ceiling, JPEG start-of-image, canonical encoding, and the content
  hash **recomputed** and compared. The hash proves request/fingerprint
  consistency. It is not authorization and not proof of ownership or provenance.
- **Ceilings** (derived, not multiplied):

  | | Characters |
  | --- | --- |
  | Person payload (unchanged) | 2,000,000 |
  | Garment payload (new) | 3,000,000 (≈ 2,250,000 decoded bytes) |
  | Envelope | 8,192 |
  | Body, no inline garment (unchanged) | 2,008,192 |
  | Body, `user_supplied_garment` only | 5,008,192 |

  Only a request that names the inline source may use the larger ceiling; every
  other source is held to the ceiling it always had.
- **Reservation identity** uses the content identity
  (`user_supplied_garment/sha256-normalized-v1/<hash>`), never a device id and
  never the bytes. The server never learns the candidate id.
- **Provider.** `VtoProviderInput` gains an optional `garmentDataUri`.
  AILabTools decodes it straight into the existing `top_garment` multipart part;
  nothing is fetched and nothing becomes fetchable. No Elise-specific provider.
- **Nothing is logged** beyond fixed reason codes.

## 7. Consent

Mechanism unchanged: the sheet asks before transmission and the store refuses
the real transport without proof. One wording change:

> …sends the photo you chose, together with the **garment** image…

(was "product image", which is not accurate for an uploaded photo).
`VTO_CONSENT_VERSION` is now `vto-third-party-v2`, so everyone who accepted v1 is
asked again. The v1 digest was not edited; v2 was appended. No retention or
processing claim was added. `VTO_CONSENT_COPY_LEGAL_REVIEW_REQUIRED=YES` stands.

**For counsel:** an uploaded garment photo may itself show a person (a model, a
mannequin, the customer). K Scan sends it as-is and performs no garment
isolation; the copy does not claim otherwise, but it also does not call this out.

## 8. The prose guard, and its limits

Two layers keep Elise from promising a try-on in free prose.

1. **System instruction** (`stylechat-generate/index.ts`): do not offer or
   invite Virtual Try-On; K Scan may add the option; never say a try-on
   happened; no exact-fit, sizing-accuracy or body-measurement claims; a try-on
   is not one of her actions.
2. **Deterministic guard** (`guardEliseVtoInvitationProse`, in
   `services/style-chat/eliseConversationFrame.ts`), applied before the reply is
   checked for emptiness, shown, stored or spoken.

The guard is **negative only**. It removes sentences; it never creates an offer,
and a reply it empties falls through to the existing empty-reply handling (it
writes no words on Elise's behalf).

It recognises a **fixed set of phrasings**: an invitation lead-in or a question
about trying something on, talk of seeing the piece on the customer's own body,
or the feature by name — tolerant of capitalisation, punctuation, contractions,
curly quotes, markdown emphasis and singular/plural pronouns. It deliberately
leaves ordinary advice alone ("try it on with a belt before you decide").

**It is not semantic proof.** A paraphrase outside that set passes through. A
36-sentence corpus is pinned in the tests; passing it is evidence about those 36
sentences, not about natural language. The positive authority is the app-owned
block, never the pattern match.

## 9. Result loop

Preserved as far as each action is truthful: result presentation, original/result
comparison, Retry / Try Another, Change Photo, Save to Dressing Room,
close/minimize. `Shop` and `Watch` are **hidden** for an uploaded photo because
no `onShop` / `onWatch` is passed — there is no retailer destination or watchable
listing to point at, and none is fabricated. Closing returns to the conversation.

Save to Dressing Room persists the garment's client `productRef` as `sourceId`;
for an upload that value is built from the opaque binding id, so neither the
candidate id nor the content hash leaves the device that way.

## 10. Shared launcher

`components/vto/VtoLaunchHost.tsx` (`useVtoLaunchHost` + `VtoLaunchHost`) now owns
what was common: sheet visibility, collapse, the single `VirtualTryOnSheet`
mount, the minimized pill, and the awareness history updates.
`TryItOnEntry` keeps product presentation, the K+ seam and the first-use cue.
`EliseVtoOffer` keeps the invitation, binding resolution and the stale state.
Both mount the same host. There is still exactly one `<VirtualTryOnSheet` in the
app. Source-pin tests that asserted the sheet/pill JSX lived in `TryItOnEntry`
were retargeted at the host; none was weakened.

## 11. Telemetry

On the existing VTO sink, with its closed property allowlist:
`elise_vto_offer_rendered`, `_tapped`, `_unavailable`, `_kplus_gate`,
`_launched`. Properties: `origin`, `actor_kplus_state` (bounded), `reasonCode`
(bounded, new). No candidate id, binding id, hash, URI, category text, garment
description or message text.

## 12. Deliberately not built

- **Dismissing an offer, and re-surfacing it on an explicit user request**
  (brief §31). The UI has no dismiss, so there is nothing to suppress; the
  persisted action is simply the action.
- **Per-message binding cleanup.** StyleChat has no message deletion. Bindings
  are removed when a conversation is deleted; otherwise they expire with their
  candidate.
- **Cleanup on account deletion.** A deleted account's binding record (ids and
  hashes, no media) is not removed by the terminal purge. It is inert and
  bounded, but it is residue. Not added here to avoid changing the purge
  inventory in this lane.

## 13. Known limits

- **Request size is unverified at runtime.** An upload request can approach
  5 MB. Whether the Edge runtime accepts that in practice is unproven until
  staging.
- **Minimize inside a virtualized list.** The sheet is mounted from a chat row.
  If the customer collapses a running try-on and scrolls far enough for that row
  to be unmounted, the generation is torn down — the same property product cards
  in lists already have.
- **Provider behaviour on non-isolated garments** is unknown. Nothing here
  segments a garment; if the provider needs an isolated one, quality will show
  it, and that is a certification finding, not something this lane papers over.

## 14. Certification status

| | |
| --- | --- |
| Source implementation | See the PR's test and CI evidence |
| Device certification | **Not performed** |
| Real provider certification | **Not performed** — no real generation was run |
| Output quality certification | **Not performed** |

A green suite is not proof of real-provider quality. Device certification still
has to prove: Elise upload → offer → K+ if needed → person selection → consent →
real generation → result → return to Elise.

## 15. Transcripts (simulated model replies)

Produced by executing the real conversation hook, offer policy, binding store
and bridge against a scripted model reply
(`__tests__/vtoEliseContextualOffer.test.js`, P2-01..P2-03). They show what the
application appends. They are not real Elise output.

**Eligible upload (a dress):**

```
CUSTOMER  How should I style this for dinner?
ELISE     That slip dress is a lovely base. Add a cropped cardigan and block heels for dinner.
K SCAN    Would you like to try that on?   [ TRY IT ON ]   (app-owned block)
```

**Ineligible upload (sneakers):**

```
CUSTOMER  What goes with these?
ELISE     Those sneakers sharpen up nicely with tapered trousers and a relaxed overshirt.
```

**Two eligible uploads, no explicit focus:**

```
CUSTOMER  Which of these should I wear?
ELISE     Both work. The blazer over the midi dress is the stronger look.
```

**Two eligible uploads, the blazer explicitly focused:**

```
CUSTOMER  What about this one?
ELISE     The camel blazer is the one. Keep everything under it tonal.
K SCAN    Would you like to try that on?   [ TRY IT ON ]   (app-owned block → the blazer)
```
