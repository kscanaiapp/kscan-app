export const DEFAULT_FEATURE_FREEZE_MESSAGE =
  'This section is temporarily unavailable.';

export const FEATURE_FREEZE_CONFIG_KEY = 'mobile_feature_freeze';

export const CORE_FEATURE_KEYS = [
  'scan',
  'imagePicker',
  'aiTagging',
  'manualTagging',
  'closet',
  'closetFilters',
  'itemDetail',
  'itemShare',
  'auth',
  'logout',
  'passwordReset',
  'privacy',
  'accountDeletion',
] as const;

export const NON_CORE_FEATURE_KEYS = [
  'dressingRooms',
  'shareRooms',
  'circularCloset',
  'styleChat',
  'webLens',
  'outfitRemix',
  'priceDiscovery',
  'resaleValuation',
  // Looks are currently created from Dressing Rooms and are treated as
  // near-term Outfit Remix composition surfaces during focused beta mode.
  'outfitRemixLooks',
  // TextScan is a non-core companion mode until backend matching is verified.
  'textScan',
  // AI Stylist expansion: owned-closet manual builder, AI outfit suggestions,
  // and Dressing Room outfit decisions. Coexists with outfitRemixLooks; the
  // legacy Dressing Room → Looks flow is unchanged.
  'aiStylist',
] as const;

export type CoreFeatureKey = (typeof CORE_FEATURE_KEYS)[number];
export type NonCoreFeatureKey = (typeof NON_CORE_FEATURE_KEYS)[number];
export type FeatureKey = CoreFeatureKey | NonCoreFeatureKey;

export const CORE_FEATURE_SET = new Set<string>(CORE_FEATURE_KEYS);
export const NON_CORE_FEATURE_SET = new Set<string>(NON_CORE_FEATURE_KEYS);

export const DEFAULT_FEATURE_FREEZE_CONFIG = {
  schemaVersion: 1,
  featureFreeze: false,
  freezeMessage: DEFAULT_FEATURE_FREEZE_MESSAGE,
  updatedAt: null,
} as const;

// Dev-only local switch for beta testing. Change to true/false locally if needed;
// production builds always use remote config unless this remains null.
export const DEV_FEATURE_FREEZE_OVERRIDE: boolean | null = __DEV__ ? null : null;

// ── TextScan UI rollout flags ────────────────────────────────────────────────
// These are intentionally environment-driven so the TextScan UI can be built and
// reviewed without affecting release builds. Defaults are all false.

/** Master switch for TextScan UI entry points and the /text-scan route affordance.
 *  Defaults to enabled; set EXPO_PUBLIC_ENABLE_TEXTSCAN=false to hide TextScan. */
export const TEXTSCAN_UI_ENABLED =
  process.env.EXPO_PUBLIC_ENABLE_TEXTSCAN !== 'false';

/** Enables demo/preview result data on the TextScan results state. Off by default. */
export const TEXTSCAN_DEMO_RESULTS_ENABLED =
  process.env.EXPO_PUBLIC_TEXTSCAN_DEMO_RESULTS === 'true';

/** Shows a non-interactive voice-input placeholder block for design review only. */
export const TEXTSCAN_VOICE_PLACEHOLDER_ENABLED =
  process.env.EXPO_PUBLIC_TEXTSCAN_VOICE_PLACEHOLDER === 'true';

/** Enables real backend text analysis for TextScan. Disabled by default. */
export const TEXTSCAN_BACKEND_ENABLED =
  process.env.EXPO_PUBLIC_TEXTSCAN_BACKEND_ENABLED === 'true';

// ── VoiceScan placeholder flag ───────────────────────────────────────────────
/**
 * Master switch for VoiceScan interactivity. VoiceScan is planned but inactive
 * for the current launch; the flag is permanently false here so the UI only
 * renders a non-interactive "Coming Soon" placeholder. No microphone permission
 * request, recording, backend call, or local state mutation should occur while
 * this flag is false.
 */
export const VOICESCAN_ENABLED = false;

// ── Scan Results V2 UI rollout flags ─────────────────────────────────────────
export const SCAN_RESULTS_V2_UI_ENABLED =
  process.env.EXPO_PUBLIC_SCAN_RESULTS_V2_UI === 'true';

