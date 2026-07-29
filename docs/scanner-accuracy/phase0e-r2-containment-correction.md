# Phase 0E-R2 — Correction: the `__DEV__` ternary DOES contain the fixtures

**My Phase 0D claim was wrong.** This document records the correction, the
evidence that settles it, and what it means for the repair.

---

## 1. What I claimed, and why it was wrong

Phase 0D asserted, in the report, in `phase0c-fixture-escalation.md`, in commit
messages and in a memory note:

> A `__DEV__ ? [require(...)] : []` guard leaves the runtime path dead but the
> images still ship, because Metro collects asset dependencies while building the
> module graph and only eliminates the dead branch at minification.

**The evidence I cited did not support that conclusion.** It was a production
export dated **2026-07-13**. The gate commit `918d2a3` landed **2026-07-28**. So
the export I measured was an export of **ungated** source. It proved the ungated
form ships the images — which is true — and said nothing about the gated form.

I generalised from it to a claim about the gated form without ever exporting the
gated form, and stated a mechanism (dependency collection before dead-code
elimination) as established fact.

## 2. The evidence that settles it

Two independent production exports, both run in Phase 0E-R2:

| Target | Source form | Metro config | Assets | `fixtureAssetsPresent` |
|---|---|---|---|---|
| `release/android-v27-build-prep` (`37b7141`) | plain `__DEV__` ternary | **default** | 45 | **0** |
| `origin/master` (`9bb0b57`) pre-repair | unconditional requires | default | 31 | **8** |
| `origin/master` + **ternary only** | plain `__DEV__` ternary | **default** | 23 | **0** |

The third row is decisive: applying **only** the ternary to master, changing
nothing else and leaving `metro.config.js` at the Expo default, takes it from 8
to 0.

Metro's production transform folds `__DEV__` and drops the requires **before**
dependency collection. My stated mechanism was backwards.

## 3. What this means for the repair

| Branch | Repair | Status |
|---|---|---|
| `integration/master-qa-fixture-containment` | `__DEV__` ternary, taken verbatim from the Android line. `metro.config.js` untouched | **MERGE-READY**, export-proven 8 → 0 |
| `release/android-v27-build-prep` | none needed | **VERIFIED CLEAN**, export-proven 0 |
| `fix/qa-fixture-production-containment` (iOS) | `sourceExts` module split | Works — export-proven 8 → 0 — but **more complex than necessary** |

**The minimal correct repair is the ternary.** It is one file, it matches code
already running on the Android release line, and it needs no Metro configuration
change.

### Recommendation on the iOS branch

The existing iOS branch is not wrong and its export proof stands. But it carries
a `metro.config.js` `sourceExts` change and a second module
(`constants/qaFixtures.dev.js`) that the evidence now shows are unnecessary.

Two options for the owner:

1. **Preferred — replace it** with a ternary-only branch cut from the current iOS
   target, so all three lines share one mechanism. Divergent containment
   mechanisms across platforms are exactly the kind of drift that produced the
   "gated but not via `918d2a3`" confusion in the first place.
2. Merge it as-is and accept two mechanisms in the codebase.

## 4. What I should have done

Exported the gated form before asserting anything about it. The whole point of
the export-level detector was that source-level reasoning about Metro is
unreliable — and I then reasoned about Metro at the source level and published
the result as a finding.

The detector was right. I did not run it on the case I was making a claim about.

## 5. Corrected statements

Superseded, in this repository:

- `phase0c-fixture-escalation.md` §6 — "the gate's effectiveness is unverified at
  the asset level" was accurate at the time; the stronger claim that the ternary
  does not work is withdrawn.
- The Phase 0D commit message on `fix/qa-fixture-production-containment` and the
  `qaFixtureProductionContainment.test.js` header comment both assert the ternary
  ships the images. **Both are wrong** and are superseded by this document.
- The memory note asserting the same is corrected.

What remains true and unchanged:

- All eight fixtures **did** ship — proven on `origin/master` today, 8 present.
- A runtime test asserting `__DEV__ = false` produces no `require` is **not**
  containment proof; only an export is. That reasoning was always the right one.
- Commit presence is not containment evidence: the Android line is contained
  without containing `918d2a3`.
