# Patched URI decoder compatibility package

The existing Expo54 query-string consumer requires a CommonJS callable. Upstream patched decode-uri-component0.5.1 is ESM-only. This local package preserves the exact upstream security algorithm, changing only its module export and retaining the old plus-to-space convention. The provenance record pins official npm tarball integrity and original source SHA256; the regression reverses only those two adaptations and verifies the source hash. The original MIT license is retained.

This replaces the vulnerable locked decoder; it does not exempt or suppress the dependency reachability gate. All genuine query/Unicode decoding and malformed input tests use the actual query-string consumer. No Expo/React Navigation upgrade, API-key change, runtime paid call or binary build.