/** Enables demo/preview data for Scan Results V2 layout review. Off by default. */
export const SCAN_RESULTS_DEMO_UI_ENABLED =
  process.env.EXPO_PUBLIC_SCAN_RESULTS_DEMO_UI === 'true';

// ── Scan Room V2 UI rollout flags ───────────────────────────────────────────
export const SCAN_ROOM_V2_UI_ENABLED =
  process.env.EXPO_PUBLIC_SCAN_ROOM_V2_UI === 'true';

// ── Shared Dressing Room Chat ────────────────────────────────────────────────
/**
 * Enables native in-app Dressing Room chat (real shared messaging) for the room
 * owner and authorized participants. Off by default; enabling requires owner
 * approval and the shared-messaging migration to be applied. Item/image emoji
 * reactions and the read-only public preview are independent of this flag.
 */
export const ROOM_CHAT_ENABLED =
  process.env.EXPO_PUBLIC_ROOM_CHAT_ENABLED === 'true';

// ── Home Navigation V2 UI rollout flag ─────────────────────────────────────────
export const HOME_NAVIGATION_V2_ENABLED =
  process.env.EXPO_PUBLIC_HOME_NAVIGATION_V2 === 'true';

/** Enables the onboarding framework V1 shell for unauthenticated users. */
export const ONBOARDING_FRAMEWORK_V1_ENABLED =
  process.env.EXPO_PUBLIC_ONBOARDING_FRAMEWORK_V1 === 'true';

/** Master switch for the bright luxury account/home onboarding and Home visual pass. */
export const ACCOUNT_HOME_UX_V1_ENABLED =
  process.env.EXPO_PUBLIC_ACCOUNT_HOME_UX_V1 === 'true';
/** Enables cloud metadata sync for saved scans. Disabled by default. */
export const CLOUD_SAVED_SCANS_ENABLED =
  process.env.EXPO_PUBLIC_CLOUD_SAVED_SCANS_ENABLED === 'true';

// ── Dressing Rooms DR-1 canonical item / commerce / dedupe ───────────────────
/**
 * Canonical Dressing Room item normalization (provenance + schema extension).
 * Default OFF — legacy snapshot writers remain authoritative until enabled.
 */
export const DRESSING_ROOM_CANONICAL_ITEM_V1 =
  process.env.EXPO_PUBLIC_DRESSING_ROOM_CANONICAL_ITEM_V1 === 'true';

/**
 * Persist retailer-neutral purchaseOptions into snapshot_payload.
 * Default OFF — does not change current tester behavior.
 */
export const DRESSING_ROOM_COMMERCE_PRESERVATION_V1 =
  process.env.EXPO_PUBLIC_DRESSING_ROOM_COMMERCE_PRESERVATION_V1 === 'true';

/**
 * Idempotent duplicate suppression for Dressing Room item inserts.
 * Default OFF.
 */
export const DRESSING_ROOM_DEDUPE_V1 =
  process.env.EXPO_PUBLIC_DRESSING_ROOM_DEDUPE_V1 === 'true';

/**
 * Next-build Saved Scan cloud image upload pathway. Default OFF.
 * Must not be enabled for current testers without an approved client release.
 */
export const SAVED_SCAN_CLOUD_IMAGES_V1 =
  process.env.EXPO_PUBLIC_SAVED_SCAN_CLOUD_IMAGES_V1 === 'true';

// ── Private Dressing Room (Build 3: Dressing Rooms V1, Phase 1) ──────────────
/**
 * The device-local, actor-private Dressing Room workspace under
 * /stylist/dressing-room. Default OFF; only the literal string 'true' enables
 * it, so a missing, false or malformed value all fail closed.
 *
 * INDEPENDENT OF THE COLLABORATIVE FREEZE. `dressingRooms` in
 * NON_CORE_FEATURE_KEYS freezes the COLLABORATIVE cloud product; it says
 * nothing about this workspace, and this flag says nothing about that product.
 * The two are orthogonal on purpose: freezing a cloud surface that has
 * membership, RLS and share tokens is a different decision from shipping a
 * private local one, and tying them would make each undeployable without the
 * other.
 */
export const PRIVATE_DRESSING_ROOM_V1 =
  process.env.EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_V1 === 'true';

/**
 * Phase 3 slot swaps, undo and outfit comparison.
 *
 * Default OFF; only the literal string 'true' enables it, so missing, false
 * and malformed all fail closed.
 */
