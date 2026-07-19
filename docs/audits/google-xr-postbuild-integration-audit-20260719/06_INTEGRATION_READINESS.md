# 06 — Integration Readiness

## Branches

| Role | Branch | HEAD |
|------|--------|------|
| Audit/repair (do not merge yet) | `audit/google-xr-postbuild-integration-repair-20260719` | `505084d` + `9ab27a2` + docs commit |
| Builder candidate | `build/google-xr-native-safety-emulator-candidate` | `d636ad8503d98f06f5bab4b4268cb1528bc232e8` |
| Target | `feature/glasses-xr-native-standalone` | `497c583f9ca68ede1703c1199c16470a758afa74` |
| Merge base | — | `497c583f9ca68ede1703c1199c16470a758afa74` |

`git merge-tree` forecast vs target: **no conflicts detected** for builder commits through `d636ad8`. Re-run after committing audit repairs.

## Builder commit list (already on candidate)

```
09787e8 fix(glasses): enforce release mock safety
d210105 fix(glasses): make sanitizer selection explicit and fail closed
234d5d3 refactor(glasses): remove legacy analyze bypass
8c0cf67 fix(glasses): add bounded JPEG re-encode boundary
6a3faaa fix(glasses): repair debug analyze JSON contract
2ee98c9 fix(glasses): harden logging and error safety
7426ccc fix(glasses): true-black HUD and honest XR controls
848f3d6 fix(glasses): minimize manifest permission surface
715b5d7 test(glasses): expand safety privacy and contract coverage
c1ba315 docs(glasses): record native safety emulator candidate
488b91b fix(glasses): keep results actions inside 600dp HUD viewport
d636ad8 fix(glasses): let Back leave the error screen
```

## Integration order (recommended)

1. Commit audit repairs on audit branch (logical commits).
2. Optionally rebase/cherry onto `build/google-xr-native-safety-emulator-candidate` or PR audit→builder→target.
3. Merge/cherry into `feature/glasses-xr-native-standalone` (integration manager).
4. Deploy local-debug backend changes only to controlled environments — **not** production without auth review.
5. Main mobile repo phone-bridge / Closet sync remains separate.

## Backend readiness

| Item | Status |
|------|--------|
| Local debug backend code | Ready to merge (fail-closed + bare-base64 strip) |
| Production backend deploy | **Not** authorized / not done |
| Env vars | `KSCAN_GLASSES_*` for Node; Android URL/flags in `local.properties`; token via runtime file |
| DB migrations | None |
| Controlled live smoke | Blocked on upstream auth decision |

## Rollback

- Revert audit commits or reset audit branch to `d636ad8`.
- Target branch untouched (no merge performed).
- APK is debug-signed only; uninstall `com.kscan.glasses` from emulators.

## Cross-repo dependencies

- Main K Scan mobile Closet / session handoff: still external.
- Upstream `/api/analyze` auth (KC-01 class work): still external if required for production.
