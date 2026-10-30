# Build35 owner status report — October30

**The full hostile audit is not complete.** Substantial source repair work is complete, but coverage reconciliation, additional high-risk probes, privacy determinations and runtime/device certification remain. This report supersedes older status snapshots in the retained campaign documents.

**Current release verdict: FAIL — a confirmed P3 remains unmerged in the authorities.** The broader audit is also INCOMPLETE; external privacy/runtime evidence remains unavailable. This is not final platform or store certification.

## Source of truth

| Authority | Current SHA | Evidence |
|---|---|---|
| Build35 integration | `d342087cef908e806c891d5f19264d4eeeb8d665` | #657/#658/#660 merged; exact tested-tree equivalence; branch CI9/9successful |
| Canonical backend | `531f288fe52ab7ff8ef733408779d19ba4d93c6b` | #656/#659 merged; exact reviewed-tree equivalence; branch CI7/7successful |
| Build34 pre-freeze | `840ba88ee41e97de8d9d63ad5f3d3dd03fd457a2` | Isolated/unchanged; no Build35 promotion into it |
| Open DNS repair | #661, `8384e8b0ec32312f2da978448d645fac44d7d5a5` | Source-prepared, pushed, draft/unmerged; current-head CI pending |
| Audit evidence | Existing draft #646 | Previous pushed cbaf93b4 head fully green; current status/evidence batch includes merged d342source and awaits its consolidated push/checks |

The immutable nine-repair convergence milestone remains preserved in [the original convergence report](build35-final-source-convergence.md).

## Repairs completed and open

Thirteen P0–P3 findings are confirmed: **P0=0, P1=4, P2=3, P3=6**. Twelve have merged source repairs; one has a tested, unmerged source repair. These are source dispositions, not deployment/customer-live certifications.

The nine historical repairs remain intact: Gemini disclosure/re-consent, outfit account authorization, server Gemini receipt enforcement, durable withdrawal, malformed secondary-commerce isolation, conservative VTO dispatch accounting, URI-decoder denial of service, ownership badge expiry, and missing speech timing.

Three further repairs are merged:

| Finding | Result | PRs / merge source |
|---|---|---|
| F007/P3 restricted-account discovery | Shared account restriction runs before quota/catalog | #656 backend `98c88ff1`; #658 mobile `8bdcaaba` |
| G008/P3 failed analytics identity transition | Events are fenced until SDK identity is verified; failed transition cache invalidated | #657 mobile `9c66fe50` |
| C010/P3 invalid remote VTO garment bytes | Known empty, MIME-lying and structurally truncated inputs rejected before provider submission; attempt released | #659 backend `531f288f`; #660 mobile `d342087c` |

**Open C011/P3:** the URL guard accepted a hostname resolving to loopback. A controlled local listener received one TCP/TLS connection and64TLS bytes through the actual adapter and authenticated-handler path. There was **no successful TLS/HTTP response, private data, real provider submission, customer exposure or Production exploit demonstrated**.

Repair #661 validates DNS answers at the actual socket lookup, avoiding a preflight/re-resolution race. It preserves hostname/SNI/certificate verification, checks garment and result downloads, and prevents an environment-proxy bypass. Local after-tests record zero private connections and zero provider submissions. Actual Supabase Edge runtime compatibility remains unverified; local Docker daemon is unavailable. Source merge, exact mobile promotion and protected runtime verification remain.

The first #661 CI correctly rejected new Node built-ins under an older remote-only dependency guard. The correction permits only four exact built-ins in the VTO closure and still rejects unrelated functions/capabilities;24focused guard tests pass. No test or promotion gate was disabled. Current8384head CI must complete successfully before merge.

Lower-priority confirmed items: B35-B-004/P4 Scanner JSONnull TypeError, and D009/P5 optional K+ expired-period test fixtures. Both remain documented under their protected-subsystem scope restrictions. Neither is inflated in severity to obtain repair authorization. See [repair ledger](build35-p0-p3-repair-ledger.md) and [backlog](build35-hostile-audit-p4-p10-backlog.md).

## Tests and hostile coverage

