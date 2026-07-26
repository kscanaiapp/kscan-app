# Canonical backend source manifest — `scan-identify`

**Documentation only. The function was NOT modified, redeployed, or mutated in producing this manifest.**

## Deployment identity

| Field | Value |
|---|---|
| Supabase project | `wyyuqfdxucjksghsmhry` (KScan App Production, us-east-2) |
| Function slug | `scan-identify` |
| Deployed version | **139** |
| Status | ACTIVE |
| `verify_jwt` | **false** |
| Deployment timestamp | 2026-07-25 17:25:00 UTC (epoch ms 1785000300715) |
| Function created | 2026-06-20 02:58:31 UTC |
| Governing source SHA (byte-identical) | `2c00c56a0217c5f9cd6dd45c59d37fa7ac9638bc` |
| Android RC carrying it | `integration/android-v27-closet-release-candidate` |
| iOS RC compared | `integration/ios-v18-release-candidate` @ `4c3fede` |
| Files in deployed bundle | 29 |

**Android comparison: 29/29 byte-identical.**  
**iOS comparison: 27/29 match, 1 differ, 1 absent.**

## SHA-256 manifest (all 29 deployed files)

| # | File | Bytes | SHA-256 (deployed) | Android | iOS |
|---:|---|---:|---|---|---|
| 1 | `functions/_shared/catalogRetrieval.ts` | 12,077 | `36df6c3c86cbed1d4c0d8df820cc4fe95389118ed4b2222d219df36df57cfe1e` | MATCH | MATCH |
| 2 | `functions/_shared/deletion/assertAccountActiveIfAuthenticated.ts` | 918 | `bc8998c1f6e4fb2cd76b4a126974cdb681cb37451b041253f0558678061b8661` | MATCH | MATCH |
| 3 | `functions/_shared/deletion/common.ts` | 17,381 | `34425a84ea83beb2d2a2ea53aebb533f26403b2d7136b653f0e6d63a74ffcf7c` | MATCH | MATCH |
| 4 | `functions/_shared/llmModelRouting.ts` | 8,641 | `4e39d7a549e1f6222e34ec7eddb89f8a6da8fffa4ba1509bf2495f7c1c6ef14c` | MATCH | ABSENT |
| 5 | `functions/_shared/scanHelpers.ts` | 25,763 | `4addf3a4199145bdea516aae7a858e788e00818753fc26eabd7441b1b26dee45` | MATCH | MATCH |
| 6 | `functions/scan-identify/commerceOutcomeCapture.ts` | 9,130 | `5e4aee263402910e01f7cd7912c1e65c193d50ec4dfc7e0c09975a41bd345b8a` | MATCH | MATCH |
| 7 | `functions/scan-identify/commerceOutcomeCaptureConfig.ts` | 1,174 | `2c031579d1f9594ea3cf95b8d469b4cb1a84861772d5b7ec99a599b42aa7116a` | MATCH | MATCH |
| 8 | `functions/scan-identify/commerceRelevanceAgreement.ts` | 12,897 | `68cf5b7915d89669c105ef7aec9c96fc816695ffa1f25af1d3c188a92a99c662` | MATCH | MATCH |
| 9 | `functions/scan-identify/commerceRelevanceColorMaterial.ts` | 9,616 | `a30ccc822b96e3a94a681a0edfc8be0d278e9b44947475f6f0140c48bfe42bcf` | MATCH | MATCH |
| 10 | `functions/scan-identify/commerceRelevanceConfig.ts` | 2,325 | `5415c9b9ce779a5121da64a7c30fdc3484cd0cc7769492d0297aa1f73c18ae17` | MATCH | MATCH |
| 11 | `functions/scan-identify/commerceRelevanceDiversity.ts` | 7,383 | `8d3594f1c83c4361053ed8814144d927e29306c07553b3e9438ac62e46f96fe6` | MATCH | MATCH |
| 12 | `functions/scan-identify/commerceRelevanceFailure.ts` | 7,778 | `43f41679b1ad7593a56da54027d0be3a7f2207d96b8f5a74ae9928591f2fbc4f` | MATCH | MATCH |
| 13 | `functions/scan-identify/commerceRelevanceQueries.ts` | 11,467 | `e211c89949dba7e4d5df7e6b7c5d68c6081633d7c505f2b81ae21c3f9a63f779` | MATCH | MATCH |
| 14 | `functions/scan-identify/farfetchProvider.ts` | 13,691 | `964d3e762e7f4270a2e6774f431ea446b49f406b9905bbcee1a7b94ed9e3cfbe` | MATCH | MATCH |
| 15 | `functions/scan-identify/index.ts` | 127,688 | `c8d2e97e529d987bcc22af96fed83ff1b7fa1a44a5471fd88da64e1e0d680c7b` | MATCH | DIFFERS |
| 16 | `functions/scan-identify/kicksCrewProvider.ts` | 16,126 | `2ede064d186a568a0d2653862ca95a275ed26668b6c619e62b30100852d97bbf` | MATCH | MATCH |
| 17 | `functions/scan-identify/multiItemGarments.ts` | 7,799 | `6b91ff2b7978cc4a7975d0b4590e966633f1c260281c900316843c23d9260a16` | MATCH | MATCH |
| 18 | `functions/scan-identify/qualityTuneCommerce.ts` | 22,317 | `b81fa7f36374740c0a8884f0ae446651f6f2c8c1d76788415a567c44296507de` | MATCH | MATCH |
| 19 | `functions/scan-identify/qualityTuneConfig.ts` | 1,378 | `a42b08d900327d3cf8d6713aef9d074d5b2680c73ae3b244b767ed814c0aff70` | MATCH | MATCH |
| 20 | `functions/scan-identify/qualityTuneNormalize.ts` | 17,876 | `04e7ced94dd2d09f7de8b3a808411b24e58eed2a529368210cb5c1af26c30713` | MATCH | MATCH |
| 21 | `functions/scan-identify/qualityTuneTelemetry.ts` | 10,408 | `1ac173e6d7771928f5462696f27732ec1331a8b2919d932f25b549b65f522b1d` | MATCH | MATCH |
| 22 | `functions/scan-identify/scanCommerceRouter.ts` | 28,997 | `eebe939ea6d4d1dd88c26b6eabf597da904e2cecc587065ed5bd7a2a3889940f` | MATCH | MATCH |
| 23 | `functions/scan-identify/scanIntelligenceCapture.ts` | 9,306 | `9e6e3f3ddef8123ab97f2a700ddd7aefc581bcd1b6600d1b9aded32b2d19f074` | MATCH | MATCH |
| 24 | `functions/scan-identify/scannerCategoryRoute.ts` | 12,411 | `27fa543783719298c1bb10c799098ed349b131c8646814a30ba6a07e515eb7a0` | MATCH | MATCH |
| 25 | `functions/scan-identify/scannerIntelligenceConfig.ts` | 1,499 | `cff584c4617cf2e3229c262cae7e87c39a7dbc42f432fcebba65549d2da6a7b2` | MATCH | MATCH |
| 26 | `functions/scan-identify/scannerQualityGate.ts` | 21,570 | `504c61acb73580cb8a2aeab1b33f8b1f0507cdb76d890cb0e27a80282868048c` | MATCH | MATCH |
| 27 | `functions/scan-identify/shoppingProvider.ts` | 16,407 | `cac78839f76265e0687fa6512de2e473c86008107ceb42c361a08a84c18aa4c4` | MATCH | MATCH |
| 28 | `functions/scan-identify/similarityMatcher.ts` | 13,246 | `5a95c4aafbb1fbd25ff8d1b3e724ec55dbc19d9b107770303e2093d6eb192401` | MATCH | MATCH |
| 29 | `functions/scan-identify/textScanCommerceParityConfig.ts` | 1,610 | `2b2ceba5790935244cbb6e8f90cd6d176e522284c4f7ee7b834be478347021de` | MATCH | MATCH |

## iOS convergence exceptions

- `functions/_shared/llmModelRouting.ts` — **ABSENT**
- `functions/scan-identify/index.ts` — **DIFFERS**

Required direction: canonical deployed-matching source -> implement and verify `commerceIntent` -> synchronise the complete 29-file tree into iOS -> synchronise into Android. Do not add `commerceIntent` surgically to the stale iOS function. Do not create a third variant.

