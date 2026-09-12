#!/usr/bin/env node
/**
 * Measures what THIS environment can honestly measure about the Avatar V10
 * integration: JS-level cost, in a Node process, with a fake audio player.
 *
 * WHAT THIS IS NOT. It is not device latency, not audio latency, not perceived
 * responsiveness, and not a frame-rate measurement. There is no simulator, no
 * device and no real audio pipeline here, so no number below may be quoted as
 * physical-device latency. The architectural claim it exists to support is
 * narrower and checkable: PLAYBACK START DOES NOT WAIT FOR THE AVATAR.
 *
 * Three observations:
 *
 *   1. playback-start cost with the avatar render path idle vs. driven, so the
 *      "avatar gates speech" question is answered by measurement as well as by
 *      the architecture test.
 *   2. per-frame projection + engine cost over a 50-turn conversation.
 *   3. whether anything grows across those 50 turns.
 *
 * Usage:  node scripts/measure-avatar-integration-overhead.js [--turns 50]
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const { loadAdapter, loadTsModule } = require(
  path.join(ROOT, '__tests__', 'fixtures', 'avatarEngineHarness.js'),
);

const TURNS = (() => {
  const index = process.argv.indexOf('--turns');
  const parsed = index === -1 ? NaN : Number.parseInt(process.argv[index + 1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 50;
})();

function transpile(relativePath, requireMap, extras = {}, transform = (s) => s) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(transform(fs.readFileSync(filename, 'utf8')), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console, Date, Error, Promise, Set, Map, Array, Object, JSON, Number, String,
    Boolean, Math, AbortController, setTimeout, clearTimeout,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier in requireMap) return requireMap[specifier];
      if (specifier.startsWith('node:')) return require(specifier);
      throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
    },
    ...extras,
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const ALIGNMENT = (() => {
  const characters = [...'Let us build the look around the coat you already own.'];
  const starts = [];
  const ends = [];
  let cursor = 0;
  for (let i = 0; i < characters.length; i += 1) {
    starts.push(Number(cursor.toFixed(6)));
    cursor += 0.06;
    ends.push(Number(cursor.toFixed(6)));
  }
  return { characters, characterStartTimesSeconds: starts, characterEndTimesSeconds: ends };
})();

const SESSION = '11111111-1111-4111-8111-111111111111';
const AVATAR = 'stylist_portrait_05';

function createLane() {
  const timers = new Map();
  let nextTimer = 1;
  const host = {
    setTimeout(fn, ms) {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    liveTimers: () => timers.size,
  };

  const store = transpile('stores/avatarSpeechStore.ts', {}, {}, (source) =>
    source.replace("import { useSyncExternalStore } from 'react';", ''));

  const players = [];
  const playback = transpile(
    'services/avatars/stylistAudioPlayback.ts',
    {
      'expo-audio': {
        setAudioModeAsync: async () => {},
        createAudioPlayer: () => {
          const player = {
            listeners: new Set(),
            removed: false,
            addListener(_event, handler) {
              player.listeners.add(handler);
              return { remove: () => player.listeners.delete(handler) };
            },
            play() {},
            pause() {},
            remove() {
              player.removed = true;
            },
            emit(status) {
              for (const handler of [...player.listeners]) handler(status);
            },
          };
          players.push(player);
          return player;
        },
      },
    },
    { setTimeout: host.setTimeout, clearTimeout: host.clearTimeout },
  );

  const speech = transpile('services/avatarSpeech.ts', {
    '../stores/avatarSpeechStore': store,
    './avatars/stylistAudioPlayback': playback,
    './avatars/speechAppState': {
      ensureSpeechAppStateListener: () => {},
      registerSpeechInterruptionHandler: () => {},
    },
    './avatars/stylistSpeechClient': {
      requestStylistSpeech: async (request) => ({
        messageId: request.messageId,
        stylistId: request.stylistId,
        voiceProfile: 'feminine',
        mimeType: 'audio/mpeg',
        audioBase64: 'QUJDRA==',
        alignment: ALIGNMENT,
      }),
    },
    './avatars/stylistSpeechFiles': {
      createTemporaryStylistSpeechFile: async ({ messageId }) => `file://${messageId}.mp3`,
      deleteTemporaryStylistSpeechFile: async () => {},
    },
  });

  const { AvatarEngineHostAdapter } = loadAdapter();
  const { deriveAvatarPresentation } = loadTsModule('services/avatars/avatarPresentation.ts');
  const { resolveAvatarSpeakingCoverage } = loadTsModule('services/avatars/avatarAssetCoverage.ts');
  const adapter = new AvatarEngineHostAdapter();

  const render = (motionEpoch) => {
    const state = store.getAvatarSpeechState();
    const scopeMatches =
      state.actorId === 'actor-1' && state.sessionId === SESSION &&
      state.stylistId === AVATAR && state.avatarId === AVATAR;
    const coverage = resolveAvatarSpeakingCoverage(AVATAR);
    const presentation = deriveAvatarPresentation({
      playbackPhase: state.phase,
      playbackScopeMatches: scopeMatches,
      playbackActive: scopeMatches && state.phase === 'playing',
      utteranceGeneration: state.generation,
      eliseProcessing: false,
      listening: false,
      reduceMotion: false,
      mouthCapable: coverage.mouthCapable,
      assetsAvailable: coverage.assetsAvailable,
    });
    adapter.computeFrame({
      avatarId: AVATAR,
      speech: state,
      scopeMatches,
      reduceMotion: false,
      foreground: true,
      motionEpoch,
      hostNowMs: Date.now(),
      ...(presentation.semanticMode ? { semanticMode: presentation.semanticMode } : {}),
    });
    return presentation;
  };

  return { host, store, speech, players, adapter, render };
}

const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r));
};

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    n: sorted.length,
    meanMs: Number((sum / sorted.length).toFixed(4)),
    p50Ms: Number(sorted[Math.floor(sorted.length * 0.5)].toFixed(4)),
    p95Ms: Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))].toFixed(4)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(4)),
  };
}

/**
 * Time from calling the speech service to the native player existing, with the
 * avatar render path either untouched or driven on every store change.
 */
