// app/api/analyze+api.js — Expo Route Handler (Gemini backend)
//
// Schema enforcement constants MUST stay behaviorally identical to server.js.
// When either file changes these values, update BOTH and bump the versions.
// Normalization version: 2.0  |  Parser version: 3.0  |  Prompt version: 2.0

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ─── Canonical enum sets (must match server.js CATEGORY_CANONICAL / SILHOUETTE_CANONICAL) ─
const CATEGORY_CANONICAL  = new Set(['Tops', 'Bottoms', 'Outerwear', 'Footwear', 'Accessories', 'Dresses']);
const SILHOUETTE_CANONICAL = new Set(['Oversized', 'Fitted', 'Relaxed', 'Boxy', 'Cropped', 'Wide-leg', 'Slim', 'Flowy', 'Straight', 'Layered']);

// Resolve a raw value to a canonical enum member.
// Mirrors server.js resolveCompoundValue — handles compound strings, case-insensitive
// match, and safe fallback. NEVER returns an invalid enum value.
function resolveCompoundValue(rawValue, canonicalSet, fallback) {
  if (!rawValue || typeof rawValue !== 'string') return fallback;
  for (const v of canonicalSet) {
    if (v.toLowerCase() === rawValue.toLowerCase()) return v;
  }
  const tokens = rawValue.split(/[,\/|]+|\s+and\s+/i).map(t => t.trim()).filter(Boolean);
  for (const token of tokens) {
    for (const v of canonicalSet) {
      if (v.toLowerCase() === token.toLowerCase()) return v;
    }
  }
  return fallback;
}

const SYSTEM_PROMPT = `You are a high-fashion AI stylist with computer vision. Your ENTIRE response must be a single valid JSON object.

CRITICAL: Start your response with { and end with }. No markdown fences, no prose, no explanation outside the JSON.

If the image does NOT contain clothing, footwear, or accessories:
{"type":"non-fashion","message":"<one sentence describing what the image actually shows>"}

If the image DOES contain a fashion item:
{"type":"fashion","result":"<2-4 sentence professional style breakdown with one pairing suggestion>","metadata":{"category":"<EXACTLY ONE of: Footwear | Outerwear | Tops | Bottoms | Accessories | Dresses>","itemType":"<specific item e.g. sneaker, hoodie, tote bag, blazer, jeans>","material":"<visible fabric/construction e.g. leather, denim, cotton, quilted nylon>","style":"<EXACTLY ONE of: Casual | Streetwear | Minimalist | Classic | Bohemian | Athleisure | Formal | Grunge>","color":"<dominant palette e.g. Black, Navy / White, Earth Tones>","silhouette":"<EXACTLY ONE fit descriptor: Oversized | Fitted | Relaxed | Boxy | Cropped | Wide-leg | Slim | Flowy | Straight | Layered>"}}

Example for a white hoodie:
{"type":"fashion","result":"A crisp white hoodie featuring a relaxed fit and minimal logo detailing. The cotton-blend construction makes it a comfortable everyday essential. Pair with slim black jeans and white sneakers for a clean casual look.","metadata":{"category":"Tops","itemType":"hoodie","material":"cotton-blend","style":"Casual","color":"White","silhouette":"Relaxed"}}`;

function extractImageParts(imageInput) {
  if (!imageInput || typeof imageInput !== 'string') {
    return { mimeType: '', data: '' };
  }
  const match = imageInput.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
  if (match) return { mimeType: match[1], data: match[2] };
  return { mimeType: 'image/jpeg', data: imageInput };
}

