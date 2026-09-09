/**
 * Loads the real PostHog wrapper against the stubbed vendor SDK, drives every
 * route that could reach PostHog, and prints what the vendor actually saw as
 * JSON on stdout.
 *
 * Run as a child process (one per configuration case) because the wrapper
 * constructs its client once at module load from `process.env` — a fresh
 * process is the only honest way to evaluate a different configuration.
 */

import { pathToFileURL } from 'node:url';

globalThis.__POSTHOG_VENDOR_SPY__ = { events: [] };

const [, , corePath] = process.argv;

const core = await import(pathToFileURL(corePath).href);

// Bridge first, so the per-feature sinks below route through PostHog exactly
// as they do in the app.
core.bridgeAllTelemetrySinks();

// Direct wrapper entry points.
core.forwardTelemetryToPostHog('probe_direct_event', { probe: 'direct' });
core.identifyPostHogUser('probe-user-a');
core.resetPostHogUser();
core.syncPostHogIdentity('probe-user-a');
core.syncPostHogIdentity(null);

// Real feature events through the five bridged sinks — the path a shipped
// feature actually takes.
const [closet, kplus, today, voice, vto] = await Promise.all([
  import(new URL('../../services/closetTelemetry.ts', pathToFileURL(corePath)).href),
  import(new URL('../../services/kplus/kplusTelemetry.ts', pathToFileURL(corePath)).href),
  import(new URL('../../services/todayWithElise/analytics.ts', pathToFileURL(corePath)).href),
  import(new URL('../../services/voice/voiceTelemetry.ts', pathToFileURL(corePath)).href),
  import(new URL('../../services/vto/vtoTelemetry.ts', pathToFileURL(corePath)).href),
]);

closet.emitClosetCandidateEvent('closet_candidate_created', { sourceType: 'camera' });
kplus.emitKPlusEvent('kplus_feature_exposed', { source: 'closet' });
today.emitTodayWithEliseEvent('today_with_elise_impression', { priority: 'high' });
voice.emitVoiceEvent('voice_submit', { surface: 'scanner' });
vto.emitVtoEvent('vto_entry_tap', { origin: 'closet' });

process.stdout.write(
  JSON.stringify({
    configured: core.isPostHogConfigured(),
    clientIsNull: core.posthog === null,
    events: globalThis.__POSTHOG_VENDOR_SPY__.events,
  }),
);
