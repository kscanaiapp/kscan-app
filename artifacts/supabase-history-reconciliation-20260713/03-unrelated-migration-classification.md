# Unrelated local migration classification

All eight files originated in this repository's K Scan feature/audit history and
target the same application schema. No wrong-project provenance was found.

| Timestamp | Migration | Classification | Remote equivalence evidence |
|---|---|---|---|
| `20260711000001` | AI stylist Looks extension | `REQUIRED_BUT_NOT_DEPLOYED` | Required Looks/look-items columns and three RPCs are absent; current UI/services and StyleChat code reference the contract. |
| `20260711000002` | Outfit decision rooms | `REQUIRED_BUT_NOT_DEPLOYED` | All four decision tables and all decision RPCs are absent; current service/UI code references them. |
| `20260711000003` | Style-outfit usage | `REQUIRED_BUT_NOT_DEPLOYED` | Both quota tables and both quota RPCs are absent; `style-outfit-generate` references them. |
| `20260711195508` | Restore service-role app-table grants | `REQUIRED_BUT_NOT_DEPLOYED` | Only partial overlap exists. Service-role CRUD is present, but authenticated Looks grants and the decision RPC are absent. `room_shares.max_redemptions` is nullable with no default and lacks the migration's constraint. |
| `20260712000001` | Saved-scan media backing | `REQUIRED_BUT_NOT_DEPLOYED` | Saved-scan media columns and companion inspiration metadata are absent; current media and styling services reference them. |
| `20260712010000` | AI stylist/StyleChat audit hardening | `REQUIRED_BUT_NOT_DEPLOYED` | Media ownership constraints, rewrite trigger/function, and dependent decision hardening are absent. |
| `20260712020000` | Harden app-role privileges | `REQUIRED_BUT_NOT_DEPLOYED` | Remote service-role tables still expose TRUNCATE, REFERENCES, and TRIGGER; dependent RPC corrections are not present. |
| `20260714000002` | App-config read grants | `ALREADY_PRESENT_EQUIVALENT` | Its sole SELECT grant is already present exactly through statement 1 of remote migration `20260709130346`. |

The first three migration headers explicitly describe the files as migration
source not applied to a remote environment in that build. This is deployment
state evidence, not wrong-project evidence. Their effects are used by the
current same-project application source.

Because at least one earlier migration is `REQUIRED_BUT_NOT_DEPLOYED`, migration
history must not be marked applied and these files must not be moved out of the
active chain without separate deployment authorization.
