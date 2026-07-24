# iOS v17 Frontend — Batch 2: Elise V2 Client + Visual Attachments

**Starting checkpoint:** `51bfb54` (Batch 1 secure sessions). No build, no backend deploy, `ios.buildNumber` unchanged ("16").

## Source provenance
| Item | Value |
|---|---|
| Donor branch | `feature/elise-visual-attachment-composer` |
| Donor SHA | `9afe29b145000782afa765c182d8463cd78b1978` |
| Merge base w/ checkpoint | `32addd5` (2026-07-18) |
| Unique donor commits | 47 (spanning Batch 2 **and** Batch 3 DR2–DR4) |

**Accepted Batch-2 commits (integrated by effect):** `a6635ac` visual attachment composer; `d13ba2c` single Scanner-compatible re-encode; `62c9f6e` ownership from resolved provenance; `45b0e50` QA flag.
**Rejected / not integrated (out of Batch 2 scope):** all DR2–DR4 commits (Batch 3); the structured-`privacyProof` scanner-client migration (`a98985c`, scanner workstream #20 — see B2-D01); the avatar/welcome/speech engine (Batch 4).

## Integration method
Base was `32addd5`; v15's changes and the donor's V2 work were separated by 3-way merge (all conflict-free except `scanIdentification.ts`). New V2 files added directly; feature flags added surgically (Batch-2-only).

### Files created (from donor)
`services/style-chat/eliseDirectImageAttachment.ts`, `eliseVisualAttachmentNormalize.ts`, `eliseVisualAttachmentDedup.ts`, `eliseVisualAttachmentTelemetry.ts`, `types/eliseVisualAttachments.ts`, `types/eliseAdvice.ts`.

### Files modified (3-way merged, conflict-free)
`hooks/useStyleChat.ts`, `hooks/useStyleChatAttachments.ts`, `hooks/useScreenReaderEnabled.ts`, `components/style-chat/{StyleChatAttachmentBar,StyleChatPhotoIntake,StyleChatInput}.tsx`, `services/style-chat/{styleChatAttachmentStore,styleChatGreeting,styleChatRepository}.ts`, `services/style-chat/providers/edgeStyleChatProvider.ts`, `services/imageUtils.js`, `types/{styleChatAttachments,ownedClosetItem}.ts`, `app/style-chat/[sessionId].tsx`, `constants/featureFlags.ts`.

### Feature flags added (Batch-2 only, not invented)
`ELISE_VISUAL_ATTACHMENTS_V1_ENABLED`, `ELISE_ADVICE_METADATA_CLIENT_V1`. The 9 `DRESSING_ROOM_*` and room/saved-scan **source** flags in the donor were **excluded** (Batch 3 — not referenced by any integrated Batch 2 code).

### Conflict resolutions
- `edgeStyleChatProvider.ts`: 3-way merge preserved **Batch 1's 30s timeout** AND added V2 attachment serialization/statuses (verified: `TIMEOUT_MS = 30_000`, no 20_000).
- `scanIdentification.ts`: **kept checkpoint version** (3 conflicts were the donor's structured-`privacyProof` migration — see B2-D01).
- `featureFlags.ts`: surgical add of the 2 Batch-2 flags rather than the full merge (which carried Batch-3 flags).

## Superseded / preserved
- Batch 1 preserved: `secureSessionStorage`, `createAuthBootstrapStorage`, AuthSessionContext actor isolation, global password revocation, 30s timeout, transient-failure tolerance. (Verified 37/37 Batch-1 tests pass.)
- `AuthSessionContext.tsx` (v15) supersedes the donor's — not touched.

## Defects
### B2-D01 — StyleChatPhotoIntake assumed the un-integrated structured-privacyProof migration — **P2, FIXED**
- **Root cause:** donor's `StyleChatPhotoIntake` + `scanIdentification.ts` send/require the structured `privacyProof` object (`a98985c`, scanner workstream #20). The checkpoint is uniformly on **`localPrivacyFiltered`** — the integrated backend (`a414ad5` scan-identify) reads `localPrivacyFiltered` (0 `privacyProof` refs) and the main Scanner (`useKScan`) sends `localPrivacyFiltered: true`. Applying the donor's `scanIdentification.ts` would have **broken the main Scanner** (its guard blocks sends lacking `privacyProof`).
- **Repair (narrow):** kept `scanIdentification.ts` unchanged; adapted `StyleChatPhotoIntake` to send `localPrivacyFiltered: true` (the image is still re-encoded + metadata-stripped via the accepted 896/0.65 path — only the attestation format matches the app's uniform contract). No provenance weakened (same contract as the rest of the app).
- **Regression:** `styleChatAttachmentStateMachine` (intake never rewires the scan-room hook) + `imageUploadRegression` pass.

### B2-D02 — greeting-speech-recovery refinement imported ahead of Batch 4 — **P6, DEFERRED TO BATCH 4**
- **Issue:** Batch 2 imported greeting-tracking behavior (`claimGreetingSpeechAttempt` / `noteInsertedGreetingForSpeech` / `getPendingGreetingSpeechMessageId` in `styleChatGreeting.ts` + `useStyleChat.ts`) ahead of the dedicated avatar/welcome/speech batch.
- **Exact failing assertion:** `stylistSpeechRecovery.test.js` → *"StyleChat wiring speaks only persisted new messages and scopes the header to playing"* — the v15 test expects the source to contain `result.inserted && canSpeakNewMessages`; the integrated (donor) `useStyleChat` replaced that with `pendingSpeechMessageId`-based wiring (retained across remount).
- **Exact donor change that triggered it:** donor refined the fresh-insert greeting-**speech** eligibility from a one-shot `result.inserted && canSpeakNewMessages` gate to a `getPendingGreetingSpeechMessageId(...)` retained-eligibility model (so a transient screen-reader probe cannot permanently mute welcome audio).
- **Evidence of no core impact (all pass):** `styleChatTextRequest`, `styleChatAttachmentContract`, `styleChatAttachmentStateMachine`, `eliseV1V2Compatibility`, `eliseAttachmentRecoverySaga`, `styleChatRetryState` (quota), `styleChatSessionLaunchGuard`, `styleChatSessionGreeting` (greeting **text** insertion). The failure is a source-shape assertion about greeting **audio** wiring — no crash, no removal of a completed text response, no attachment breakage, no logout, no quota double-consumption, no data-integrity impact.
- **Batch 4 test plan:** in the avatars/welcome/speech batch, bring the donor-aligned `stylistSpeechRecovery.test.js` (and the mouth-state/portrait manifest work) and verify: one welcome per session, no duplicate greeting, retained speech eligibility across remount, speech failure cannot remove a successful text response, and no quota refund on speech-only failure. Then this assertion closes.
- **Disposition:** test left unchanged (not weakened/deleted); carried to Batch 4.

## VERDICTS
- **REGULAR iOS IMAGE-UPLOAD REGRESSION: PASS.** Repair `79f1106` is **ancestral** to the candidate. Regular-pipeline files unchanged by Batch 2 except a **behavior-preserving** constant-extraction in `imageUtils.js` (896/0.65 values intact). Independent tests: `imageUploadRegression` 9/9, `scanIdentification` 50/50, `scanIdentifyMockValidation` 4/4, `textScanCanonicalPath` 33/33. No Elise change altered or bypassed the regular upload pipeline. (Physical camera/gallery validation remains pending the owner's local iOS build.)
- **ELISE V2 VISUAL ATTACHMENTS: PASS.** V1 text backward-compatible; V2 `contractVersion "2"` sent only with attachments; ordering/dedup/one-pass re-encode (896/0.65)/provenance/safe ownership/failed-send recovery/account-switch+sign-out isolation verified; no raw URI/base64/EXIF/storage-path/model-name leaves the client. Elise V2 suites 66/66 + full attachment/elise set green.
