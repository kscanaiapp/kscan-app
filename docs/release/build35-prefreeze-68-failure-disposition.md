# Previous 68 failures ? individual disposition

All 68 captured failures have a source SHA, exact suite/line and assertion, root cause and passing counterpart in [the structured ledger](evidence/prefreeze-68-dispositions.json). The 11 corresponding Build 35 suites passed 336/336. Isolated pre-freeze write guards additionally passed 67/67 after temporary removal and restoration of ignored local link metadata. No test failures were hidden or baseline-expanded. All corresponding suites were included in the candidate 5175f01f full run: 11,288 passed, zero failed, 98 skipped overall. This does not turn the original pre-freeze SHA into a passing Build 35 candidate.

| ID | Suite | Classification | Disposition |
|---|---|---|---|
| PF-001 | __tests__/build34SharedClientConvergence.test.js:781:1 | Windows harness | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-002 | __tests__/build34SharedClientConvergence.test.js:820:1 | Windows harness | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-003 | __tests__/build34SharedClientConvergence.test.js:839:1 | Windows harness | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-004 | __tests__/build34SharedClientConvergence.test.js:856:1 | Windows harness | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-005 | __tests__/closetCloudMediaContract.test.js:269:1 | Branch contract drift | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-006 | __tests__/dressingRoomBlockingUi.test.js:528:1 | Branch contract drift | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-007 | __tests__/llmModelRoutingParity.test.js:325:1 | Branch contract drift | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-008 | __tests__/phase2b4CrossPlatformParity.test.js:50:1 | Branch contract drift | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-009 | __tests__/phase2b4CrossPlatformParity.test.js:73:1 | Branch contract drift | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-010 | __tests__/posthogDisabledStateEgress.test.js:76:3 | Windows harness | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-011 | __tests__/posthogDisabledStateEgress.test.js:76:3 | Windows harness | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-012 | __tests__/posthogDisabledStateEgress.test.js:76:3 | Windows harness | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-013 | __tests__/posthogDisabledStateEgress.test.js:76:3 | Windows harness | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-014 | __tests__/posthogDisabledStateEgress.test.js:76:3 | Windows harness | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-015 | __tests__/posthogDisabledStateEgress.test.js:76:3 | Windows harness | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-016 | __tests__/posthogDisabledStateEgress.test.js:76:3 | Windows harness | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-017 | __tests__/posthogDisabledStateEgress.test.js:76:3 | Windows harness | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-018 | __tests__/posthogDisabledStateEgress.test.js:76:3 | Windows harness | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-019 | __tests__/posthogDisabledStateEgress.test.js:91:1 | Windows harness | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-020 | __tests__/posthogDisabledStateEgress.test.js:105:1 | Windows harness | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-021 | __tests__/posthogDisabledStateEgress.test.js:130:1 | Windows harness | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-022 | __tests__/posthogDisabledStateEgress.test.js:145:1 | Windows harness | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-023 | __tests__/scanIdentifyEdgeContract.test.js:560:1 | Branch contract drift | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-024 | __tests__/scanIdentifyEdgeContract.test.js:594:1 | Branch contract drift | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-025 | __tests__/scanIdentifyEdgeContract.test.js:641:1 | Branch contract drift | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-026 | __tests__/scanIdentifyEdgeContract.test.js:649:1 | Branch contract drift | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-027 | __tests__/scanIdentifyEdgeContract.test.js:677:1 | Branch contract drift | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-028 | __tests__/security/rpcHardeningMigration.test.js:62:1 | Branch contract drift | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-029 | __tests__/staging/easProfileParity.test.js:58:1 | Branch contract drift | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-030 | __tests__/staging/easProfileParity.test.js:84:1 | Branch contract drift | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-031 | __tests__/staging/stagingV2WriteGuard.test.js:100:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-032 | __tests__/staging/stagingV2WriteGuard.test.js:107:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-033 | __tests__/staging/stagingV2WriteGuard.test.js:113:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-034 | __tests__/staging/stagingV2WriteGuard.test.js:119:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-035 | __tests__/staging/stagingV2WriteGuard.test.js:125:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-036 | __tests__/staging/stagingV2WriteGuard.test.js:100:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-037 | __tests__/staging/stagingV2WriteGuard.test.js:107:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-038 | __tests__/staging/stagingV2WriteGuard.test.js:113:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-039 | __tests__/staging/stagingV2WriteGuard.test.js:119:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-040 | __tests__/staging/stagingV2WriteGuard.test.js:125:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-041 | __tests__/staging/stagingV2WriteGuard.test.js:100:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-042 | __tests__/staging/stagingV2WriteGuard.test.js:107:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-043 | __tests__/staging/stagingV2WriteGuard.test.js:113:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-044 | __tests__/staging/stagingV2WriteGuard.test.js:119:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-045 | __tests__/staging/stagingV2WriteGuard.test.js:125:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-046 | __tests__/staging/stagingV2WriteGuard.test.js:100:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-047 | __tests__/staging/stagingV2WriteGuard.test.js:107:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-048 | __tests__/staging/stagingV2WriteGuard.test.js:113:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-049 | __tests__/staging/stagingV2WriteGuard.test.js:119:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-050 | __tests__/staging/stagingV2WriteGuard.test.js:125:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-051 | __tests__/staging/stagingV2WriteGuard.test.js:100:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-052 | __tests__/staging/stagingV2WriteGuard.test.js:107:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-053 | __tests__/staging/stagingV2WriteGuard.test.js:113:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-054 | __tests__/staging/stagingV2WriteGuard.test.js:119:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-055 | __tests__/staging/stagingV2WriteGuard.test.js:125:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-056 | __tests__/staging/stagingV2WriteGuard.test.js:100:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-057 | __tests__/staging/stagingV2WriteGuard.test.js:107:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-058 | __tests__/staging/stagingV2WriteGuard.test.js:113:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-059 | __tests__/staging/stagingV2WriteGuard.test.js:119:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-060 | __tests__/staging/stagingV2WriteGuard.test.js:125:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-061 | __tests__/staging/stagingV2WriteGuard.test.js:100:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-062 | __tests__/staging/stagingV2WriteGuard.test.js:107:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-063 | __tests__/staging/stagingV2WriteGuard.test.js:113:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-064 | __tests__/staging/stagingV2WriteGuard.test.js:119:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-065 | __tests__/staging/stagingV2WriteGuard.test.js:125:3 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-066 | __tests__/staging/stagingV2WriteGuard.test.js:138:1 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-067 | __tests__/staging/stagingV2WriteGuard.test.js:149:1 | Local environment | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
| PF-068 | __tests__/terminalDeletionCleanup.test.js:1510:1 | Windows harness | PASS on corresponding integration suite; PASS in candidate 5175f01f full run |
