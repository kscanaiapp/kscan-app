# Scanner Phase 2 + Live VTO source: activation preparation and convergence plan (2026-10-16)

PREPARATION ONLY. Nothing in this document has been executed. No merge into the
integration or backend authority, no deployment, no flag or operator change, no
EAS build and no paid provider call was made by the work it describes.

Authorities when written (reconfirm before acting):

| Line | Branch | SHA |
|---|---|---|
| Mobile | `integration/build35-v1-convergence` | `a4ea4235e8914b59419fa737c8ce150bebe5c21b` |
| Backend | `rebuild/backend-authority-v2` | `c74c99c1ee74d71486347e27a744ad0dd22c8e1a` |
| Deployed `scan-identify` | Staging v81, Production v173 | identical pre-repair bundle, SHA-256 `79678f22...d5fb` |

## 1. The proposals and their heads

| Surface | Branch / PR | State |
|---|---|---|
| Backend: evidence ingestion, brand conflict handling, match tier, destination grading, extracted `publicHost`, regenerated manifests | `repair/scanner-backend-intelligence-20261016`, PR #622 (draft) | pushed; scan-identify backend suite 452 passed, 0 failed; `edgeFunctionSourceParity` 23/23 |
| Mobile: visual evidence, local privacy, three-tier contract, tier panel, harness updates, synced backend tree and manifests | `repair/scanner-intelligence-commerce-20261016`, PR #621 (draft) | pushed; the privacy and contract branches are merged into it (see section 2) |
| Privacy-only and contract-only histories | `repair/scanner-local-privacy-20261016`, `repair/scanner-commerce-contract-20261016` | pushed for traceability, NOT separate PRs |
| Live VTO native: view mount, camera ownership, capability stages, garment swap | `repair/live-vto-native-view-mount-20261016` | see the final report for the PR |

Why one mobile PR and not three: the privacy, evidence and contract changes edit
the same request and persistence files (`scannerScanRequest.ts`, the strict VM
test harnesses) and the contract tests need the evidence module. Run
independently, each would be red for reasons that belong to the others. The
history is preserved: the three branches are ancestors of #621's head.

## 2. Evidence on the combined mobile candidate

Canonical runner `node scripts/run-all-tests.js` (real `npm ci` tree, Windows):
11,180 tests, 11,082 passed, 0 failed, 98 skipped (Apple-only and shell-specific
environment skips; skipped is not passed). `tsc --noEmit`: clean. This was the
candidate before three trailing merges that added only a documentation file and
two Kotlin test files; CI on the PR heads is the exact-head evidence.

## 3. Dependency matrix: source integrated, deployed, in the binary, runtime-capable, certified, enabled

None of these stages is inferred from another.

| Capability | Source integrated | Backend deployed | In a binary | Runtime capable | Physically certified | Customer enabled |
|---|---|---|---|---|---|---|
| Visual-evidence envelope (request + response) | NO (draft PRs) | NO (v81 / v173 are pre-repair) | NO | n/a | NO | NO |
| Generic logo/wordmark prompt, conflict-safe brand | NO | NO | n/a | n/a | NO (no deployed-model accuracy test; the New Balance photo is deferred) | NO |
| Match tiers (Exact / Same Brand / Similar) | NO | NO | NO | n/a | NO | NO |
| Search-handoff destination grading | NO | NO | n/a | n/a | NO | NO |
| Local Scanner privacy (Android native) | NO | n/a | NO | compile and 7 JVM tests pass; never run on a device | NO | NO |
| Local Scanner privacy (iOS) | native Vision code already on the line; Scanner dispatch guard NO | n/a | NO | NO | NO | NO |
| Live VTO native view mount, capability stages, garment swap | NO | n/a | NO | `capable` / `runtimeReady` are FALSE by a closed gate | NO | NO (flag unset, operator off in Production) |

Genuinely new in the match-tier work: there is NO producer of exact-product proof
(`exactIdentity`). Exact Match can therefore not appear in production today; the
contract, persistence and UI are ready for the day a verified identity source
exists. That is honest, not a gap in the wiring.

## 4. What changes at deploy time

- Backend: `scan-identify` source and `_shared/net/{publicHost,safeRemoteMedia}.ts`;
  `config/edge-function-manifest.json` and `config/cross-path-parity-manifest.json`
  regenerated with the repository generators on the proposal branches.
