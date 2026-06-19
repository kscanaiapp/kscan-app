/**
 * StylePick type — backend-safe placeholder for future recommendation data.
 *
 * No price, retailer, stock, match percentage, or shop fields.
 */
export type StylePick = {
  id: string;
  title: string;
  subtitle?: string;
  imageUrl?: string;
  source?: 'scan' | 'upload' | 'stylechat' | 'system';
};

export type StylePicksStatus =
  | 'backend_not_connected'
  | 'loading'
  | 'empty'
  | 'error'
  | 'ready';
