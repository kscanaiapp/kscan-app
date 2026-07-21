# 07 — DR-1 Test Report

## Focused Node suite

```text
node --test
  __tests__/dressingRoomCanonicalItemContract.test.js
  __tests__/dressingRoomItemContract.test.js
  __tests__/eliseRoomItemEvidence.test.js
  __tests__/dressingRoomSavePolicy.test.js
```

| Metric | Value |
| ------ | ----- |
| Exit | 0 |
| Pass | 31 |
| Fail | 0 |
| Skip | 0 |

## Coverage highlights

- Flag defaults OFF  
- Commerce order / dedupe / fail-open  
- Image storage > remote > local; signed URL rejected  
- Canonical provenance + dedupe key  
- Elise `dressing_room_item` parse + evidence helpers  
- Legacy product snapshot policy still green  

## Limitations

- No live Gemini / ElevenLabs  
- No production migration apply  
- No physical device commerce round-trip  
- Broad full-repo suite not required for this handoff; focused DR surface validated  