async function measurePlaybackStart({ driveAvatar }) {
  const samples = [];
  for (let turn = 0; turn < TURNS; turn += 1) {
    const lane = createLane();
    if (driveAvatar) lane.render(1);
    const startedAt = process.hrtime.bigint();
    await lane.speech.speakAvatarMessage({
      actorId: 'actor-1',
      sessionId: SESSION,
      messageId: `msg-${turn}`,
      stylistId: AVATAR,
      avatarId: AVATAR,
      source: 'message',
    });
    const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (lane.players.length !== 1) throw new Error('playback was never requested');
    samples.push(elapsed);
    if (driveAvatar) lane.render(1);
  }
  return stats(samples);
}

/** Projection + engine cost per rendered frame, across a full conversation. */
async function measureConversation() {
  const lane = createLane();
  const frameSamples = [];
  const perTurnFrames = [];
  let epoch = 1;

  for (let turn = 0; turn < TURNS; turn += 1) {
    await lane.speech.speakAvatarMessage({
      actorId: 'actor-1',
      sessionId: SESSION,
      messageId: `msg-${turn}`,
      stylistId: AVATAR,
      avatarId: AVATAR,
      source: 'message',
    });
    const player = lane.players[lane.players.length - 1];
    player.emit({ playing: true, currentTime: 0, playbackState: 'readyToPlay' });
    await settle(2);

    // 12.5Hz for a ~3s utterance: the real re-render cadence of the header.
    let frames = 0;
    for (let step = 1; step <= 38; step += 1) {
      const seconds = Number((step * 0.08).toFixed(3));
      player.emit({ playing: true, currentTime: seconds, playbackState: 'readyToPlay' });
      const startedAt = process.hrtime.bigint();
      lane.render(epoch);
      frameSamples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
      frames += 1;
    }
    perTurnFrames.push(frames);

    player.emit({ playing: false, currentTime: 3.1, didJustFinish: true });
    await settle(4);
    lane.render(epoch);
    epoch += 1;
  }

  return {
    frames: stats(frameSamples),
    turns: TURNS,
    framesPerTurn: perTurnFrames[0],
    liveTimersAtEnd: lane.host.liveTimers(),
    retainedTimelineIntervals: lane.adapter.debugState().timelineIntervals,
    finalPhase: lane.store.getAvatarSpeechState().phase,
    /** First-half vs second-half mean, as a drift check across the session. */
    driftMs: Number((
      stats(frameSamples.slice(Math.floor(frameSamples.length / 2))).meanMs -
      stats(frameSamples.slice(0, Math.floor(frameSamples.length / 2))).meanMs
    ).toFixed(4)),
  };
}

(async () => {
  const before = await measurePlaybackStart({ driveAvatar: false });
  const after = await measurePlaybackStart({ driveAvatar: true });
  const conversation = await measureConversation();

  const report = {
    environment: {
      node: process.version,
      platform: process.platform,
      device: 'NONE — Node process, fake audio player',
      claimsPhysicalDeviceLatency: false,
    },
    turns: TURNS,
    playbackStartMs: {
      baselineAvatarPathIdle: before,
      afterAvatarPathDriven: after,
      deltaMeanMs: Number((after.meanMs - before.meanMs).toFixed(4)),
    },
    renderedFrameMs: conversation.frames,
    conversation: {
      turns: conversation.turns,
      framesPerTurn: conversation.framesPerTurn,
      totalFrames: conversation.frames.n,
      meanFrameMsDriftFirstHalfToSecondHalf: conversation.driftMs,
      liveTimersAtEnd: conversation.liveTimersAtEnd,
      retainedTimelineIntervals: conversation.retainedTimelineIntervals,
      finalPhase: conversation.finalPhase,
    },
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
