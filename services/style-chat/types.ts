// StyleChat v0.1 — type contracts. No live LLM wired here.

export type StyleChatMode =
  | 'general'
  | 'outfit_advice'
  | 'scan_refinement'
  | 'shopping_help'
  | 'dressing_room'
  | 'closet_planning'
  | 'budget_finder';

export type StyleChatSender = 'user' | 'assistant' | 'system';

export interface StyleChatUiBlock {
  type: string;
  title?: string;
  body?: string;
  [key: string]: unknown;
}

export interface StyleChatMessage {
  id: string;
  sessionId: string;
  sender: StyleChatSender;
  content: string;
  referencedScanIds: string[];
  referencedSavedItemIds: string[];
  referencedDressingRoomIds: string[];
  referencedCatalogItems: string[];
  uiBlocks: StyleChatUiBlock[];
  provider: string;
  model?: string;
  tokenEstimate: number;
  createdAt: string;
}

export interface StyleChatSession {
  id: string;
  title: string;
  mode: StyleChatMode;
  createdAt: string;
  updatedAt: string;
}

export interface StyleChatContext {
  recentScanSummaries: Array<{
    id: string;
    category?: string;
    color?: string;
    silhouette?: string;
    styleTags?: string[];
  }>;
  savedItemIds: string[];
  dressingRoomIds: string[];
  preferences: {
    preferredStyles: string[];
    dislikedStyles: string[];
    preferredColors: string[];
    budgetRange?: {
      min?: number;
      max?: number;
    };
  };
  memoryContext?: {
    confidenceScore: number;
    implementedSignals: string[];
    missingSignals: string[];
    sourceCounts: {
      memoryEvents: number;
      scans?: number;
      savedItems?: number;
      dressingRoomSignals?: number;
    };
    favoriteColors: Array<{ value: string; count: number; confidence: number }>;
    favoriteBrands: Array<{ value: string; count: number; confidence: number }>;
    favoriteCategories: Array<{ value: string; count: number; confidence: number }>;
    budgetRange: {
      min?: number;
      max?: number;
      average?: number;
      confidence: number;
    } | null;
  };
}

export interface StyleChatInput {
  sessionId: string;
  message: string;
  context: StyleChatContext;
}

export interface StyleChatResult {
  message: Omit<StyleChatMessage, 'sessionId'>;
  usage: {
    messagesUsed: number;
    messagesLimit: number;
  };
}

export interface StyleChatProvider {
  generateReply(input: StyleChatInput): Promise<StyleChatResult>;
}
