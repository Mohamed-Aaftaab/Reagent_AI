import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ── Persistent JSON file store ────────────────────────────────────────────────
// Replaces the previous in-memory Map which lost all delegations on server restart.
// File is written synchronously on every update to ensure no delegation is lost
// even if the process exits unexpectedly between updates.
//
// Concurrent write safety: a simple write-lock flag prevents interleaved writes
// when multiple WebSocket clients submit tasks simultaneously. Queued writes are
// flushed in order after the in-flight write completes.

const STORE_PATH = join(process.cwd(), "delegations.json");

interface StoreData {
  delegations: Record<string, any>;
  subDelegations: Record<string, any>;
}

function loadStore(): StoreData {
  if (existsSync(STORE_PATH)) {
    try {
      return JSON.parse(readFileSync(STORE_PATH, "utf-8"));
    } catch {
      console.warn("[store] delegations.json is corrupt — starting fresh.");
    }
  }
  return { delegations: {}, subDelegations: {} };
}

// ── Write queue ───────────────────────────────────────────────────────────────
// Ensures writes are serialised: only one writeFileSync executes at a time,
// and any write that arrives while one is in-flight re-uses the latest state.
let writeInFlight = false;
let pendingWrite = false;

function saveStore(data: StoreData): void {
  if (writeInFlight) {
    // Another write is already in progress; mark that a new write is needed
    // so the current write flushes the latest state when it finishes.
    pendingWrite = true;
    return;
  }

  writeInFlight = true;
  try {
    writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("[store] Failed to persist delegations.json:", err);
  } finally {
    writeInFlight = false;
    if (pendingWrite) {
      pendingWrite = false;
      // Flush the latest in-memory state (not a stale snapshot)
      saveStore(store);
    }
  }
}

let store: StoreData = loadStore();
console.log(
  `[store] Loaded ${Object.keys(store.delegations).length} delegations, ` +
  `${Object.keys(store.subDelegations).length} sub-delegations from disk.`
);

// ── Public API ────────────────────────────────────────────────────────────────

export function storeDelegation(smartAccount: string, delegation: any): void {
  store.delegations[smartAccount.toLowerCase()] = delegation;
  saveStore(store);
}

export function getDelegation(smartAccount: string): any {
  return store.delegations[smartAccount.toLowerCase()] ?? null;
}

export function storeSubDelegation(smartAccount: string, delegation: any): void {
  store.subDelegations[smartAccount.toLowerCase()] = delegation;
  saveStore(store);
}

/**
 * Retrieves the sub-delegation for a given smart account.
 * Currently used internally; exported for future A2A chained delegation scenarios
 * where an orchestrator needs to inspect or extend an existing sub-delegation chain.
 * Do NOT remove — reserved for multi-hop agent architecture.
 */
export function getSubDelegation(smartAccount: string): any {
  return store.subDelegations[smartAccount.toLowerCase()] ?? null;
}

/** Remove all data for a smart account (called when user clicks "Revoke Delegation"). */
export function clearDelegation(smartAccount: string): void {
  const key = smartAccount.toLowerCase();
  delete store.delegations[key];
  delete store.subDelegations[key];
  saveStore(store);
  console.log(`[store] Cleared delegation for ${key}`);
}
