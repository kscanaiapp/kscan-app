/**
 * Minimal standalone debug server for the glasses analyze smoke test.
 * Not intended for production rollout.
 *
 * Usage:
 *   KSCAN_GLASSES_ANALYZE_ENABLED=true node backend/server.js
 */

const express = require('express');
require('dotenv').config();

const app = express();

// JSON body parser with a safe limit (8 MB + headroom for JSON overhead)
app.use(express.json({ limit: '8.5mb' }));

// No body logging or request logging that includes payloads.
// If a general request logger is added later, it must skip this endpoint.

const glassesRoute = require('./routes/glasses-analyze-debug');
app.use(glassesRoute);

// Health check
app.get('/api/glasses/health', (_req, res) => {
  res.json({ ok: true, service: 'kscan-glasses-debug-backend' });
});

// Global safe error handler — never leaks raw messages
app.use((err, _req, res, _next) => {
  const { mapGlassesAnalyzeError } = require('./utils/mapGlassesAnalyzeError');
  const safe = mapGlassesAnalyzeError(err);
  res.status(safe.status).json(safe.body);
});

const PORT = process.env.KSCAN_GLASSES_PORT || 3002;
app.listen(PORT, () => {
  console.log(`[KSCAN-GLASSES] Debug backend listening on ${PORT}`);
});
