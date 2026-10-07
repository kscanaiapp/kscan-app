# Build 35 Stylist Speech: Phase 0

Read-only diagnosis completed 2026-10-07 before source repair.

## Authority

```text
BASE_EXPECTED_SHA=f5146318a6f2dcb0457f7c789301d16caf52a267
BASE_ACTUAL_SHA=f5146318a6f2dcb0457f7c789301d16caf52a267
EXPECTED_IS_ANCESTOR_OF_ACTUAL=YES (equal)
BASE_SHA=f5146318a6f2dcb0457f7c789301d16caf52a267
ACTUAL_SHA=f5146318a6f2dcb0457f7c789301d16caf52a267
WORKTREE_CLEAN=YES
BRANCH=repair/build35-stylist-speech-v1
WORKTREE=C:/b35sp
```

The supplied workspace is a bare Git repository. Its existing speech worktree
is clean and is used for this lane. No VTO worktree or presentation is modified.

## Deployment Evidence

Supabase MCP list/get calls independently verified both environments. The
prompt's deployment-absence finding does not describe current live state.
All eleven deployed speech source files in each environment were compared
against this base after normalizing CRLF to LF; all match.

```text
SOURCE_FUNCTION_PRESENT=YES
STAGING_FUNCTION_DEPLOYED=YES (ACTIVE, verify_jwt=true)
PRODUCTION_FUNCTION_DEPLOYED=YES (ACTIVE, verify_jwt=true)
LIVE_VS_SOURCE_DIVERGENCE=NO (all deployed speech files match the base)
DEPLOYED_FUNCTION_VERSION=Staging 73; Production 51
DEPLOYED_FUNCTION_DATE=Staging 2026-08-25T23:07:57.772Z; Production 2026-09-23T22:52:41.225Z
STAGING_PROJECT=K Scan AI Staging
PRODUCTION_PROJECT=KScan App Production
```

Deployment metadata is function-specific, not proof that all other functions
or project release markers match this integration SHA. Production is read-only.

## PHASE0_STYLIST_SPEECH_REPORT

```text
CURRENT_SPEECH_ENTRY_POINTS=useStyleChat persisted greeting/new assistant replies; StyleChatVoiceRetry explicit retry
CURRENT_CLIENT_TRANSPORT=authenticated supabase.functions.invoke, references only, AbortSignal, 20-second timeout
CURRENT_EDGE_FUNCTION=supabase/functions/stylist-speech/index.ts -> handler.ts
CURRENT_PROVIDER=ElevenLabs
CURRENT_PROVIDER_CONFIG_SOURCE=server environment + voiceProfiles.ts secret-name registry
CURRENT_TEXT_PREPROCESSOR=buildSpeechText; hidden blocks/code fences/markdown/control-character removal; whitespace normalization
CURRENT_TEXT_LENGTH_POLICY=1000 UTF-16 code units; sentence then word boundary; response-length parity tests exist
CURRENT_AUDIO_FORMAT=server output-format secret; response audio/mpeg; temporary .mp3
CURRENT_PROVIDER_TIMEOUT=15000 ms via AbortController (body-read error classification incomplete)
CURRENT_PROVIDER_RESPONSE_LIMIT=2500000 bytes checked AFTER response.text(); error inspection 4096 bytes AFTER response.text()
CURRENT_PLAYBACK_OWNER=services/avatarSpeech.ts -> services/avatars/stylistAudioPlayback.ts (expo-audio)
CURRENT_TEMP_AUDIO_OWNER=services/avatars/stylistSpeechFiles.ts; hashed cache name; atomic .pending move; teardown/orphan cleanup
CURRENT_RETRY_AUTHORITY=explicit UI retry; failed generation remains eligible; no automatic retry loop
CURRENT_DEDUP_AUTHORITY=client inFlightKey + bounded 200 confirmed-spoken keys; server isolate-local inFlight operation set
CURRENT_CONCURRENCY_AUTHORITY=client generation replacement/releaseResources; server isolate-local burst/day counters
CURRENT_INTERRUPTION_AUTHORITY=speechAppState inactive/background stop; composer stop; native start/stall watchdogs
CURRENT_ACTOR_BOUNDARY=AuthSessionContext stop on auth transitions/logout; useStyleChat actor/session scope cleanup; generation guards
CURRENT_KILL_SWITCH=no dedicated global server speech switch
CURRENT_DISABLE_MECHANISM=actor-scoped voice preference off; immediate stop; silent avatars; screen-reader gating
HISTORICAL_502_TESTABLE=deployment exists; governed paid reproduction requires bounded owner authorization and synthetic actor fixture
HISTORICAL_502_REPRODUCED=NOT_RUN (not authorized)
CURRENT_FAILURE=no current live provider/playback failure established
FAILURE_LAYER=source guard gaps V (response ceiling), S/U (body timeout/parsing), M (format), AD/AC (pending player setup)
SOURCE_DEFECTS=unbounded body materialization before ceiling; unclassified body-read failures; JSON null access; output format accepts non-MP3 despite MP3 response; pending playback setup lacks cancellation
DEPLOYMENT_DEFECTS=NONE_OBSERVED
CONFIG_DEFECTS=NO_LIVE_VALUE_EVIDENCE; all required Staging secret names present, sealed values unavailable
PROVIDER_DEFECTS=UNKNOWN; no generating provider invocation
CLIENT_PLAYBACK_DEFECTS=pending asynchronous player setup can start after stop/switch; shared handle assignment can overwrite newer ownership
DEVICE_ONLY_GAPS=audibility/decoder/audio-focus/silent-mode parity physically unproven
FILES_EXPECTED_TO_CHANGE=speech provider/client lifecycle sources and targeted tests; speech audit evidence; manifest only if required by its generator
STOP_CONDITIONS=diverged integration history; owner credential/billing/quota/access/removed voice blocker; unauthorized paid invocation; unsafe staging deployment
SHARED_SURFACE_FOLLOWUP_REQUIRED=NO
```