// JSON-first parser — mirrors the core of server.js parseAIResponse.
// Tries to extract and canonicalise structured metadata from the AI response.
// Falls back to the legacy Category:/Color:/Silhouette: regex format for
// backward compatibility with non-JSON Gemini responses.
function parseAIResponseLocal(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const text = rawText.trim();

  // Attempt 1 — direct JSON parse
  const jsonAttempts = [text];
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenceMatch) jsonAttempts.unshift(fenceMatch[1].trim());
  const start = text.indexOf('{');
  if (start !== -1) {
    let depth = 0, inStr = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) { escaped = c === '\\' && !escaped; if (c === '"' && !escaped) inStr = false; if (c !== '\\') escaped = false; continue; }
      if (c === '"') inStr = true;
      if (c === '{') depth++;
      if (c === '}') depth--;
      if (depth === 0) { jsonAttempts.push(text.slice(start, i + 1).trim()); break; }
    }
  }
  for (const candidate of [...new Set(jsonAttempts)]) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === 'object') {
        const type = String(obj.type || '').toLowerCase();
        if (type.includes('non-fashion') || type.includes('non_fashion')) {
          return { type: 'non-fashion', message: obj.message || 'Not a fashion item.' };
        }
        const meta = obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : obj;
        const category  = resolveCompoundValue(meta.category  || meta.itemType  || '', CATEGORY_CANONICAL,   'Accessories');
        const silhouette = resolveCompoundValue(meta.silhouette || meta.fit || '',    SILHOUETTE_CANONICAL,  'Relaxed');
        const color     = String(meta.color || meta.palette || '').trim() || '';
        if (category || color || silhouette) {
          return {
            type: 'fashion',
            result: String(obj.result || obj.analysis || obj.description || '').trim(),
            metadata: { category, itemType: meta.itemType || '', material: meta.material || '', style: meta.style || '', color, silhouette },
          };
        }
      }
    } catch (_) {}
  }

  // Attempt 2 — legacy text format (Category:/Color:/Silhouette: lines)
  const catMatch = text.match(/Category:\s*(.+?)(?=\n|$)/i);
  const colMatch  = text.match(/Color:\s*(.+?)(?=\n|$)/i);
  const silMatch  = text.match(/Silhouette:\s*(.+?)(?=\n|$)/i);
  if (catMatch || colMatch || silMatch) {
    const category  = resolveCompoundValue(catMatch?.[1]?.trim() || '', CATEGORY_CANONICAL,  'Accessories');
    const silhouette = resolveCompoundValue(silMatch?.[1]?.trim() || '', SILHOUETTE_CANONICAL, 'Relaxed');
    return {
      type: 'fashion',
      result: text.replace(/\n\s*Category:\s*[^\n]+/gi, '').replace(/\n\s*Color:\s*[^\n]+/gi, '').replace(/\n\s*Silhouette:\s*[^\n]+/gi, '').trim() || text,
      metadata: { category, color: colMatch?.[1]?.trim() || '', silhouette },
    };
  }

  return null;
}

export async function POST(request) {
  try {
    if (!GEMINI_API_KEY) {
      console.error('Missing GEMINI_API_KEY');
      return Response.json(
        { result: 'Server is missing GEMINI_API_KEY in the .env file.', metadata: { category: '', color: '', silhouette: '' } },
        { status: 500 }
      );
    }

    const { image } = await request.json();
    const { mimeType, data } = extractImageParts(image);

    if (!data) {
      return Response.json(
        { result: 'No image data received. Please try taking the photo again.', metadata: { category: '', color: '', silhouette: '' } },
        { status: 400 }
      );
    }

    const geminiUrl =
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GEMINI_API_KEY}`;

    if (process.env.NODE_ENV !== 'production') {
      console.log('[K-SCAN] model:', 'gemini-2.0-flash-exp');
    }

    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: SYSTEM_PROMPT }, { inline_data: { mime_type: mimeType || 'image/jpeg', data } }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 1024, topP: 0.95 },
      }),
    });

    const json = await response.json();
    if (process.env.NODE_ENV !== 'production') {
      console.log('[K-SCAN] gemini status:', response.status);
    }

    if (!response.ok) {
      const message = json?.error?.message || `Gemini API error: ${response.status}`;
      if (process.env.NODE_ENV !== 'production') {
        console.error('Gemini API error:', message);
      }
      return Response.json(
        { result: `Analysis failed: ${message}. Check your API key and quota.`, metadata: { category: '', color: '', silhouette: '' } },
        { status: 502 }
      );
    }

    const textPart = json?.candidates?.[0]?.content?.parts?.[0];
    const rawText  = typeof textPart?.text === 'string' ? textPart.text.trim() : '';

    if (rawText) {
      const parsed = parseAIResponseLocal(rawText);
      if (parsed) {
        if (parsed.type === 'non-fashion') {
          return Response.json({ type: 'non-fashion', message: parsed.message, metadata: { category: '', color: '', silhouette: '' }, products: [] }, { status: 200 });
        }
        return Response.json({ type: 'fashion', result: parsed.result, metadata: parsed.metadata, products: [] }, { status: 200 });
      }
    }

    const blockReason = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason;
    if (blockReason && blockReason !== 'STOP') {
      return Response.json(
        { result: `Analysis was not generated (${blockReason}). Try a different photo.`, metadata: { category: '', color: '', silhouette: '' } },
        { status: 200 }
      );
    }

    return Response.json(
      { result: "AI couldn't describe this look. Try a clearer, full-outfit photo.", metadata: { category: '', color: '', silhouette: '' } },
      { status: 200 }
    );
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('Server Error:', error instanceof Error ? error.message : error);
    }
    return Response.json(
      { result: 'Server error while analyzing image. Please try again.', metadata: { category: '', color: '', silhouette: '' } },
      { status: 500 }
    );
  }
}
