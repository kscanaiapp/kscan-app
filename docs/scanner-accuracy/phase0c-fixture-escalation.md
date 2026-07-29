# Phase 0C Lane D — Production fixture provenance escalation

**Classification: P1 production-asset provenance escalation (INV-2).**

This report contains observations and unknowns. It deliberately does **not**
assert the subject's age, legal status, or absence of consent — none of those has
been independently verified, and asserting them would be a conclusion rather
than a finding.

No production asset was modified, moved or deleted. No production branch was
touched.

---

## 1. Subject

| Field | Value |
|---|---|
| Repository path | `assets/qa_fixtures/bottom_skirt.jpg` |
| sha256 | `3488934132872918e05c6663c87322c994b84ecf989dbad865d32501b2d58ae7` |
| md5 (Expo asset name) | `012ccca938317e66982d0065eaea86c3` |
| Dimensions / size | 960×1280, 206,614 bytes |
| Added in | `bc8f818` (2026-05-08), "Android Beta v1.4 QA harness and Style-Parse validation" |

## 2. Observable facts

- The image shows one identifiable person, face unobscured and in focus.
- The setting is an interior residential stairwell with identifiable features,
  including a wall marking that reads as a unit number.
- The framing, lighting and composition are those of a casual personal
  photograph rather than a studio, catalogue or stock product shoot. The other
  apparel fixtures in the same directory are visibly commercial product imagery.
- The file carries a Photoshop APP13 metadata block. It carries no EXIF GPS and
  no camera Make/Model.

## 3. Unknowns

None of the following exists anywhere in the repository, for this file or any
other fixture:

- the source or copyright holder;
- a licence or terms of use;
- a model release or any record of the subject's consent;
- the capture date, photographer, or how the file was obtained;
- the subject's age or any basis on which to estimate it.

The commit that introduced it (`bc8f818`) records no provenance.

## 4. Privacy concerns visible on the face of the material

1. An identifiable individual is the subject, not the garment.
2. The location is a private dwelling with identifying detail.
3. Provenance and permission are entirely undocumented.
4. Evaluation use would transmit the image to a third-party model provider.

Masking would address (1) and (2). It does not address (3), which is why the
image was excluded from the Build 4 dataset rather than remediated.

## 5. Current use references

| Reference | Detail |
|---|---|
| `constants/qaFixtures.js` | registered as fixture id `bottom_skirt`, `require`d from `assets/qa_fixtures/bottom_skirt.jpg` |
| `app.js:48` | imports `QA_FIXTURES`; the QA panel is additionally gated behind `QA_TOOLS_ENABLED` |
| `constants/build.js` | ties `QA_TOOLS_ENABLED` to `__DEV__ === true` |
| `__tests__/qaFixturesProductionGate.test.js` | asserts that with `__DEV__ = false`, `QA_FIXTURES` is empty and **no `require` executes** |
| `scripts/qa-fixtures.js` | tooling over the fixture directory |
| Build 4 | excluded — `privacyDisposition: blocked_private`, not in any manifest or derived dataset |

## 6. Did it ship? — empirical finding

**Yes, in at least one production Expo export, before 2026-07-28.**

Expo names exported assets by content md5, so presence is directly testable.

| Export artifact | Date | Assets | All 8 fixture md5s present? | Bundle references `qa_fixtures`? |
|---|---|---|---|---|
| `C:\Users\jsmit\KScan\dist` | 2026-07-13 | 34 | **YES — all 8, including this file** | yes |
| `C:\Users\jsmit\KScan-android-release\dist` | 2026-07-09 | 26 | no | no |

The 34 − 26 = 8 difference is exactly the eight fixtures.

### The gate is recent and incompletely propagated

The `__DEV__` gate in `constants/qaFixtures.js` was added on **2026-07-28** by
`918d2a3` — *"fix(ios): exclude QA fixtures from production export"*. Both export
artifacts above predate it.

Branch status **today**:

| Branch | Gate |
|---|---|
| `origin/master` | **UNGATED** |
| `release/ios-v18-build-prep` | **UNGATED** |
| `cert/ios-phase-2b4-cross-path-v2` | **UNGATED** |
| `release/android-v27-build-prep` | GATED |
| `feature/ios-dressing-rooms-v1` | GATED |
| `feature/android-dressing-rooms-v1` | GATED |
| `research/scanner-accuracy-v2-evals` | GATED |

So the fix exists but has **not reached `origin/master` or the iOS release-prep
branch**. A build cut from either today would bundle all eight fixtures.

### The gate's effectiveness is unverified at the asset level

`__tests__/qaFixturesProductionGate.test.js` evaluates the module with
`__DEV__ = false` and asserts no `require` executes. That proves the **runtime**
path is dead. It does **not** prove Metro omits the **asset** from the app
package.

Those are different mechanisms. Metro collects asset dependencies from the AST
during transformation; whether a `require` inside a `false ? … : []` ternary is
folded away *before* dependency collection depends on the transform pipeline and
its ordering. It is plausible the fix works, and it is not proven.

**No post-fix production export exists to test.** This is settled empirically,
not by reasoning, with:

```bash
npx expo export --platform ios --output-dir /tmp/qa-gate-check
```

then checking whether md5 `012ccca938317e66982d0065eaea86c3` appears in
`/tmp/qa-gate-check/assets`. Note the recorded hazard that a junctioned
`node_modules` silently truncates an export — the check is only valid in a
worktree with real installed dependencies.

## 7. Required owner decision

1. **Establish provenance** for this file — source, licence, and permission — or
   conclude that it cannot be established.
2. **Decide on continued use.** If provenance cannot be established, the options
   are replacement with an owned or licensed fixture, or removal.
3. **Propagate or reject the gate** on `origin/master` and
   `release/ios-v18-build-prep`. This is independent of (1) and (2): even with
   perfect provenance, shipping eight QA-only images in a release bundle is
   avoidable payload.
4. **Verify the gate empirically** with a post-fix production export before
   relying on it.
5. **Decide the scope** — findings 1 and 2 apply to all eight fixtures, not only
   this one. None has a licence or use record (INV-1).

## 8. Recommendation

Handle in a **separate production-safe task**, on a branch permitted to touch
`assets/` and `constants/`. Build 4 must not perform the remediation: its
boundary forbids production paths, and doing it here would mix a research branch
into a release-line change.

Suggested order: propagate the gate to master and the iOS release branch first —
it is low-risk, independently justified, and shrinks exposure while the slower
provenance question (1) is worked. Removal should follow the provenance
conclusion, not precede it, since deleting the asset before establishing the
facts destroys the evidence needed to reach them.
