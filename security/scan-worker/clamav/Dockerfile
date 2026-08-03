# Secure Image Ingestion Gate — isolated malware-scanning service (Phase 5).
#
# This container runs ONLY clamd + freshclam. It has no public unauthenticated
# endpoint: clamd's TCP socket (port 3310) is intended to be reachable only
# from the scan worker (security/scan-worker/scanQuarantineObject.js), inside
# a private network — never exposed to the public internet. See
# docs/security/malware-scanner-operations.md for the full deployment model
# and why this is NOT deployed by this branch (external infrastructure
# procurement/deployment requires explicit owner authorization).
#
# This image is NOT built, pushed, or deployed by anything in this repo's CI.
# It exists as reviewable infrastructure-as-code for the owner to deploy when
# ready (e.g. as a private Render background worker / internal service, a
# small Fly.io machine, or any host reachable only from the scan worker).

FROM clamav/clamav:1.3-stable

# freshclam keeps virus signatures current; clamav/clamav's entrypoint runs
# an initial freshclam pass and a periodic freshclam daemon automatically.
# CLAMD_STARTUP_TIMEOUT bounds how long the container waits for the initial
# signature database load before clamd starts accepting connections.
ENV CLAMD_STARTUP_TIMEOUT=1800

# clamd.conf hardening beyond the base image's defaults:
#   - StreamMaxLength bounds a single INSTREAM scan to the same ceiling as
#     security/uploads/image-ingestion-policy.json's largest maxCompressedBytes
#     (10MB), so a malicious/misbehaving caller can't force an oversized scan.
#   - MaxThreads bounds scanner concurrency (Phase 10: concurrent-scan limit).
#   - LogFile/LogTime are intentionally left at container defaults (stdout) —
#     never configured to log scanned file CONTENT, only clamd's own
#     operational lines (start/stop/signature reload), per "no content
#     logging."
COPY clamd.local.conf /etc/clamav/clamd.conf.d/local.conf

EXPOSE 3310

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD echo "PING" | nc -w 2 127.0.0.1 3310 | grep -q PONG || exit 1
