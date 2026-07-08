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

/** Master switch for TextScan UI entry points and the /text-scan route affordance. */
export const TEXTSCAN_UI_ENABLED =
  process.env.EXPO_PUBLIC_ENABLE_TEXTSCAN === 'true';

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
