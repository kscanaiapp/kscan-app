// Type contracts for the Style Memory layer.
// No live LLM, no biometrics, no protected-trait fields.

export type StyleMemoryEventType =
  | 'color_preference'
  | 'brand_preference'
  | 'category_preference'
  | 'budget_signal'
  | 'dressing_room_positive_feedback';

export type StyleMemorySourceKind =
  | 'scan'
  | 'saved_item'
  | 'dressing_room'
  | 'product'
  | 'profile';

export interface StyleMemorySourceRef {
  kind: StyleMemorySourceKind;
  id: string;
}

export interface StyleMemorySignalItem {
  value: string;
  count: number;
  confidence: number;
}

export interface StyleMemoryBudget {
  min?: number;
  max?: number;
  average?: number;
  confidence: number;
}

// ── Per-event-type payload interfaces ─────────────────────────────────────────

export interface ColorPreferencePayload {
  signalKey: string;
  color: string;
  normalizedColor: string;
  count: number;
  source: StyleMemorySourceKind;
  sourceRefs: StyleMemorySourceRef[];
}

export interface BrandPreferencePayload {
  signalKey: string;
  brandName: string;
  normalizedBrandName: string;
  count: number;
  source: StyleMemorySourceKind;
  sourceRefs: StyleMemorySourceRef[];
}

export interface CategoryPreferencePayload {
  signalKey: string;
  category: string;
  normalizedCategory: string;
  count: number;
  source: StyleMemorySourceKind;
  sourceRefs: StyleMemorySourceRef[];
}

export interface BudgetSignalPayload {
  signalKey: string;
  priceMin?: number;
  priceMax?: number;
  priceAverage?: number;
  currency?: string;
  count: number;
  source: StyleMemorySourceKind;
  sourceRefs: StyleMemorySourceRef[];
}

export interface DressingRoomPositiveFeedbackPayload {
  signalKey: string;
  reactionType: string;
  brandName?: string;
  category?: string;
  count: number;
  source: StyleMemorySourceKind;
  sourceRefs: StyleMemorySourceRef[];
}

// ── Domain row (read from style_memory_events) ────────────────────────────────

export interface StyleMemoryEvent {
  id: string;
  userId: string;
  source: string;
  eventType: StyleMemoryEventType;
  signalKey: string | null;
  signalDate: string | null;
  payload: Record<string, unknown>;
  confidence: number;
  sourceRefs: StyleMemorySourceRef[];
  staleSourceCount: number;
  createdAt: string;
}

// ── Summary output shape ───────────────────────────────────────────────────────

export interface StyleMemorySummary {
  favoriteColors: StyleMemorySignalItem[];
  favoriteBrands: StyleMemorySignalItem[];
  favoriteCategories: StyleMemorySignalItem[];
  favoriteSilhouettes: StyleMemorySignalItem[];  // always empty in v0.3
  favoriteStyleTags: StyleMemorySignalItem[];    // always empty in v0.3
  avoidedColors: StyleMemorySignalItem[];        // always empty in v0.3
  budgetRange: StyleMemoryBudget | null;
  preferredFormality: { value: string; confidence: number } | null; // always null in v0.3
  confidenceScore: number;
  generatedAt: string;
  sourceCounts: {
    memoryEvents: number;
    scans?: number;
    savedItems?: number;
    dressingRoomSignals?: number;
    staleSourceRefs?: number;
  };
  implementedSignals: string[];
  missingSignals: string[];
}
