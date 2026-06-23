const express = require('express');
const { validateGlassesAnalyzeRequest } = require('../middleware/validateGlassesAnalyzeRequest');
const { mapGlassesAnalyzeError } = require('../utils/mapGlassesAnalyzeError');
const { createGlassesAnalyzeService } = require('../services/glassesAnalyzeService');

const router = express.Router();

// POST /api/glasses/analyze-debug
// Isolated endpoint for Google glasses controlled live smoke test.
// Does not log image payloads, base64, or raw model responses.
router.post('/api/glasses/analyze-debug', validateGlassesAnalyzeRequest, async (req, res) => {
  try {
    const service = createGlassesAnalyzeService();
    const result = await service.analyze({
      image: req.body.image,
      requestId: req.glassesRequestId,
      client: req.glassesClient,
    });
    return res.status(200).json(result);
  } catch (err) {
    const safe = mapGlassesAnalyzeError(err, req.glassesRequestId);
    return res.status(safe.status).json(safe.body);
  }
});

module.exports = router;
