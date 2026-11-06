Valid ElevenLabs audio whose timing is empty or unusable is normalized to null by the backend adapter. The client previously passed that null to AvatarRuntime, selecting an invented playback mouth cycle. Normalize absent received timing to the existing empty timeline so audio stays usable and lips stay closed.

Regression executes the real provider adapter, client validator and avatar engine together. Empty/missing/malformed timing all fail before the patch with visible mouth states; focused speech, engine, consent, interruption and recovery checks pass 85/85 after. No wire/backend/provider, legal copy, design-token or purchase changes. Physical-device synchronization and TestSprite are not certified.

Finding B35-C-004 P3. Source-only stacked repair for the owner-gated Build35 candidate; no build, deployment or merge.
