/**
 * 1Shot Public Relayer client — explicit ERC-7710 transaction relay.
 *
 * The 1Shot permissionless relayer requires no API key.
 * It accepts JSON-RPC calls and relays ERC-7710 delegation-based transactions
 * with gas paid in stablecoins (USDC/USDT/USDG).
 *
 * Docs: https://1shotapi.com/docs/quickstarts/gas-sponsorship-eip7710
 *
 * Endpoints:
 *   Mainnet  → https://relayer.1shotapi.com/relayers
 *   Testnet  → https://relayer.1shotapi.dev/relayers   ← Base Sepolia (84532)
 */

// Testnet relayer — matches our Smart Account chain (Base Sepolia, chainId 84532).
// When the project moves to mainnet, swap to https://relayer.1shotapi.com/relayers
// and change RELAY_CHAIN_ID to "8453".
const ONE_SHOT_RELAYER_TESTNET = "https://relayer.1shotapi.dev/relayers";
const ONE_SHOT_RELAYER_MAINNET = "https://relayer.1shotapi.com/relayers";

export const RELAY_CHAIN_ID = process.env.RELAY_CHAIN_ID || "84532"; // Base Sepolia
export const ONE_SHOT_RELAYER =
  RELAY_CHAIN_ID === "8453" ? ONE_SHOT_RELAYER_MAINNET : ONE_SHOT_RELAYER_TESTNET;

// Webhook URL for push status updates — must be publicly reachable.
const WEBHOOK_URL = process.env.ONE_SHOT_WEBHOOK_URL || "";

// Timeout constants — prevents hanging the WS task handler for 2+ minutes
// when the 1Shot relayer is unreachable (OS-level TCP timeout is ~2 min).
const RELAY_TIMEOUT_MS  = 30_000; // relay submission: extra time for mempool propagation
const STATUS_TIMEOUT_MS = 15_000; // capabilities / fee / status: should be fast

/**
 * fetch() wrapper that aborts after timeoutMs milliseconds.
 * Throws: AbortError (if timed out) or TypeError (if fetch itself fails).
 * Both are caught by the callers' try/catch and treated as non-fatal 1Shot failures.
 */
function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(
    () => clearTimeout(timer)
  );
}

/**
 * Fetch 1Shot relayer capabilities for the configured chain.
 * Returns accepted payment tokens and the relayer targetAddress
 * (the address your delegation must grant permission to).
 */
export async function getRelayerCapabilities(chainId: string = RELAY_CHAIN_ID) {
  const res = await fetchWithTimeout(ONE_SHOT_RELAYER, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "relayer_getCapabilities",
      params: [chainId],
    }),
  }, STATUS_TIMEOUT_MS);
  const json = await res.json() as any;
  if (json.error) throw new Error(`1Shot getCapabilities error: ${json.error.message}`);
  return json.result;
}

/**
 * Fetch the current gas fee quote for a given payment token.
 * Returns: { gasPrice, rate, minFee, expiry, context }
 * Pass `context` back in send to lock the quoted price (~45 second window).
 */
export async function getRelayerFeeData(chainId: string, paymentToken: string) {
  const res = await fetchWithTimeout(ONE_SHOT_RELAYER, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "relayer_getFeeData",
      // JSON-RPC 2.0 with named parameters uses an object.
      params: { chainId, token: paymentToken },
    }),
  }, STATUS_TIMEOUT_MS);
  const json = await res.json() as any;
  if (json.error) throw new Error(`1Shot getFeeData error: ${json.error.message}`);
  return json.result;
}

/**
 * Submit a 7710-delegated transaction through the 1Shot public relayer.
 *
 * For MetaMask browser flow (EIP-7715): do NOT include authorizationList —
 * MetaMask handles the EIP-7702 account upgrade internally.
 *
 * transactions must contain at least one encoded call. A zero-value ETH
 * transfer ({ to, value: "0x0", data: "0x" }) is valid as a minimal proof.
 *
 * @returns { TaskId: string } — track status via webhook or relayer_getStatus
 */
