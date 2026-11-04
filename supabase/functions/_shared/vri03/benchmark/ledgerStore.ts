/**
 * VRI-03 ledger stores.
 *
 * The paid runner needs DURABLE state: each entry is appended and fsync'd
 * before the guard lets the call proceed, so a crash can lose at most an
 * in-flight response, never the record that the call was attempted (which is
 * then reconciled as `uncertain`, charged worst case).
 *
 * The ledger file holds only token counts, costs, opaque item ids and arm
 * names. It contains no credentials, prompts, images or user data. Keep it
 * outside git (operator-owned path) and carry it between runs.
 */

import { inspectLedger, type LedgerEntry, type LedgerInspection, LedgerIntegrityError } from './budgetGuard.ts';

export type LedgerStore = {
  readonly durable: boolean;
  readAll(): LedgerEntry[];
  appendDurable(entry: LedgerEntry): void;
};

export function parseLedgerJsonl(text: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  const lines = text.split(/\r?\n/);
  // A trailing newline is expected; any other blank or partial line is corruption.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.forEach((line, i) => {
    try {
      out.push(JSON.parse(line) as LedgerEntry);
    } catch {
      throw new LedgerIntegrityError(`line ${i + 1} is not valid JSON (truncated write?)`);
    }
  });
  return out;
}

/** In-memory store for offline/mock runs and tests. Not durable. */
export function createMemoryLedgerStore(initial: readonly LedgerEntry[] = []): LedgerStore & { lines: string[] } {
  const lines = initial.map((e) => JSON.stringify(e));
  return {
    durable: false,
    lines,
    readAll: () => parseLedgerJsonl(lines.length ? `${lines.join('\n')}\n` : ''),
    appendDurable: (e) => { lines.push(JSON.stringify(e)); },
  };
}

/** Append-only JSONL file; every append is fsync'd before returning. */
export function createFileLedgerStore(path: string): LedgerStore {
  return {
    durable: true,
    readAll() {
      try {
        return parseLedgerJsonl(Deno.readTextFileSync(path));
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) return [];
        throw e;
      }
    },
    appendDurable(entry) {
      const file = Deno.openSync(path, { append: true, create: true, write: true });
      try {
        const bytes = new TextEncoder().encode(`${JSON.stringify(entry)}\n`);
        let written = 0;
        while (written < bytes.length) written += file.writeSync(bytes.subarray(written));
        file.syncSync();
      } finally {
        file.close();
      }
    },
  };
}

export type LedgerReadiness = { ready: boolean; blockers: string[]; inspection: LedgerInspection | null };

/**
 * Paid-runner precondition: the store is durable, the ledger parses, its chain
 * verifies, nothing is left open (reconcile first), and it has not halted.
 */
export function checkLedgerReadiness(store: LedgerStore): LedgerReadiness {
  const blockers: string[] = [];
  if (!store.durable) blockers.push('ledger store is not durable');
  let entries: LedgerEntry[];
  try {
    entries = store.readAll();
  } catch (e) {
    return { ready: false, blockers: [...blockers, `ledger unreadable: ${(e as Error).message}`], inspection: null };
  }
  const inspection = inspectLedger(entries);
  if (!inspection.ok) blockers.push(`ledger chain invalid: ${inspection.problems.slice(0, 3).join('; ')}`);
  if (inspection.openIntents.length) blockers.push(`${inspection.openIntents.length} unreconciled open intent(s); load the guard once to charge them worst case`);
  if (inspection.halted) blockers.push(`ledger is halted: ${inspection.haltReasons.join('; ')}`);
  return { ready: blockers.length === 0, blockers, inspection };
}