export const PRIVATE_DRESSING_ROOM_INTERACTIONS_V1 =
  process.env.EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_INTERACTIONS_V1 === 'true';

/**
 * NESTED, and this derived constant is the ONLY thing any caller reads.
 *
 * Interactions require the workspace itself, so the Phase 3 flag can never
 * override the Phase 2 flag — turning interactions on without the workspace
 * yields nothing, by construction rather than by every call site remembering
 * to check both. Mirrors CLOSET_CANDIDATE_STAGING_ACTIVE above, so no second
 * flag evaluator is introduced.
 *
 * With this OFF, Phase 2 outfit viewing remains fully functional: no swap
 * controls, no undo, no comparison, and no interaction storage is read,
 * created or mutated.
 */
export const PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE =
  PRIVATE_DRESSING_ROOM_V1 && PRIVATE_DRESSING_ROOM_INTERACTIONS_V1;

/**
 * Phase 4 Elise orchestration: bounded occasion interpretation, Build Around
 * This, and the on-device Make It More Casual action.
 *
 * Default OFF; only the literal string 'true' enables it, so missing, false and
 * malformed all fail closed.
 */
export const PRIVATE_DRESSING_ROOM_ELISE_V1 =
  process.env.EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_ELISE_V1 === 'true';

/**
 * NESTED TWICE, and this derived constant is the ONLY thing any caller reads.
 *
 * Elise orchestrates interactions, and interactions require the workspace, so
 * the Phase 4 flag can never override either one below it. Mirrors
 * PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE above rather than introducing a
 * second flag evaluator.
 *
 * With this OFF: no Phase 4 UI renders, no Edge Function is invoked, no alias
 * map is built, and Phases 1–3.5 behave exactly as they did before — including
 * the manual occasion chips, which Phase 4 only ever adds to.
 *
 * IMPORTANT: this is a BUILD-TIME flag. It is read once at bundle time, so a
 * Metro server started without it yields a flag-OFF app no matter what the
 * device does later.
 */
export const PRIVATE_DRESSING_ROOM_ELISE_ACTIVE =
  PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE && PRIVATE_DRESSING_ROOM_ELISE_V1;

/** Phase 5 actor-scoped, device-local Saved Looks. Default OFF. */
export const PRIVATE_DRESSING_ROOM_SAVED_LOOKS_V1 =
  process.env.EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_SAVED_LOOKS_V1 === 'true';

/**
 * Saved Looks is a leaf capability under the existing private workspace and
 * Elise gates. Callers use only this derived value, so no route, provider, read,
 * write, or missing-piece action can start when any parent is disabled.
 */
export const PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE =
  PRIVATE_DRESSING_ROOM_ELISE_ACTIVE && PRIVATE_DRESSING_ROOM_SAVED_LOOKS_V1;

// ── Build 5 — Today with Elise V1 (Elise V3 Proactive Intelligence) ──────────
/**
 * Master switch for the Home "Today with Elise" card. Default OFF.
 * Only the exact string "true" opts in; absent / false-like / malformed → OFF.
 * Production profiles must leave this unset until an authorized enablement phase.
 */
export function resolveTodayWithEliseV1Enabled(
  value: string | undefined = process.env.EXPO_PUBLIC_TODAY_WITH_ELISE_V1,
): boolean {
  return value === 'true';
}

export const TODAY_WITH_ELISE_V1 = resolveTodayWithEliseV1Enabled();

/**
 * Derived Home surface capability. Callers MUST read this (not the leaf env
 * alone) so child flags cannot activate without the parent.
 */
export const TODAY_WITH_ELISE_ACTIVE = TODAY_WITH_ELISE_V1;

/** Generated greeting variation — deferred; fails closed without parent. */
export function resolveTodayWithEliseGeneratedGreetingV1Enabled(
  value: string | undefined = process.env
    .EXPO_PUBLIC_TODAY_WITH_ELISE_GENERATED_GREETING_V1,
): boolean {
  return value === 'true';
}

export const TODAY_WITH_ELISE_GENERATED_GREETING_V1 =
  resolveTodayWithEliseGeneratedGreetingV1Enabled();

export const TODAY_WITH_ELISE_GENERATED_GREETING_ACTIVE =
  TODAY_WITH_ELISE_ACTIVE && TODAY_WITH_ELISE_GENERATED_GREETING_V1;

