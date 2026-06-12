# Legal Fallback Docs Alignment - 2026-06-12

Status: PASS WITH NOTES

## 1. Baseline Verification

- Repo: `C:\Users\jsmit\KScan`
- Branch: `release/android-1.0.0`
- HEAD at start of this pass: `e743d3b7080c0db42badec0761bba6a05c295019`
- VersionCode verified in `app.json` and `android/app/build.gradle`: `5`
- Required QA inputs present:
  - `qa/google-play-ai-provider-decision-brief-2026-06-12.md`
  - `qa/google-play-provider-data-safety-audit-2026-06-12.md`
  - `qa/google-play-data-safety-mapping-draft-2026-06-12.md`
- Tracked files were clean before edits.
- Untracked QA and local artifacts were present and left untouched.

## 2. Why Website Repo Was Not Edited

The website repo at `C:\Users\jsmit\kscan-website` was previously triaged as not safe to continue because legal/privacy edits were mixed with homepage, beta-page, generated-document, and office-temp changes. This pass creates canonical fallback legal docs in the app repo only.

## 3. Files Created/Modified

- `docs/privacy-policy.md`
- `docs/terms-and-conditions.md`
- `qa/legal-fallback-docs-alignment-2026-06-12.md`

## 4. Privacy Policy Alignment Summary

The fallback privacy policy now covers scope, contact, 18+ eligibility, account/auth data, image and scan handling, StyleChat and AI processing, Dressing Rooms, shopping/search data, diagnostics and usage data, disclosures, sale/sharing notice, retention, deletion requests, California/U.S. state rights, GDPR/UK GDPR rights, international transfers, cookies/website technologies, and contact.

The language is conservative where provider or logging posture is not fully verified. It does not claim all images stay on device, automatic face blurring, zero-knowledge architecture, no cloud processing, no training, or no retention.

## 5. Terms Alignment Summary

The fallback terms now cover acceptance, 18+ eligibility, service description, account registration, privacy-policy relationship, camera/uploads/user content, user-content license, Dressing Rooms and sharing, acceptable use, AI and StyleChat outputs, Google Play AI-generated-content reporting posture, shopping and retailer limitations, payments, affiliate relationships, IP, feedback, beta availability, moderation/suspension/termination, deletion effects, disclaimers, limitation of liability, indemnity, Apple/Google platform terms, changes, and contact.

The terms describe K Scan as a fashion-specific visual discovery and shopping-assistance service and avoid unsupported promises about retailer guarantees or deletion automation.

## 6. 18+ Target Audience Alignment

PASS

Both fallback docs now state that K Scan is intended for users 18 and older, that users under 18 should not use the Service, and that K Scan is not directed to children or minors.

## 7. Android / Google Play Alignment

PASS WITH NOTES

The docs align with the Android release posture reflected in the June 12 Google Play QA packet:

- adult-only release posture
- conservative AI/provider disclosure
- no AAID/ad-SDK claim unless later disclosed
- no unsupported data-safety claims
- no immediate or complete deletion promise

Play Console Data Safety is still not final from these docs alone.

## 8. Apple App Store / TestFlight Alignment

PASS WITH NOTES

The docs also support Apple review posture by:

- using adult-only eligibility language
- avoiding surveillance / biometric / face-recognition positioning
- using conservative cloud/AI processing language
- avoiding unsupported security or deletion guarantees

Apple-specific operational review may still require website publication and final reviewer-copy alignment.

## 9. AI / Gemini / OpenRouter / Supabase Disclosure Posture

PASS WITH NOTES

- Gemini processing is disclosed conservatively.
- OpenRouter zero-data-retention is not assumed or promised.
- Supabase logging/DPA posture is not assumed or promised.
- The docs expressly avoid no-training, no-retention, and service-provider-only claims unless separately verified.

## 10. Shopping/Search/Retailer Disclosure Posture

PASS

The docs disclose that K Scan may use shopping, search, marketplace, retailer, affiliate, attribution, analytics, and commerce providers for shopping-related features. They also state that retailer purchases occur with third parties, not K Scan, and that product matches, prices, availability, authenticity, sizing, shipping, and returns are not guaranteed.

## 11. Account Deletion Wording

PASS

The docs state that deletion requests are generally processed within 30 days and are subject to legal, security, technical, backup, audit, abuse-prevention, and operational limitations. The docs do not promise immediate, complete, or fully automated deletion.

## 12. Advertising/Tracking Wording

PASS WITH NOTES

The privacy policy states that no third-party advertising SDKs or Advertising ID usage were found in Prompt 10 repository evidence unless later evidence proves otherwise, and it avoids broader unsupported claims about tracking posture beyond what the evidence supports.

## 13. Apple Privacy Nutrition Label Support

PASS WITH NOTES

These fallback docs provide a conservative source of truth for:

- account/auth data
- user-submitted images
- StyleChat messages
- diagnostics/usage data
- deletion workflow limitations

Final Nutrition Label answers still require owner/provider confirmation for logging, retention, and third-party provider behavior.

## 14. Google Play Data Safety Support

PASS WITH NOTES

These fallback docs support the June 12 Google Play QA packet by carrying forward:

- 18+ posture
- AI provider uncertainty
- no AAID/ad-SDK assumption
- shopping/search provider disclosure
- deletion within 30 days wording

Final Play Console Data Safety submission remains blocked on owner/provider confirmations already documented in the QA packet.

## 15. Remaining Website Publication Steps

- Publish aligned legal copy in the website repo after the dirty-tree issue is resolved.
- Align `/privacy`, `/legal/privacy`, `/legal/terms`, `/legal/terms-summary`, and `/legal/delete-account` with these fallback docs.
- Preserve links to the full privacy-policy and terms assets when the website repo is resumed.

## 16. Remaining Owner/Provider/Legal Confirmations

- Confirm Gemini production tier and final provider posture.
- Confirm whether OpenRouter is active in production and whether ZDR is verified.
- Confirm Supabase logging, retention, and DPA posture.
- Confirm final shopping/search provider disclosures.
- Confirm any future in-app paid features before updating billing language.

### Forbidden-Claims Scan Classification

PASS WITH NOTES

A targeted scan was run against `docs/privacy-policy.md` and `docs/terms-and-conditions.md` for previously flagged or prohibited phrases.

- Matches for `children` and `minors` are allowed because they appear only in age-gating language that supports the 18+ release posture.
- Matches for `automatic face`, `all images stay on device`, `no cloud processing`, `no retention`, `no training`, `zero-data-retention`, and `official retailer partner` are allowed because they appear only in explicitly negated or cautionary language stating that K Scan does not make those promises unless separately verified and disclosed.
- Matches for `immediate deletion` and `complete deletion` are allowed because they appear only in a limitation statement clarifying that those outcomes are not promised.
- No prohibited phrase was found as a positive product claim.

## 17. Final Status

PASS WITH NOTES

Canonical fallback privacy and terms docs now exist in the app repo and are suitable as legal source documents for follow-on website publication work. Website publication is still pending, and provider/logging confirmations remain unresolved.
