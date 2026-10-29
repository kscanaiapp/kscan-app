# Deferred findings and unconfirmed investigations — PARTIAL

No confirmed P4–P10 product defect is asserted yet. Do not interpret this as zero remaining defects. No deferred implementation performed.

| ID / status | Surface / scope / source | Attempt and missing evidence | Impact / proposed next work / complexity | Why outside repair queue |
|---|---|---|---|---|
| H-001 UNCONFIRMED, priority unassigned | PostHog consent / shared; services/analytics/posthogClient.core.ts:createClient | Reviewed unconditional defaultOptIn, no dedicated analytics-consent authority, explicit replay/autocapture off. No production ingestion/config/legal-jurisdiction evidence collected. | Potential privacy concern; confirm configuration, event allowlists and legal authority before classification. Medium. | No demonstrated applicable consent violation; not labeled low risk. |
| H-002 UNCONFIRMED, priority unassigned | Gemini transfer coverage / shared+backend; services/style-chat/providers/edgeStyleChatProvider.ts:generateReply, Scanner/Closet paths | Traced onboarding and text invocation; repaired proven disclosure/version defect. No synthetic network capture across all paths or server ledger enforcement test. | Potential consent bypass beyond UI; next inject revoked/missing acceptance at each boundary. High. | Must not infer universal resolution from #645. |
| H-003 UNCONFIRMED, priority unassigned | Image masking / native+shared; acquisition/sanitization paths not fully traced | Located source inventories; no synthetic face/plate network-boundary test yet. | Potential material privacy exposure; prioritize Lane B payload capture and native-unavailable failure paths. High. | NOT AUDITED, no fabricated privacy finding. |

All three require prompt investigation in this campaign's continuation, not deferral merely because reproduction is difficult. No invented line locations, provider terms, release dates or cosmetic backlog.

Untriaged pre-freeze test failures are separately recorded in evidence/prefreeze-failures.txt. They are failures, not automatically application defects. At least one is a Windows path-separator assertion. Root cause and classification of all 68 failures remain required before release approval.
