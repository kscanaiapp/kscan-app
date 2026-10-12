# Build 35 Elise Speech — owner disclosure review

Status: implemented source; owner approved this exact wording on 2026-10-11.
Consent version: `elise-speech-third-party-v1`.
SHA-256 of the version and complete copy object serialized by JSON.stringify:
`c5ff566470b2ed7f070f88bc986004993108ac9cac8700afaebc1fcbd83f80f5`.

## Exact opt-in disclosure

**Turn on spoken replies?**

K Scan AI sends the text of Elise’s spoken reply or greeting to ElevenLabs to generate a synthetic voice.

- Replies may contain information from your conversation.
- ElevenLabs processes this text and generated audio under its privacy policy.
- This speech feature does not send your microphone recordings or photos to ElevenLabs.
- Generated audio is temporarily cached on this device for playback.
- Turning this on allows new eligible replies to play automatically on this device.
- You can turn this off in Privacy settings. Written replies remain available.

Accept: **Turn on spoken replies**. Cancel: **Keep text only**.

Privacy settings links: [K Scan AI Privacy Policy](https://kscan.app/legal/privacy) and
[ElevenLabs Privacy Policy](https://elevenlabs.io/privacy-policy).

Failed grant: “We could not save your choice. Spoken replies remain off. Please try again.”

Failed withdrawal: “Spoken replies are off for this session, but we could not save that change. Please retry before restarting the app.”
The settings provide a retry action for saving withdrawal.

## Implemented behavior and verification boundary

Consent is recorded locally per account, device, feature and disclosure version.
A new device requires consent again. Invalid or missing consent prevents both
automatic playback and direct Speech transport. Withdrawal closes the gate
synchronously, cancels current generation/playback, and removes the saved record.
Storage mutations are ordered so an earlier grant cannot undo later withdrawal.
An unsuccessful withdrawal remains blocked for the current process and reports
the persistence failure; unavailable device storage cannot guarantee persistence
across an app restart. Text replies remain available.

The owner explicitly approved this exact wording in the Build 35 integration
chat on 2026-10-11; the approval constant is true for this version. Technical
backend cost, kill-switch and account-authorization repairs
continue independently. Approval of this disclosure does not certify those
controls, authorize paid calls, or approve a Production deployment.

Physical-device playback, interruptions, cache cleanup and accessibility remain
post-build certification. Source tests exercise consent gating and races without
provider calls. This change is not yet deployed to a reachable TestSprite target.

The copy does not promise zero provider retention, no model training, a specific
processing region, or an account-specific ElevenLabs privacy configuration.
