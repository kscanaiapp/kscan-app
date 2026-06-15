# Android Release Quarantine — K Scan AI

* Created: 2026-06-14
* Branch: release/android-1.0.0
* Baseline commit: 7cee958
* Android package: com.kscanai.app
* versionName: 1.0.0
* versionCode: 5
* AAB filename: app-production-beta1.aab
* AAB path: qa/aab-final/app-production-beta1.aab
* Play status: Internal Testing uploaded; waiting for tester feedback
* Freshness rule: If the branch receives new commits, tags, tester feedback, Play rejection, or a new AAB, this document must be updated or marked STALE — REVIEW REQUIRED.

---

## 1. Purpose

This document establishes a formal quarantine boundary around the Android 1.0.0 release branch. Its sole purpose is to prevent accidental modification, pollution, or destabilization of the Android release candidate that has been uploaded to Google Play Internal Testing, while iOS planning work proceeds independently.

This document does not authorize iOS work. iOS implementation must wait until Android tester feedback is reviewed or the owner explicitly authorizes iOS work.

---

## 2. Frozen Android Release Branch

`release/android-1.0.0` is the Android release quarantine branch.

**Treat `release/android-1.0.0` as read-only** except for the following explicitly authorized exceptions:

| Exception | Allowed? |
|---|---|
| Google Play rejection fix | YES, owner-authorized only |
| Critical Android crash or data-loss hotfix | YES, owner-authorized only |
| versionCode bump and AAB resubmission | YES, owner-authorized only |
| Emergency legal/privacy correction | YES, owner-authorized only |
| iOS work of any kind | NO |
| Feature additions | NO |
| Refactors | NO |
| Dependency upgrades | NO |
| Shared runtime configuration changes | NO |

---

## 3. Current Android Release State

| Field | Value |
|---|---|
| Branch | release/android-1.0.0 |
| HEAD commit | 7cee958 |
| Android package | com.kscanai.app |
| versionName | 1.0.0 |
| versionCode | 5 |
| Min SDK | per android/app/build.gradle |
| Target SDK | per android/app/build.gradle |
| Build type uploaded | Production/beta (signed release AAB) |

---

## 4. Internal Testing Artifact

| Field | Value |
|---|---|
| Play track | Internal Testing |
| Upload status | Uploaded and active |
| Tester feedback | Pending — not yet received |
| Production submission | NOT submitted |
| Go/no-go decision | NOT made |

**The Android Internal Testing track is the current release artifact.** No changes to the Android release package, versionCode, signing config, or Play console Data Safety responses are permitted until a go/no-go decision is made and documented.

---

## 5. AAB Artifact Policy

* `qa/aab-final/app-production-beta1.aab` is the uploaded Internal Testing artifact.
* The AAB is ignored by `.gitignore` via `qa/**/*.aab`.
* The AAB must never be committed to the repository.
* The AAB must not be moved, renamed, or deleted from the local working directory until a replacement signed AAB has been produced and confirmed.
* Do not overwrite the AAB file with a new build unless a new versionCode has been assigned by the owner.

---

## 6. Tagging Policy

| Tag | Status | Rule |
|---|---|---|
| `v1.0.0-android-internal` | Created at 7cee958 | Marks the Internal Testing build. Do not delete. Do not move. |
| `v1.0.0-android-final` | NOT created | Must NOT be created until production submission is approved. |
| `v1.0.0` | NOT created | Must NOT be created until production submission is approved. |

**Final Android production tag procedure is documented in Section 13.**

---

## 7. Remote Branch Protection Note

RISK: `release/android-1.0.0` remote branch protection was not verified or enabled. The GitHub CLI (`gh`) was not available in the local environment to query branch protection status.

**Owner action required:** Enable branch protection on `release/android-1.0.0` in the GitHub repository settings before iOS work begins. At minimum, restrict direct pushes and require pull request review for any change to this branch.

---

## 8. Release/Feature Divergence Note

Divergence was checked between `release/android-1.0.0` and `feature/purple-gold-electric-theme` as of 2026-06-14.

**Release-only commits (present on release but not on feature branch):**

These commits must be included in any future iOS branch if branching from `feature/purple-gold-electric-theme`:

```
7cee958 docs(play): add internal testing readiness audit
264bd69 docs(release): add final release smoke audit
b652f00 merge: purple-gold StyleChat fixes and V6.4 readability polish into release
e9243e5 docs(release): add functional release audit
18e34d4 chore(repo): ignore local QA and Supabase artifacts after fresh submission audit
866f93d docs(play): add fresh submission audit
b54f0f7 merge(release): integrate purple gold electric theme
```

