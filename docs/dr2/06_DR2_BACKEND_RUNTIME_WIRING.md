# DR-2 Backend Runtime Wiring

Chain (stylechat-generate/index.ts):
HTTP → auth → schema → attachment parse → flag gates → owned/shared resolve → focus/visual → E-4 wardrobe retrieval → relationship map → scoring → grounding → prompt → model → parse → adviceMetadata (flag) → telemetry → response.

| Stage | Module | Flag | Failure |
| --- | --- | --- | --- |
| Attachments | attachments.ts / attachmentContext.ts | DR-2 attachment flags | 400/403/404 fail-closed |
| Shared access | eliseSharedRoomAccess + index fetchers | sharedRoomEvidenceV1 | reject |
| Advice | eliseAdvicePipeline | adviceIntentsV1 (+ subordinates) | fail-open (null advice) |
| Metadata to client | index response | adviceMetadataClientV1 | omit field |
| Visual/E1-E3 | existing modules | prior flags | preserved |

Deployed function: not redeployed (read-only). Source wiring verified by Deno/Node tests.