export interface Execution {
  target: string;
  value: string;
  data: string;
}

export interface DelegatedTransaction {
  executions: Execution[];
}

/**
 * Submit a 7710-delegated transaction through the 1Shot public relayer.
 *
 * @param permissionContext - Array of signed delegation objects forming the chain
 *                            (leaf first: 1Shot delegate → sub-agent → main-agent → smart-account)
 * @param transactions      - Array of transaction batches, each with an executions array
 * @param feeContext        - Optional locked fee quote context from relayer_getFeeData
 */
export async function relay7710Transaction({
  chainId = RELAY_CHAIN_ID,
  permissionContext,
  transactions,
  feeContext,
}: {
  chainId?: string;
  permissionContext: any[];             // Array of signed delegation objects
  transactions: DelegatedTransaction[]; // Each item has executions[]
  feeContext?: string;
}): Promise<{ TaskId: string }> {
  if (transactions.length === 0) {
    throw new Error("relay7710Transaction: transactions array must not be empty. Include at least one encoded call.");
  }

  const params: any = {
    chainId,
    // Each transaction batch gets the full permission context attached.
    // 1Shot expects: [{ executions: [...], permissionContext: [...] }]
    transactions: transactions.map((tx) => ({
      executions: tx.executions,
      permissionContext,
    })),
    ...(feeContext ? { context: feeContext } : {}),
    ...(WEBHOOK_URL ? { destinationUrl: WEBHOOK_URL } : {}),
    memo: "Reagent A2A delegation relay — ERC-7710",
  };

  console.log("1Shot relayer_send7710Transaction params:", JSON.stringify(params, null, 2));

  const res = await fetchWithTimeout(ONE_SHOT_RELAYER, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "relayer_send7710Transaction",
      params,
    }),
  }, RELAY_TIMEOUT_MS);
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`1Shot returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (json.error) {
    console.error("1Shot JSON-RPC Error Payload:", JSON.stringify(json.error, null, 2));
    throw new Error(`1Shot relay error: ${json.error.message}. Details: ${JSON.stringify(json.error.data || json.error)}`);
  }
  if (!json.result) {
    throw new Error(`1Shot relay returned no result. Response: ${JSON.stringify(json).slice(0, 200)}`);
  }
  const TaskId = typeof json.result === "string" ? json.result : json.result.TaskId;
  if (!TaskId) {
    throw new Error(`1Shot relay returned no TaskId. Response: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return { TaskId };
}

/**
 * Poll a relay task until terminal state.
 * Terminal states: Confirmed, Failed, Rejected, Cancelled.
 */
export async function getRelayStatus(taskId: string) {
  const res = await fetchWithTimeout(ONE_SHOT_RELAYER, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "relayer_getStatus",
      // 1Shot expects params as an array: [taskId]
      params: [taskId],
    }),
  }, STATUS_TIMEOUT_MS);
  const json = await res.json() as any;
  if (json.error) throw new Error(`1Shot getStatus error: ${json.error.message}`);
  return json.result;
}

/**
 * C7 — Single retry wrapper for relay7710Transaction.
 * Waits retryDelayMs before the second attempt.
 * Callers can catch the final error and surface it to the user.
 */
export async function relay7710TransactionWithRetry(
  params: Parameters<typeof relay7710Transaction>[0],
  retryDelayMs = 3000
): Promise<{ TaskId: string }> {
  try {
    return await relay7710Transaction(params);
  } catch (firstErr: any) {
    console.warn(`[1Shot] First relay attempt failed (${firstErr.message}). Retrying in ${retryDelayMs}ms...`);
    await new Promise(r => setTimeout(r, retryDelayMs));
    return relay7710Transaction(params); // second attempt — throws naturally on failure
  }
}
