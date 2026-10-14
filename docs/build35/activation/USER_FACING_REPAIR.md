# Closet utility activation repair

With Closet separation enabled, the Library mounted `FreeTierUtilitySection` only inside Recent Scans and supplied scan history to it. The default My Closet view therefore hid the existing Outfit Generator, while Recent Scans could supply items the user had not confirmed owning.

The section now mounts in My Closet with `useCloset().items`. Recent Scans retains its discovery behavior without owned-wardrobe utilities. The unsplit legacy Library retains its existing utility mount. The utility master/subfeature rollout gates are preserved, and the owned utility subtree is keyed by authenticated actor so switching accounts remounts its local hook state. The empty state asks users to add an item rather than save a discovery scan, which alone does not establish Closet ownership.

Regression coverage renders the real Library screen with distinct owned and discovery fixtures for Android and iOS. It checks owned inputs, discoverability, absence from Recent Scans, master OFF, and the legacy unsplit view. These are source-render tests; they do not certify a native artifact.

Before the repair, the new owned-input and discovery-exclusion assertions failed. After the repair they pass alongside storage actor-isolation and scan-funnel policy tests. K+ availability, paid acquisition and proof/fingerprint regressions remain in the focused validation set. Backend and native configuration are unchanged.

Manual verification after an authorized current-source build: open My Closet with owned items and distinct Recent Scans, use Outfit Generator, save/reload a look, switch accounts, check empty/loading states, and confirm Recent Scans never supplies unowned items to wardrobe tools. The older emulator APK is excluded from this verification. No EAS build or Production provider call was performed.