- No migration. No new environment variable or secret (checked by diffing the
  backend change for `Deno.env` and `readEnv` additions: none).
- No `package.json`, lockfile, `app.json` or `eas.json` change. The Android privacy
  module adds Gradle dependencies only: ML Kit face-detection 16.1.7, pose-detection
  18.0.0-beta5, text-recognition 16.0.1 (bundled, not Play-delivered). Binary size
  impact is UNMEASURED. pose-detection is beta and is not needed by the Scanner
  itself (it serves the existing Closet extraction API of the same module).
- Existing feature controls that govern the Scanner path (names only, no values):
  `SHOPPING_ENABLED` kill switch, `SCAN_IDENTIFY_BACKEND_ENABLED`, the Scanner V2
  session flag, `EXPO_PUBLIC_LIVE_VTO_ENABLED` (unset in every EAS profile).

## 5. Proposed single convergence order (not executed)

1. Reconfirm both authority SHAs and that no other lane changed `scan-identify`
   or `config/*manifest.json`.
2. Review and merge backend PR #622 into `rebuild/backend-authority-v2` through
   its governed path. Re-run the manifest generators ONLY if the authority moved
   since #622's last commit; never edit the authority to satisfy a red gate.
3. Governed Staging deployment of `scan-identify` in an exclusive, authorized
   window (see the Staging runbook in `docs/` for the workflow inputs). Read back:
   function version, bundle hash against the merged source, effective flags. Zero-spend
   smoke first (health, auth rejection, malformed body); any provider call only
   inside the existing ledger caps and with fresh owner authorization.
4. Merge mobile PR #621 (after 2, so its synced backend tree and manifests equal
   the authority). Regenerate the manifests if step 2 changed them.
5. Merge the Live VTO native PR. It is independent of 2-4 at the file level.
6. Owner-authorized EAS build from the exact merged SHA; physical-device
   certification (section 7).
7. Production `scan-identify` deployment only after Staging evidence and owner
   approval, through the governed workflow with its protected reviewer approval.

## 6. Approvals this needs (all owner decisions)

- Android PII native module on this line: the iOS-line guard that declared the
  module Apple-only was replaced by an explicit Apple + Android declaration, with
  Kotlin confined to `android/`, model assets still forbidden and the ML Kit
  dependencies pinned to exactly three audited artifacts
  (`mirrorIosVisionParity.test.js`). Without it the Android Scanner fails closed
  (no raw-image fallback exists).
- Binary-size and store-review impact of ML Kit on Android (unmeasured).
- Behaviour change: with no exact-product proof, results previously labelled
  "Exact match candidate" now read as close/similar matches.
- Behaviour change: search-page (Google Shopping) offers remain eligible but are
  ranked below direct retailer pages and carry no tier.
- Shared Live launcher semantics: switching to AI Photo now ends a Live session.
- Camera ownership: the Scanner preempts Live and Live is refused while the Scanner
  camera is mounted.
- The manifest rows added to the VTO integration manifest.

## 7. Rollback

- Backend: pin the pre-promotion SHA `c74c99c1` and the deployed bundles (Staging
  v81, Production v173, SHA-256 above) and redeploy them through the governed
  workflow. The `SHOPPING_ENABLED` kill switch disables all commerce independently.
- Mobile: the prior build. The privacy proof guard has no off switch by design;
  disabling local masking would mean shipping the prior build, not a flag.
- Live: unset `EXPO_PUBLIC_LIVE_VTO_ENABLED` / keep the remote Live switch off; the
  native certification gate (`PHYSICAL_CERTIFICATION_APPROVED = false`) means the
  module cannot advertise capability even when registered.
- Do not roll back by editing the manifests; regenerate from the rolled-back tree.

## 8. Deferred to Build 35 certification (not passed, not waived)

The owner's original New Balance photograph; deployed-model recognition accuracy;
native face/plate detector accuracy on real images, rotations and occlusions
(JVM tests exercise the Kotlin geometry and encoding, not ML Kit on a device);
camera and gallery behaviour on physical Android and iOS; Android Samsung
`ETIMEDOUT -110` on a new build; iPhone camera frames; Live garment visibility on
real video; renderer alignment and motion; thermal, frame-rate, battery and
memory; installed IPA/AAB acceptance; fresh retailer relevance measurement
inside the ledger caps; the Staging foreign-Closet control; end-to-end Build 35
customer testing; customer-facing Live activation.