| Tested source | Actual result | Limit |
|---|---|---|
| Mobile d342087c, exact c437e04b tree | **11,348 Node PASS /0FAIL /98SKIP**,642files; **1,547 backend PASS /0FAIL** | Offline/source contracts; not device or live-provider certification |
| Mobile source validation | TypeScript exit0; six source gates exit0; actual-diff scope/meta56PASS/0SKIP | TypeScript ran at runtime-identical b95 before final JS/JSON governance-only correction |
| Canonical backend531f288f | **1,531 backend PASS /0FAIL** | Different source/test population from mobile |
| C011 repair runtime a4a5fa1a, unchanged through8384 | **73focused PASS;1,553backend PASS;2actual network QA PASS;1actual-handler DNS regression PASS** | Focused tests overlap the full backend suite; do not add them as independent coverage |
| C011 guard correction8384 | **24source-parity tests PASS**; earlier enforced scope52PASS | CI still pending; no authoritative merge claim |
| C011 public transport check | W3C static image301→200, PNG1,848bytes, ordinary TLS | Public/nonpersonal asset only; no paid provider/Supabase runtime claim |

All68previous pre-freeze failures retain their individual dispositions and336passing integration counterparts. Those are historical evidence, not newly rerun tests on every later SHA. The original110lossless archives remain preserved; **171archives are currently integrity-verified**.

The original mandatory matrix now contains:

- **3,096total:72PASS,3FAIL,3,021NOT TESTED.**
- Of the untested cells,300are explicitly non-applicable; **2,721applicable cells need execution or exact evidence reconciliation**:2,424local,284synthetic Staging,8store sandbox,4native hardware,1signed artifact.
- The3FAILcells are one known P4 Scanner null-body case plus two C011DNS-boundary cases. C010's five formerly failing cells now have source reverification. Probe cells are not independent defects.
- The retained886execution records (873PASS/1FAIL/12skips), newer46Staging K+ records, and other focused tests are separate populations. No aggregate completion percentage is justified by adding these together.

This does **not** mean2,721known bugs or2,721entirely new tests. Some existing evidence can close cells after matching endpoint, actor, expected outcome and source equivalence. However, substantial safely executable work remains; it cannot all be described as hardware or legal blockers.

## What still needs to be completed

1. **Immediate repair integration:** finish #661 CI/review, canonical merge where allowed, exact mobile promotion, final-source tests and branch CI. Verify the new transport in an actual supported Supabase Edge environment before rollout.
2. **Audit coverage:** reconcile retained evidence and execute the remaining high-risk authorization/IDOR, storage/membership revocation, provider failures, malformed inputs, replay/concurrency, cancellation/supersession, offline recovery and account-switch probes across the application. Additional confirmed P0–P3 defects must be repaired if found.
3. **Privacy investigations:** H001 analytics still needs approved processing/disclosure basis, retention/deletion and current-binary/ingestion evidence. H003 still needs actual native detector/pixel/network proof. Neither is automatically a P0 or resolved by green tests. Owner updates legal language/website; [factual metadata handoff](evidence/build35-legal-metadata-handoff.json) is prepared.
4. **Runtime and platform gates:** protected Gemini migration/client/backend compatibility rollout; discovery deployment/activation approval; native store sandboxes; actual iOS/Android camera, masking, speech/VTO, notification, permission, accessibility and lifecycle tests; signed-artifact configuration/store declarations.
5. **Final evidence closure:** complete the feature/probe matrices, final source/test/CI reconciliation, runtime readback and platform handoff. Final readiness cannot be certified while the above remains.

The [26-feature matrix](build35-integration-activation-matrix.md) retains source/harness, deployed, enabled, device and customer-live states separately. Additional untraced routes remain NOT AUDITED. [Platform handoff](build35-ios-android-candidate-audit-handoff.md) lists required device/artifact checks.

## Runtime and safety boundary

Last verified readback: Production discovery absent, organic/badge flagsfalse, sponsorship flagsfalse; Staging discoveryv5/JWTtrue with organic/badgetrue. Gemini permission migration20261029184000absent both projects; strict consent source is merged but has not been rolled out. These are dated runtime facts, not a new rollout certification.

No Production deployment, migration, flag/pricing change, real purchase/refund, paid generation, EAS build, IPA/AAB/APK, version increment or store submission occurred. New network probes contacted only controlled loopback listeners and public nonpersonal diagnostic/static assets; no customer records or private service was targeted. Synthetic Staging fixtures from the earlier continuation were cleaned up.

## Resume point

Open #661 at8384; retain source/runtime tests and inspect current CI. Dedicated repair worktree C:/b35dns1030 is committed/pushed and clean. C:/b35evidence1029 is the existing #646documentation lane; current report/checkpoint/raw archives must be committed/pushed as one batch after shared staging checks clear. Do not reset older worktrees or stage the retained untracked draft/invalid files.

The work remaining is **both tests/verification and audit reconciliation, with one current repair integration**. It is not merely final paperwork, and no reliable small-hours estimate is supported by the remaining scope.