/** Optional weather enrichment — fails closed without parent. */
export function resolveTodayWithEliseWeatherV1Enabled(
  value: string | undefined = process.env.EXPO_PUBLIC_TODAY_WITH_ELISE_WEATHER_V1,
): boolean {
  return value === 'true';
}

export const TODAY_WITH_ELISE_WEATHER_V1 =
  resolveTodayWithEliseWeatherV1Enabled();

export const TODAY_WITH_ELISE_WEATHER_ACTIVE =
  TODAY_WITH_ELISE_ACTIVE && TODAY_WITH_ELISE_WEATHER_V1;

/**
 * Pure resolvers for tests. When Private Dressing Room is unavailable, the
 * priority engine must not emit a dead Dressing Room primary action.
 */
export function resolveTodayWithEliseActive(
  parent: boolean = TODAY_WITH_ELISE_V1,
): boolean {
  return parent === true;
}

export function resolveTodayWithEliseGeneratedGreetingActive(
  parent: boolean = TODAY_WITH_ELISE_V1,
  greeting: boolean = TODAY_WITH_ELISE_GENERATED_GREETING_V1,
): boolean {
  return parent === true && greeting === true;
}

export function resolveTodayWithEliseWeatherActive(
  parent: boolean = TODAY_WITH_ELISE_V1,
  weather: boolean = TODAY_WITH_ELISE_WEATHER_V1,
): boolean {
  return parent === true && weather === true;
}

/**
 * DR-2: client may send owned dressing_room_item stable-ID attachments.
 * Default OFF — next-build activation only.
 */
export const ELISE_DRESSING_ROOM_ATTACHMENTS_V1 =
  process.env.EXPO_PUBLIC_ELISE_DRESSING_ROOM_ATTACHMENTS_V1 === 'true';

/**
 * DR-2: client may send shared_item / shared_room_item stable-ID attachments.
 * Default OFF. Independent of wardrobe shared retrieval flags.
 */
export const ELISE_SHARED_ROOM_EVIDENCE_V1 =
  process.env.EXPO_PUBLIC_ELISE_SHARED_ROOM_EVIDENCE_V1 === 'true';

// ── Dressing Rooms DR-3 collaborative / interactive layer ────────────────────
/**
 * Master client switch for DR-3 collaboration UX (reactions desired-state RPC,
 * cursor messages, flat replies, bounded refresh). Default OFF.
 * Security is server-enforced regardless of this flag.
 */
export const DRESSING_ROOM_COLLABORATION_V1 =
  process.env.EXPO_PUBLIC_DRESSING_ROOM_COLLABORATION_V1 === 'true';

/**
 * Idempotent desired-state item reactions via RPC. Default OFF.
 */
export const DRESSING_ROOM_REACTIONS_V1 =
  process.env.EXPO_PUBLIC_DRESSING_ROOM_REACTIONS_V1 === 'true';

/**
 * Cursor-paginated room messages + client_message_id sends. Default OFF.
 */
export const DRESSING_ROOM_MESSAGES_V1 =
  process.env.EXPO_PUBLIC_DRESSING_ROOM_MESSAGES_V1 === 'true';

/**
 * One-level reply/thread UI. Default OFF. Requires messages V1.
 */
export const DRESSING_ROOM_THREADS_V1 =
  process.env.EXPO_PUBLIC_DRESSING_ROOM_THREADS_V1 === 'true';

/**
 * Bounded-refresh collaboration sync (Realtime remains off). Default OFF.
 */
export const DRESSING_ROOM_REALTIME_SYNC_V1 =
  process.env.EXPO_PUBLIC_DRESSING_ROOM_REALTIME_SYNC_V1 === 'true';

/**
 * Per-user per-room read-state. Default OFF — not required by current UI.
 */
export const DRESSING_ROOM_READ_STATE_V1 =
  process.env.EXPO_PUBLIC_DRESSING_ROOM_READ_STATE_V1 === 'true';

/**
 * Shared-room item contributions (recipient add / edit-own / remove-own).
 * Default OFF: requires the shared_room_item_contributions migration
 * (created_by ownership + participant policies) in production before any
 * control may point at these mutations. Chat and reactions are NOT gated
 * here — their participant policies are already deployed.
 */
