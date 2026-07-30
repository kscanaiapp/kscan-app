# Build 5 Phase 0/1 — Today with Elise V1 Contracts

```text
ELISE VERSION: Elise V3 — Proactive Intelligence
ENGINEERING PROGRAM: Build 5
FIRST PRODUCT SURFACE: Today with Elise V1
```

## Scope of this document

Phase 1 contract definitions only. No Home UI card implementation.
Generated greeting and weather Home integration remain deferred gates.

## Product hypothesis

Will users engage with K Scan more frequently when Elise gives them one useful,
personalized reason to open the app today?

## Card-state union

Defined in `types/todayWithElise.ts`.

States: `loading`, `unfinished_look`, `today_owned_look`, `recent_styling`,
`closet_action`, `onboarding`, `partial_look`, `unavailable`, `stale`,
`incompatible`, `unauthorized`, `fallback`.

Every terminal state carries actor scope, headline/explanation keys, primary
and optional secondary actions, approved item refs only, completeness, source,
weather/Dressing Room dependency flags, analytics class, and safe fallback.

Raw Closet blobs and image binaries are prohibited in the card-state contract.

## Priority rules

Locked order in `services/todayWithElise/priorityEngine.ts`:

1. Recent unfinished Look
2. Today’s owned-item Look
3. Continue recent styling
4. Closet action
5. Onboarding

Exactly one priority may control the card. Tie-break for unfinished sessions:
newer `updatedAtMs`, then lexicographically greater `sessionId`.

Stale source data → `stale` refusal. Malformed snapshot → `incompatible`.
Missing actor → `unauthorized`. Flag off → `unavailable`.

When Private Dressing Room is unavailable, Dressing Room primary actions are
not emitted (no dead primary action); evaluation falls through to Closet or
fallback.

## Owned-item eligibility

`services/todayWithElise/eligibility.ts`

- Preferred slots: top, bottom, footwear, outerwear when necessary, safe accessories
- Approved ownership only: `exact_owned`, `probable_owned`
- Prohibits: Recent Scans as ownership, unknown-as-owned, cross-actor items,
  deleted refs, incompatible slots, silent retailer substitution, commerce
  insertion, partial-as-complete, independent Build 4 thresholds
- Outcomes: `complete` | `partial` | `ineligible`

## Build 4 optional confidence adapter

`services/todayWithElise/build4ConfidenceAdapter.ts`

Dispositions: absent, recognized, malformed, unsupported_schema,
excluded_by_policy.

Bare numeric scores are malformed (ignored). Only an explicit Build 4
`excludedByPolicy: true` envelope excludes an item. Build 5 invents no
threshold.

## Weather behavior

`services/todayWithElise/weatherPolicy.ts`

- Freshness: 15 minutes (aligned with StyleChat server cache TTL)
- Timeout budget: 2 seconds
- Failure modes: unavailable, stale, timeout, offline, malformed, flag_off
- Non-blocking for Home, card selection, Closet recommendation, DR navigation
- Reuse existing permission + rounded location precision (1 decimal)
- Never fabricate weather; never reuse stale weather outside window

## Deterministic copy

`services/todayWithElise/copyTemplates.ts`

Bounded templates for morning/afternoon/evening and each state. Generated
greeting variation is deferred.

## Action routing

`services/todayWithElise/actionRouting.ts`

Primary: Tap to Get Ready, Continue Your Look, Open Look, Review Items,
Add Your First Item.

Secondary: Change Something → existing Build 3 Elise modification flow.

Tap to Get Ready requirements include source `today_with_elise`, Build 3
ownership resolution, no automatic commerce, and rapid-tap dedupe (1500 ms).

## Actor invalidation

`services/todayWithElise/actorInvalidation.ts` + Build 3 `actorContext.js`

Generation token + epoch + actorId commit gate. Logout and actor switch
invalidate pending and resolved Today state.

## Analytics

`services/todayWithElise/analytics.ts`

Allowlisted events and properties. Patterned after Closet telemetry.
No second analytics vendor. No offline queue. Prohibited payloads enumerated.

Primary funnel: impression → primary action → Dressing Room opened →
look modified or saved → later return.

## Feature flags

In `constants/featureFlags.ts` (default OFF; absent from EAS profiles):

