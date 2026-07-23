# 11 — Build Report

## Intended QA candidate

| Field | Value |
|---|---|
| Branch | `fix/ios-v15-image-upload-regression` |
| Base SHA (v15) | `32addd55187e4742c197e46e36d9d1cb0e0bf63c` |
| Version | `1.0.1` |
| Build Number | `16` |
| Profile | `production` (store / TestFlight) |

## Status

| Field | Value |
|---|---|
| Repair commit SHA | `79f1106addb14537daa8db6119d726997e77085d` |
| Merged remote SHA | `cc09b609bf41af45fba1fca452eabee8572406f6` (`integration/ios-v15-second-pass-test-ready`) |
| PR | https://github.com/kscanaiapp/kscan-app/pull/37 |
| EAS Build ID | `94685c6e-2341-4356-89c4-01976c99cbb9` |
| Logs URL | https://expo.dev/accounts/ams2dad/projects/kscan/builds/94685c6e-2341-4356-89c4-01976c99cbb9 |
| Artifact URL | pending (build in progress / finishing) |
| Version / Build Number | 1.0.1 / **16** |

## Notes

- Worktree was created cleanly from the exact v15 EAS commit to avoid mixing unrelated dirty changes from other local branches.
- No backend deploy is required for this client-only repair.
