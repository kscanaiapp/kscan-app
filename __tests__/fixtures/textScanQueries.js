/**
 * TextScan deterministic regression query fixtures.
 *
 * Used to verify canonical path behavior across different fashion input types.
 */

export const TEXTSCAN_REGRESSION_QUERIES = [
  'black oversized blazer',
  'summer linen outfit beige',
  'minimal white leather sneakers',
  'vintage denim jacket with patches',
  'quiet luxury office outfit',
  'red satin evening dress',
  "men's cropped bomber jacket",
  'streetwear hoodie but minimal',
  'boho festival outfit with suede boots',
  'what should I wear with wide leg trousers',
  'blue bag',
  'asdf random non fashion text',
];

export const TEXTSCAN_FASHION_QUERIES = TEXTSCAN_REGRESSION_QUERIES.slice(0, 11);
export const TEXTSCAN_NON_FASHION_QUERIES = ['asdf random non fashion text', 'pizza recipe', 'weather today'];

export const MOCK_EDGE_RESPONSE_COMPLETED = {
  status: 'completed',
  attributes: {
    category: 'Outerwear',
    itemType: 'blazer',
    silhouette: 'Oversized',
    colorPalette: ['Black', 'Charcoal'],
    materialEstimate: 'Wool',
    pattern: 'Solid',
    texture: 'Smooth',
    styleTags: ['minimal', 'structured', 'tailored'],
    occasion: 'Work',
    confidenceScore: 0.92,
  },
  userMessage: 'A structured black oversized blazer with tailored detailing.',
  recommendedProducts: [],
};

export const MOCK_EDGE_RESPONSE_NON_FASHION = {
  status: 'non_fashion',
  userMessage: "This doesn't appear to be a fashion query.",
  recommendedProducts: [],
};

export const MOCK_EDGE_RESPONSE_FAILED = {
  status: 'failed',
  userMessage: "We couldn't analyze this request.",
  recommendedProducts: [],
};

export const MOCK_EDGE_RESPONSE_MALFORMED = {
  status: 'completed',
  attributes: {},
  userMessage: 'Incomplete analysis.',
  recommendedProducts: [],
};

export const MOCK_EDGE_RESPONSE_MARKDOWN_FENCED = {
  status: 'completed',
  attributes: {
    category: 'Footwear',
    itemType: 'sneakers',
    silhouette: 'Low-top',
    colorPalette: ['White'],
    materialEstimate: 'Leather',
    styleTags: ['minimal', 'clean'],
    occasion: 'Everyday',
    confidenceScore: 0.88,
  },
  userMessage: 'Minimal white leather sneakers with a clean low-top silhouette.',
  recommendedProducts: [],
};

export const MOCK_EDGE_RESPONSE_LOW_CONFIDENCE = {
  status: 'completed',
  attributes: {
    category: 'Accessories',
    itemType: 'bag',
    silhouette: 'Structured',
    colorPalette: ['Blue'],
    materialEstimate: 'Canvas',
    styleTags: ['casual'],
    occasion: 'Everyday',
    confidenceScore: 0.45,
  },
  userMessage: 'A casual blue bag in structured canvas.',
  recommendedProducts: [],
};

export const MOCK_EDGE_RESPONSE_MISSING_FIELDS = {
  status: 'completed',
  attributes: {
    category: 'Tops',
    confidenceScore: 0.75,
  },
  userMessage: 'A basic top.',
  recommendedProducts: [],
};