These are source inspection findings to reproduce in focused tests; none is
asserted as the cause of the old 502 or a current device failure.

## Historical Failure and Taxonomy

```text
HISTORICAL_FAILURE_DATE=2026-07-14 (diagnosis document commit)
CURRENT_DEPLOYMENT_NEWER_THAN_FAILURE=YES (both environments)
OLD_502_MAPPING_SOURCE=production-stylist-voice-502-diagnosis.md; old adapter collapsed non-429 rejection to PROVIDER_UNAVAILABLE
500=SERVER_CONFIGURATION; INTERNAL_ERROR
502=PROVIDER_AUTH_FAILED; PROVIDER_VOICE_UNAVAILABLE; PROVIDER_MODEL_UNAVAILABLE; PROVIDER_INVALID_REQUEST; PROVIDER_UNAVAILABLE; PROVIDER_RESPONSE_INVALID; PROVIDER_RESPONSE_TOO_LARGE
503=NONE in current speech mapping
504=PROVIDER_TIMEOUT (fetch-stage catch)
429=PROVIDER_QUOTA_EXCEEDED; BURST_LIMIT; DAILY_LIMIT
DIAGNOSTIC_OPACITY=rate limit and quota currently collapse; body-read failures can become INTERNAL_ERROR
```

The last-24-hour Staging logs query returned a backend error, so it supplies no
failure evidence. No raw conversation content was queried or used as a fixture.

## Provider, Audio, Replay, and Privacy

The current ElevenLabs API reference still documents
`POST /v1/text-to-speech/{voice_id}/with-timestamps`, the output-format query
parameter, and `audio_base64` plus character alignment in JSON:
https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps

Staging secret inventory confirms the key, model, output format, and all ten
stylist voice secret names exist. Listing yields names/digests, not secret
values. No syntax/resource/access claim is possible for sealed live values.
No credential is created, replaced, printed, or sent to the client.

```text
PROVIDER_FORMAT=sealed configuration; source currently accepts generic output-format token
SERVER_MIME_TYPE=audio/mpeg
CLIENT_EXPECTED_MIME=audio/mpeg
TEMP_FILE_EXTENSION=.mp3
PLAYER_SUPPORTED_FORMAT=MP3 expected via expo-audio native players; physical certification pending
REGENERATE=YES on explicit retry/replay; automatic confirmed-success repeats suppressed in-process
REUSE_TEMP_AUDIO=NO
REUSE_PERSISTED_AUDIO=NO
EXPLICIT_RETRY_BEHAVIOR=regenerate; same in-flight operation suppressed; server burst/day guards apply
SPEECH_KILL_SWITCH_EXISTS=NO global server switch; YES client voice-off path
SPEECH_DISABLE_PATH=actor preference off -> stopAvatarSpeechPlayback; gated new generation
KILL_SWITCH_DECISION=preserve existing immediate client disable; no evidence requires a remote-config framework or changing live flags
TEXT_REMAINS_AUTHORITATIVE=YES by source design; speech async errors isolated from text persistence
SPEECH_DISCLOSURE_COVERAGE=NOT_ESTABLISHED; reviewed in-app privacy/source policy has no explicit external speech synthesis disclosure
LEGAL_COPY_FOLLOWUP_REQUIRED=YES (owner/legal review; no legal rewrite)
BOUNDED_RUNTIME_PROOF_AUTHORIZED=NO
PROVIDER_INVOCATIONS=0
DEVICE_CERTIFICATION=PENDING
SPEAKING_PORTRAIT=NOT_EVALUATED before audible proof
```

The client rate controls and server limiter are in-process/isolate-local,
not distributed quota guarantees. This lane does not add persisted speech.

## Initial Validation Readiness

Deno and Node are installed. Baseline speech Deno discovery found eleven test
files, but type resolution failed because this clean worktree has no installed
node_modules. Install locked dependencies before rerunning. TestSprite 0.5.0
and auth preflight pass; the account lists one existing Staging backend project.
No TestSprite run or paid provider workflow has been dispatched.