export const SHARED_ROOM_CONTRIBUTIONS_V1 =
  process.env.EXPO_PUBLIC_SHARED_ROOM_CONTRIBUTIONS_V1 === 'true';

// ── Scan Identification backend (KS-REL-008C) ────────────────────────────────
/**
 * Routes the image Scan analyze call through the app-side `scan-identify`
 * Supabase Edge Function (Gemini vision) instead of the legacy Render
 * `/api/analyze` endpoint. Disabled by default — enabling requires owner
 * approval and an authenticated Scan flow (the Edge Function rejects anon calls).
 * Does not affect TextScan.
 */
export const SCAN_IDENTIFY_BACKEND_ENABLED =
  process.env.EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED === 'true';

// ── Scanner fashion-identification-v2 rollout (Phase 2B.2) ───────────────────
/**
 * Routes Scanner image identification through the canonical
 * `fashion-identification-v2` contract (intent `identify_and_shop`).
 *
 * WHY BUILD-TIME: this repository has no runtime per-feature rollout service.
 * The remote `mobile_feature_freeze` config is a kill-switch keyed by feature
 * name — it can disable a shipped feature, but it cannot enable an unshipped
 * one, so inverting it into a rollout flag would misrepresent what it means.
 * Every other staged rollout here uses the same EXPO_PUBLIC build-time
 * constant, so this follows that convention rather than introducing a second
 * flag system for one phase.
 *
 * Default false, and only the exact string "true" opts in: the deployed
 * production `scan-identify` does not yet serve V2, so a build that has not
 * explicitly opted in must keep the legacy path byte-for-byte.
 *
 * Scanner only. Elise, StyleChat and Closet intake are unaffected by this flag.
 */
export function resolveScannerIdentificationV2Enabled(
  value: string | undefined = process.env.EXPO_PUBLIC_SCANNER_IDENTIFICATION_V2_ENABLED,
): boolean {
  return value === 'true';
}

/** Scanner V2 identification rollout. Disabled by default. */
export const SCANNER_IDENTIFICATION_V2_ENABLED = resolveScannerIdentificationV2Enabled();

// ── Elise fashion-identification-v2 rollout (Phase 2B.3) ─────────────────────
/**
 * Routes Elise's visual attachment identification through the canonical
 * `fashion-identification-v2` contract with intent `identify_for_style`.
 *
 * DELIBERATELY SEPARATE FROM THE SCANNER FLAG. They gate different consumers of
 * one identification core and will not become safe to enable at the same moment:
 * Scanner's V2 path keeps commerce, Elise's must have none, and Elise
 * additionally depends on `stylechat-generate` accepting `fashionContextV2`.
 * One shared flag would make it impossible to roll out either without the other,
 * and a Scanner regression would force an Elise rollback for no reason.
 *
 * Default false, and only the exact string "true" opts in: the deployed
 * production backend does not yet serve this to Elise, so a build that has not
 * explicitly opted in must keep every current Elise path unchanged.
 *
 * Flag OFF is not a degraded mode — it is exactly today's behaviour.
 */
export function resolveEliseIdentificationV2Enabled(
  value: string | undefined = process.env.EXPO_PUBLIC_ELISE_IDENTIFICATION_V2_ENABLED,
): boolean {
  return value === 'true';
}

/** Elise V2 identification rollout. Disabled by default. Scanner is unaffected. */
export const ELISE_IDENTIFICATION_V2_ENABLED = resolveEliseIdentificationV2Enabled();

// ── AI Stylist expansion (inactive rollout) ──────────────────────────────────
/**
 * Master switch for the AI Stylist expansion UI: Library MY LOOKS sub-nav,
 * owned-item manual Look builder, Style This / Style for Event flows, and
 * Dressing Room outfit decisions (voting, winner, "I'm wearing this").
 * Default false: the feature ships dark and stays inactive in the current
 * production configuration. Enable locally with
 * EXPO_PUBLIC_AI_STYLIST_ENABLED=true. It additionally respects the remote
 * non-core feature freeze via the 'aiStylist' key.
 */
export const AI_STYLIST_UI_ENABLED =
  process.env.EXPO_PUBLIC_AI_STYLIST_ENABLED === 'true';

/**
 * Separate switch for invoking the style-outfit-generate Edge Function. Kept
 * apart from the UI switch so the manual builder and room decisions can be
 * tested before the AI backend is deployed. Default false.
 */