**Feature-only commits (present on feature but not on release):** None detected as of 2026-06-14.

Recommendation: Create the iOS branch from `release/android-1.0.0` to avoid missing any release-only commits.

---

## 9. What Is Allowed on release/android-1.0.0

* Owner-authorized Android hotfixes (documented above in Section 2)
* versionCode bump commits with explicit owner approval
* Emergency legal/privacy corrections with explicit owner approval
* Documentation updates describing the release state (e.g., this document)
* QA artifacts in `qa/` that document the release (read-only; not modifying app behavior)

---

## 10. What Is Forbidden on release/android-1.0.0

* iOS work of any kind
* Feature additions
* Refactors or cleanups
* Dependency additions, removals, or version changes
* Shared runtime configuration changes (app.json, package.json, babel.config.js, metro.config.js, tsconfig.json, eas.json)
* expo prebuild
* pod install
* eas build
* eas submit
* Supabase function deployments
* Database migrations
* Committing AAB or APK artifacts
* Removing or moving QA artifacts
* Deleting or moving existing tags
* Committing with `git add .` or `git add -A`

---

## 11. Shared-File Risk Rules

Any future edit to a shared file during iOS work (on a separate iOS branch) must be classified:

| Classification | Meaning |
|---|---|
| iOS-only | Change only affects iOS runtime or build; Android is unaffected |
| Android-impacting | Change may alter Android runtime, build, or Play submission state |
| Shared runtime | Change affects both platforms equally |
| Unknown / needs review | Impact not yet determined — must be reviewed before merge |

Shared files requiring special review before any iOS-branch edit:

* `app.json`
* `package.json`
* `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` / `bun.lockb`
* `eas.json`
* `babel.config.js`
* `metro.config.js`
* `tsconfig.json`
* `index.js`
* `app.json` plugins/config arrays
* `constants/`
* `assets/`
* `app/_layout.tsx`
* Shared auth files
* Shared navigation files
* Shared theme files
* Shared Supabase client/config files

---

## 12. Emergency Android Hotfix Procedure

If a critical Android defect is discovered after Internal Testing upload:

1. Owner explicitly authorizes the hotfix in writing.
2. Create a hotfix branch from `release/android-1.0.0`: `git checkout -b hotfix/android-1.0.1`.
3. Apply only the minimal fix required. Do not add features or clean up unrelated code.
4. Bump `versionCode` in `android/app/build.gradle` (e.g., 5 → 6).
5. Bump `versionName` if warranted (e.g., 1.0.0 → 1.0.1).
6. Build a new signed release AAB via EAS or local Gradle.
7. Update `qa/aab-final/` with the new AAB filename.
8. Merge hotfix branch back to `release/android-1.0.0` with owner approval.
9. Update this document to reflect the new commit and versionCode.
10. Upload new AAB to Google Play.
11. Tag only after production submission (see Section 13).

---

## 13. Final Android Production Tag Procedure

Do not create `v1.0.0-android-final` until all of the following are true:

- [ ] Android tester feedback reviewed and approved by owner
- [ ] Production submission decision (go/no-go) made by owner
- [ ] Production AAB submitted to Google Play Production track
- [ ] No open Play policy or Data Safety rejections
- [ ] No critical bugs found in Internal Testing

When all conditions are met:

```bash
git checkout release/android-1.0.0
git tag -a v1.0.0-android-final -m "Android v1.0.0 (versionCode 5) production release"
git push origin v1.0.0-android-final
```

---

## 14. Owner Checklist Before iOS Work Begins

- [ ] Android Internal Testing tester feedback received and reviewed
- [ ] Go/no-go decision documented for Android production submission
- [ ] Remote branch protection enabled on `release/android-1.0.0` in GitHub
- [ ] No open Android hotfixes or Play rejection notices
- [ ] Owner explicitly authorizes iOS work (verbal or written)
- [ ] iOS branch creation approved (recommend: `git checkout -b feature/ios-port` from `release/android-1.0.0`)
- [ ] Apple privacy policy claims reviewed against current Android 18+ posture (see `docs/ios-port-isolation-plan.md`)
- [ ] `docs/ios-port-isolation-plan.md` reviewed and freshness confirmed
