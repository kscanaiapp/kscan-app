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

Populate after `eas build` / push completes:

| Field | Value |
|---|---|
| Local SHA | _(filled at commit)_ |
| Remote SHA | _(filled after push)_ |
| EAS Build ID | _(pending)_ |
| Artifact URL | _(pending)_ |
| Logs URL | _(pending)_ |

## Notes

- Worktree was created cleanly from the exact v15 EAS commit to avoid mixing unrelated dirty changes from other local branches.
- No backend deploy is required for this client-only repair.