export const AI_STYLIST_BACKEND_ENABLED =
  process.env.EXPO_PUBLIC_AI_STYLIST_BACKEND_ENABLED === 'true';

/**
 * Subordinate capability boundary for StyleChat Closet attachments (Phase 2).
 * Independent rollout is materially necessary here: the aiStylist UI family
 * can be enabled while the v2-capable stylechat-generate deployment is not
 * yet live. Requires aiStylist; default false. When disabled, attachment
 * controls are hidden and v2 requests are never sent — v1 StyleChat is
 * unchanged.
 */
export const STYLECHAT_ATTACHMENTS_ENABLED =
  process.env.EXPO_PUBLIC_STYLECHAT_ATTACHMENTS_ENABLED === 'true';

/**
 * Elise V2 visual attachments (Batch 2). OFF hides attachment controls, clears
 * actor-bound attachment state, and preserves text-only Elise. Not proof of any
 * privacy processing — the accepted re-encode/sanitize path is authoritative.
 */
export const ELISE_VISUAL_ATTACHMENTS_V1_ENABLED =
  process.env.EXPO_PUBLIC_ELISE_VISUAL_ATTACHMENTS_V1_ENABLED === 'true';

/**
 * Explicit opt-in for the LEGACY StyleChat photo intake (the pre-visual-
 * attachment modal, still on the legacy scan-identify contract).
 *
 * Phase 2B.3 hostile audit: the previous gate was
 * `attachmentsEnabled && !visualAttachmentsEnabled`, which fails OPEN — merely
 * OMITTING EXPO_PUBLIC_ELISE_VISUAL_ATTACHMENTS_V1_ENABLED from a profile that
 * enables attachments would silently revive the legacy intake and its
 * intentless legacy identification. A dormant route must not be one missing
 * environment variable away from active. The legacy surface now additionally
 * requires this exact-string opt-in; no governed profile sets it, and absence
 * of a variable can never activate it.
 */
export const ELISE_LEGACY_PHOTO_INTAKE_ENABLED =
  process.env.EXPO_PUBLIC_ELISE_LEGACY_PHOTO_INTAKE_ENABLED === 'true';

/**
 * Elise E-4 optional structured advice metadata on the client. Additive: text
 * remains authoritative; applied only when enabled and object-shaped.
 */
export const ELISE_ADVICE_METADATA_CLIENT_V1 =
  process.env.EXPO_PUBLIC_ELISE_ADVICE_METADATA_CLIENT_V1 === 'true';
/**
 * DEVELOPMENT-ONLY starting route, for runtime QA harnesses.
 *
 * WHY THIS EXISTS AND NOT A DEEP LINK. Inside an Expo dev client the
 * `kscan://` VIEW intent does not reach expo-router — the dev client owns the
 * scheme — so `adb shell am start -d kscan://stylist/dressing-room` lands on
 * Home with the auth gate reporting `guardAction: 'allow'`. It is not a routing
 * guard problem and no URL form fixes it. Automated QA therefore had to reach
 * deep routes by tapping through the UI, where cached coordinates go stale after
 * every reload and a stray tap silently sends the run somewhere else.
 *
 * This is the dev-only equivalent: Metro's own process environment names the
 * route to land on once, after the auth gate has settled.
 *
 * IMPOSSIBLE IN A RELEASE BUILD. `__DEV__` is checked with an inline literal so
 * the branch folds, and it is evaluated BEFORE the variable is read. Absent from
 * every EAS profile — asserted by test — so a production build has nothing to
 * honour. It adds no user-visible control and changes no production route.
 *
 *     EXPO_PUBLIC_DEV_INITIAL_ROUTE=/stylist/dressing-room
 */
export const DEV_INITIAL_ROUTE: string | null =
  typeof __DEV__ !== 'undefined' && __DEV__ === true
    ? (process.env.EXPO_PUBLIC_DEV_INITIAL_ROUTE ?? '').trim().startsWith('/')
      ? (process.env.EXPO_PUBLIC_DEV_INITIAL_ROUTE ?? '').trim()
      : null
    : null;