- `EXPO_PUBLIC_TODAY_WITH_ELISE_V1`
- `EXPO_PUBLIC_TODAY_WITH_ELISE_GENERATED_GREETING_V1`
- `EXPO_PUBLIC_TODAY_WITH_ELISE_WEATHER_V1`

Children require parent. Production profiles must remain unset until authorized.

## Performance plan (measurement required in Phase 2+)

Measure, do not claim:

- Warm / cold Home render
- Local orchestration cost
- Weather / greeting optional paths
- Dressing Room handoff
- Repeated Home mounts
- Duplicate network / analytics
- Rapid primary-action taps

Architecture requirements:

- Existing Home shell renders first
- No full-screen Build 5 spinner
- Optional work does not block Home
- No uncontrolled effect loops
- No repeated Closet scan or recommendation on each render
- No animation dependency for usable content

## Accessibility plan

Phase 2 UI must provide:

- Meaningful screen-reader label for the card
- Meaningful labels for each clothing item
- Logical focus order
- Dynamic Type / large-text behavior
- Minimum button targets
- Reduced-motion behavior (`useReducedMotion`)
- Non-image explanation of the Look
- Contrast review
- Disabled-state and loading-state announcements

## Testing plan

Automated in Phase 1:

- Feature-flag fail-closed matrix + EAS absence
- Priority order, tie-break, stale/malformed/unauthorized
- No dead Dressing Room primary
- Actor A/B stale completion and reauth epoch
- Eligibility complete/partial/ineligible + Build 4 adapter
- Analytics scrub + impression dedupe
- Weather freshness / timeout / offline
- Action routing + rapid-tap dedupe

Deferred: device runtime, hostile audit, EAS production enablement.

## Overlap ledger (summary)

| Path | Classification | Owning build | Build 5 use | Collision risk | Required protection |
|------|----------------|--------------|-------------|----------------|---------------------|
| `types/todayWithElise.ts` | BUILD5_OWNED | Build 5 | Card contracts | Low | Keep pure |
| `services/todayWithElise/**` | BUILD5_OWNED | Build 5 | Engine + adapters | Low | No Scanner edits |
| `constants/featureFlags.ts` | SHARED_REQUIRES_COORDINATION | Shared | Add Today flags only | Medium | Do not flip Scanner/PDR prod flags |
| `components/home/HomeLuxuryTechV1.tsx` | SHARED_REQUIRES_COORDINATION | Build 3 host | Phase 2 mount only | Medium | Additive card; no Home redesign |
| `services/actorContext.js` | BUILD3_CONTRACT_DEPENDENCY | Build 3 | Epoch/commit | Low | Consume unchanged |
| `services/privateSavedLookOwnership.ts` | BUILD3_CONTRACT_DEPENDENCY | Build 3 | Ownership | Low | Consume unchanged |
| `services/privateDressingRoom*` | BUILD3_CONTRACT_DEPENDENCY | Build 3 | Handoff | Medium | Source attribution only |
| `services/closetLibrary.js` / projections | BUILD3_CONTRACT_DEPENDENCY | Build 3 | Reads | Low | Actor-scoped reads |
| `services/weather/**` | BUILD3_CONTRACT_DEPENDENCY | Build 3 | Reuse permission | Low | No second permission flow |
| `services/closetTelemetry.ts` | BUILD3_CONTRACT_DEPENDENCY | Build 3 | Pattern only | Low | Separate Today allowlist |
| `supabase/functions/scan-identify/**` | BUILD4_PROTECTED | Build 4 | Do not edit | High | Frozen |
| `types/fashionIdentificationV2.ts` | BUILD4_PROTECTED | Build 4 | Optional adapter only | Medium | No invented thresholds |
| `tools/scanner-evaluation/**` | BUILD4_PROTECTED | Build 4 | Out of scope | High | Never import |
| `evals/scanner-accuracy/**` | BUILD4_PROTECTED | Build 4 | Out of scope | High | Never import |
| K Scan SVG icon assets | UNRELATED | Product | Preserve | Low | Do not replace |

## Deferred gates

- Broad UI implementation (Phase 2)
- Generated greeting (Phase 3)
- Weather Home integration (Phase 3)
- Physical-device validation
- Production-profile enablement
- EAS builds / TestFlight / Play
- Hostile audit (Phase 4)
- Release integration (Phase 5)
