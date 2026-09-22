/**
 * Shelf refinement chips (Build 35 Commerce UX §14-20, §46).
 *
 * TWO KINDS, NEVER CONFLATED.
 *  - ACTIVE CONSTRAINTS are state the shopping intent already holds ("black",
 *    "under 150 USD", "no leather"). They are read-only: shown so the customer
 *    can see what K Scan retained, never tapped to mutate anything here.
 *  - ACTIONS are commands ("Different", "Another", "Not these", "Cheaper").
 *    A tap sends the SAME sentence a customer could type, through the same
 *    send path, so Commerce V2's deterministic parser
 *    (supabase/functions/stylechat-generate/eliseCommerceIntent.ts) decides
 *    what it means. There is no chip-only semantics, no client-side shelf
 *    memory, and no second refinement engine: a chip is typing, pre-filled.
 *
 * An action is offered only when the parser could actually resolve it from
 * state the block already shows -- "Cheaper" needs a budget or same-currency
 * shown prices, "More casual" needs a formality -- so a chip never leads
 * straight into "I need a reference first".
 */

export interface ShelfIntentSummary {
  category?: string | null;
  color?: string | null;
  material?: string | null;
  silhouette?: string | null;
  formality?: string | null;
  budget?: { amount: number; currency: string } | null;
  /** Commerce V2 exclusions, wire format "axis:token". */
  exclusions?: unknown;
}

export interface ActiveConstraintChip {
  key: string;
  label: string;
  accessibilityLabel: string;
}

export type RefinementActionKey =
  | 'different'
  | 'another'
  | 'not_those'
  | 'clear'
  | 'cheaper'
  | 'more_casual'
  | 'dressier';

export interface RefinementAction {
  key: RefinementActionKey;
  label: string;
  /** The exact sentence sent, as if typed. */
  message: string;
}

/**
 * The sentences each action sends. Every one is pinned by a test against the
 * server's own detectors, so a chip cannot drift into meaning something the
 * parser does not recognise.
 */
export const REFINEMENT_MESSAGES: Readonly<Record<RefinementActionKey, { label: string; message: string }>> = {
  different: { label: 'Different', message: 'Show me something different' },
  another: { label: 'Another', message: 'Another one' },
  not_those: { label: 'Not these', message: 'Not these' },
  clear: { label: 'Show hidden', message: 'Show me everything again' },
  cheaper: { label: 'Cheaper', message: 'Something cheaper' },
  more_casual: { label: 'More casual', message: 'More casual' },
  dressier: { label: 'Dressier', message: 'Dressier' },
};

const TOKEN_RE = /^[a-z][a-z0-9 -]{0,39}$/i;

function cleanToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return TOKEN_RE.test(trimmed) ? trimmed.toLowerCase() : null;
}

function budgetLabel(budget: ShelfIntentSummary['budget']): string | null {
  if (!budget || !Number.isFinite(budget.amount) || budget.amount <= 0) return null;
  const code = typeof budget.currency === 'string' && /^[a-z]{3}$/i.test(budget.currency.trim())
    ? budget.currency.trim().toUpperCase()
    : null;
  // A budget whose currency is unknown is not shown as one: "under 150" in no
  // currency is not a constraint anyone can check.
  if (!code) return null;
  const amount = Number.isInteger(budget.amount) ? String(budget.amount) : budget.amount.toFixed(2);
  return `Under ${amount} ${code}`;
}

/** "material:leather" -> "No leather". Unknown shapes render nothing. */
function exclusionLabel(entry: unknown): string | null {
  if (typeof entry !== 'string') return null;
  const index = entry.indexOf(':');
  if (index <= 0) return null;
  const token = cleanToken(entry.slice(index + 1));
  return token ? `No ${token}` : null;
}

/**
 * The retained request, as chips. Order follows how people say it: colour,
 * material, shape, category, formality, budget, then exclusions.
 */
export function activeConstraintChips(
  summary: ShelfIntentSummary | null | undefined,
  hiddenCount?: number | null,
): ActiveConstraintChip[] {
  if (!summary && !(typeof hiddenCount === 'number' && hiddenCount > 0)) return [];
  const chips: ActiveConstraintChip[] = [];
  const push = (key: string, label: string | null) => {
    if (!label || chips.some((chip) => chip.label === label)) return;
    chips.push({ key, label, accessibilityLabel: `Active filter: ${label}` });
  };
  for (const [key, value] of [
    ['color', summary?.color],
    ['material', summary?.material],
    ['silhouette', summary?.silhouette],
    ['category', summary?.category],
    ['formality', summary?.formality],
  ] as const) {
    push(key, cleanToken(value));
  }
  push('budget', budgetLabel(summary?.budget));
  const exclusions = Array.isArray(summary?.exclusions) ? summary.exclusions : [];
  exclusions.forEach((entry, i) => push(`exclusion-${i}`, exclusionLabel(entry)));
  if (typeof hiddenCount === 'number' && hiddenCount > 0) {
    chips.push({
      key: 'hidden',
      label: `${hiddenCount} hidden`,
      accessibilityLabel: `${hiddenCount} options you ruled out are hidden`,
    });
  }
  return chips;
}

/** One shared, provider-declared currency across the shelf, or null. */
function shelfSharesDeclaredCurrency(products: readonly unknown[]): boolean {
  if (!products.length) return false;
  let shared: string | null = null;
  for (const product of products) {
    const raw = product && typeof product === 'object' ? (product as { currency?: unknown }).currency : null;
    const code = typeof raw === 'string' && /^[a-z]{3}$/i.test(raw.trim()) ? raw.trim().toUpperCase() : null;
    if (!code) return false;
    if (shared && shared !== code) return false;
    shared = code;
  }
  return true;
}

/**
 * The actions this shelf can honestly offer.
 *
 * Commands that act on what was shown (Different / Another / Not these) need a
 * shelf with results. "Show hidden" needs something hidden. Relative requests
 * need the reference the parser will use.
 */
export function refinementActions(input: {
  status: 'results' | 'no_matches' | 'exhausted' | 'error';
  products: readonly unknown[];
  summary: ShelfIntentSummary | null | undefined;
  hiddenCount?: number | null;
  memoryOp?: string | null;
}): RefinementAction[] {
  const keys: RefinementActionKey[] = [];
  const hasResults = input.status === 'results' && input.products.length > 0;
  if (hasResults && input.memoryOp !== 'reference') {
    keys.push('different', 'another', 'not_those');
  }
  if (hasResults && (budgetLabel(input.summary?.budget) || shelfSharesDeclaredCurrency(input.products))) {
    keys.push('cheaper');
  }
  if (hasResults && cleanToken(input.summary?.formality)) {
    keys.push('more_casual', 'dressier');
  }
  if (input.status !== 'error' && typeof input.hiddenCount === 'number' && input.hiddenCount > 0) {
    keys.push('clear');
  }
  return keys.map((key) => ({ key, ...REFINEMENT_MESSAGES[key] }));
}