// ── Closet testing bundle (internal testing builds) ──────────────────────────
/**
 * Separates Closet from Recent Scans as distinct domains and enables the
 * non-destructive "Add to Closet" promotion on Recent Scan detail.
 *
 * Default OFF: with the flag false the Library renders exactly as before and no
 * Closet surface is reachable. Enabling changes only which datasets are listed
 * and adds the promotion affordance — it never alters Recent Scan commerce.
 *
 * IMPORTANT: this flag gates UI and write ENTRY POINTS only. Once a Closet
 * record exists on disk it is plain versioned JSON; reading, interpreting, and
 * deleting it must never depend on the flag still being enabled.
 */
export const CLOSET_SEPARATION_V1 =
  process.env.EXPO_PUBLIC_CLOSET_SEPARATION_V1 === 'true';

/**
 * Enables native camera / photo-library intake directly into the Closet.
 * Subordinate to CLOSET_SEPARATION_V1 — direct intake with no Closet surface to
 * land in is not a coherent state. Default OFF.
 *
 * Direct intake creates an owned-inventory item only. It never calls
 * scan-identify, never generates purchase options, and never creates a Recent
 * Scan.
 */
export const CLOSET_DIRECT_INTAKE_V1 =
  process.env.EXPO_PUBLIC_CLOSET_DIRECT_INTAKE_V1 === 'true';

/** Resolved capability: direct intake requires the separation surface. */
export const CLOSET_DIRECT_INTAKE_ACTIVE =
  CLOSET_SEPARATION_V1 && CLOSET_DIRECT_INTAKE_V1;

// ── Closet candidate staging (Closet Upgrade Build 1) ────────────────────────
/**
 * Enables the durable ClosetCandidate staging layer: candidate-owned media, exact
 * duplicate detection, classification-only identification, and the minimal
 * candidate status surface.
 *
 * SUBORDINATE TO BOTH EXISTING CLOSET FLAGS. Staging candidates with no Closet
 * surface to review them in, or with no direct-intake entry point to create them
 * from, is not a coherent state — so the derived capability below fails closed
 * when either parent is off, rather than this flag standing alone.
 *
 * WHY BUILD-TIME: identical to the Scanner and Elise V2 rollout flags. This
 * repository has no runtime per-feature rollout service; the remote
 * `mobile_feature_freeze` config is a kill-switch keyed by feature name, so it can
 * disable a shipped feature but cannot enable an unshipped one. Inverting it into
 * a rollout flag would misrepresent what it means, and a second flag system for
 * one build is worse than following the established convention.
 *
 * DEFAULT OFF IN EVERY SHIPPING PROFILE, and only the exact string "true" opts in.
 * The deployed `scan-identify` does not yet accept `identify_for_closet`, so a
 * build that has not explicitly opted in must keep every current Closet path
 * byte-for-byte what it is today. Flag OFF is not a degraded mode — it is exactly
 * today's behaviour.
 *
 * ENABLING THIS BEFORE THE BACKEND IS DEPLOYED PRODUCES A HARD FAILURE BY DESIGN:
 * the Closet adapter has no legacy fallback (a legacy request would shop and
 * create a Recent Scan), so an un-deployed backend answers
 * `classification_contract_rejected` rather than silently degrading.
 */
export function resolveClosetCandidateStagingEnabled(
  value: string | undefined = process.env.EXPO_PUBLIC_CLOSET_CANDIDATE_STAGING_V1,
): boolean {
  return value === 'true';
}

/** Candidate staging rollout. Disabled by default. */
export const CLOSET_CANDIDATE_STAGING_V1 = resolveClosetCandidateStagingEnabled();

/**
 * Resolved capability. Both parents must be on.
 *
 * Gates UI and write ENTRY POINTS only. Once a candidate record exists on disk it
 * is plain versioned JSON: reading, migrating, cleaning up and deleting it must
 * never depend on the flag still being enabled — the same rule the committed
 * Closet already follows.
 */
export const CLOSET_CANDIDATE_STAGING_ACTIVE =
  CLOSET_SEPARATION_V1 && CLOSET_DIRECT_INTAKE_V1 && CLOSET_CANDIDATE_STAGING_V1;

/**
 * Pure resolver for the derived capability, for tests and for any caller that
 * needs to evaluate the composition against explicit inputs rather than against
 * the build-time constants.
 */
export function resolveClosetCandidateStagingActive(
  separation: boolean = CLOSET_SEPARATION_V1,
  directIntake: boolean = CLOSET_DIRECT_INTAKE_V1,
  staging: boolean = CLOSET_CANDIDATE_STAGING_V1,
): boolean {
  return separation === true && directIntake === true && staging === true;
}

/**
 * Closet Build 2 batch review is an additional, fail-closed capability. Turning
 * on Build 1 staging alone preserves the certified single-image flow.
 */
export function resolveClosetBatchReviewV2Enabled(
  value: string | undefined = process.env.EXPO_PUBLIC_CLOSET_BATCH_REVIEW_V2,
): boolean {
  return value === 'true';
}

export const CLOSET_BATCH_REVIEW_V2 = resolveClosetBatchReviewV2Enabled();

export const CLOSET_BATCH_REVIEW_V2_ACTIVE =
  CLOSET_CANDIDATE_STAGING_ACTIVE && CLOSET_BATCH_REVIEW_V2;

export function resolveClosetBatchReviewV2Active(
  separation: boolean = CLOSET_SEPARATION_V1,
  directIntake: boolean = CLOSET_DIRECT_INTAKE_V1,
  staging: boolean = CLOSET_CANDIDATE_STAGING_V1,
  batchReview: boolean = CLOSET_BATCH_REVIEW_V2,
): boolean {
  return (
    resolveClosetCandidateStagingActive(separation, directIntake, staging) &&
    batchReview === true
  );
}

// ── Mirror Selfie staging contract (Build 2.5 Step 1 + Step 2) ──────────────
/**
 * Dedicated Mirror Selfie flag. Gates ONLY the reachability of the crop-staging
 * adapter and hook API (services/closetMirrorStaging.ts,
 * useClosetCandidates().addMirrorGarmentCrops) — no capture UI, camera intake,
 * gallery intake, person detection, or garment segmentation exists behind it.
 *
 * Default OFF, and only the exact string "true" opts in, matching every other
 * rollout flag in this file.
 *
 * Build 2.5 Step 2 made `closet_mirror` a real entry path in the three-way
 * `scan-identify` contract, so a Mirror request is now well-formed IN SOURCE.
 * It is still not completable AT RUNTIME: the deployed `scan-identify` function
 * predates that vocabulary and rejects `closet_mirror` as INVALID_SOURCE. This
 * flag must therefore stay off until the backend contract is deployed and
 * verified — exactly like `CLOSET_CANDIDATE_STAGING_V1` before its backend
 * shipped. Deployment is a necessary condition, not a sufficient one: Steps 3-5
 * (capture, extraction, end-to-end certification) all gate enablement too.
 */
export function resolveMirrorSelfieV1Enabled(
  value: string | undefined = process.env.EXPO_PUBLIC_MIRROR_SELFIE_V1,
): boolean {
  return value === 'true';
}

/** Mirror Selfie staging rollout. Disabled by default. */
export const MIRROR_SELFIE_V1 = resolveMirrorSelfieV1Enabled();

/**
 * Resolved capability. ALL THREE parents must be on: the dedicated Mirror
 * flag, candidate staging, and Build 2 batch review — Mirror crops are always
 * a batch of one to eight, staged and reviewed through the same batch-review
 * surface every other Closet intake uses. Mirrors the nesting pattern of
 * `CLOSET_BATCH_REVIEW_V2_ACTIVE` above rather than introducing a second
 * flag-composition style.
 */
export const MIRROR_SELFIE_V1_ACTIVE =
  MIRROR_SELFIE_V1 && CLOSET_CANDIDATE_STAGING_ACTIVE && CLOSET_BATCH_REVIEW_V2_ACTIVE;

/**
 * Pure resolver for the derived capability, for tests and for any caller that
 * needs to evaluate the composition against explicit inputs rather than
 * against the build-time constants.
 */
export function resolveMirrorSelfieV1Active(
  separation: boolean = CLOSET_SEPARATION_V1,
  directIntake: boolean = CLOSET_DIRECT_INTAKE_V1,
  staging: boolean = CLOSET_CANDIDATE_STAGING_V1,
  batchReview: boolean = CLOSET_BATCH_REVIEW_V2,
  mirrorSelfie: boolean = MIRROR_SELFIE_V1,
): boolean {
  return (
    resolveClosetBatchReviewV2Active(separation, directIntake, staging, batchReview) &&
    mirrorSelfie === true
  );
}
