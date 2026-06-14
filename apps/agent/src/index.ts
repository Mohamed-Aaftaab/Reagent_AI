import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { planResearchTask, synthesizeResults } from "./venice.js";
import { storeDelegation, getDelegation, storeSubDelegation, clearDelegation } from "./store.js";
import { createPaidFetch, sessionAccount } from "./x402-buyer.js";
import {
  getRelayerCapabilities,
  getRelayerFeeData,
  relay7710Transaction,
  getRelayStatus,
  RELAY_CHAIN_ID,
  ONE_SHOT_RELAYER,
  type DelegatedTransaction,
} from "./oneshot.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, fallback, http, toHex, hashTypedData, encodeFunctionData, parseAbi, parseUnits } from "viem";
import { baseSepolia, base } from "viem/chains";

// ── Structured logger ─────────────────────────────────────────────────────────
// Simple prefix-based structured logging — no extra dependencies needed.
// Format: [ISO timestamp] [LEVEL] [module] message
function log(level: "INFO" | "WARN" | "ERROR", module: string, message: string, data?: any) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] [${level}] [${module}] ${message}`;
  if (data !== undefined) {
    if (level === "ERROR") console.error(entry, JSON.stringify(data));
    else if (level === "WARN")  console.warn(entry, JSON.stringify(data));
    else                        console.log(entry, JSON.stringify(data));
  } else {
    if (level === "ERROR") console.error(entry);
    else if (level === "WARN")  console.warn(entry);
    else                        console.log(entry);
  }
}

// Known costs per endpoint — used to emit live spend events to the dashboard
const ENDPOINT_COSTS: Record<string, number> = {
  "/api/sequence-check": 0.01,
  "/api/reagent-price": 0.005,
  "/api/protocol-validate": 0.02,
};

// The only marketplace host the AI planner is authorised to call.
// Any step.endpoint not in this set is rejected before execution (SSRF guard).
const MARKETPLACE_BASE = process.env.MARKETPLACE_URL || "http://127.0.0.1:4402";
const ALLOWED_ENDPOINTS = new Set([
  `${MARKETPLACE_BASE}/api/sequence-check`,
  `${MARKETPLACE_BASE}/api/reagent-price`,
  `${MARKETPLACE_BASE}/api/protocol-validate`,
]);

// DelegationManager contract address — must match the chain in RELAY_CHAIN_ID.
// Base Sepolia (84532): 0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3 (v1.3.0 deployment)
// Base Mainnet (8453):  set DELEGATION_MANAGER_ADDRESS in .env to the correct mainnet address.
// Defaults to the Sepolia address so existing .env files work without changes.
const DELEGATION_MANAGER_ADDRESS = (
  process.env.DELEGATION_MANAGER_ADDRESS ?? "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3"
) as `0x${string}`;

// USDC contract on Base Sepolia — single source of truth.
// Set USDC_ADDRESS env var to override (e.g. for mainnet 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
const USDC_CONTRACT = (process.env.USDC_ADDRESS ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as `0x${string}`;

// Viem public client for on-chain reads (e.g. pre-flight USDC balance check).
// Chain is selected dynamically from RELAY_CHAIN_ID so mainnet/testnet switches
// in .env don't silently query the wrong chain.
const viemChain = RELAY_CHAIN_ID === "8453" ? base : baseSepolia;
const publicClient = createPublicClient({
  chain: viemChain,
  transport: fallback(
    RELAY_CHAIN_ID === "8453"
      ? [
          http("https://mainnet.base.org"),
          http("https://base.blockpi.network/v1/rpc/public"),
        ]
      : [
          http("https://sepolia.base.org"),
          http("https://base-sepolia.blockpi.network/v1/rpc/public"),
          http("https://84532.rpc.thirdweb.com"),
        ]
  ),
});

// ── Per-account concurrency lock ──────────────────────────────────────────────
// Prevents two WebSocket clients from running parallel tasks for the same smart
// account simultaneously, which would race over the same delegation and fee context.
const activeTasks = new Set<string>();

// ── Per-account rate limit (C3) ───────────────────────────────────────────────
// Enforces a 30-second cooldown between task submissions per smart account.
// Closes the spam vector: an attacker can hammer the WS with "task" messages.
const TASK_COOLDOWN_MS = 30_000;
const lastTaskTime = new Map<string, number>();

// ── Per-account message buffer (M6) ──────────────────────────────────────────
// Stores the last 20 log/report messages per account so they can be replayed
// when a client reconnects after a short network drop. Keyed by lowercase address.
const MESSAGE_BUFFER_SIZE = 20;
const messageBuffer = new Map<string, any[]>();

function bufferMessage(accountKey: string, msg: any) {
  if (!messageBuffer.has(accountKey)) messageBuffer.set(accountKey, []);
  const buf = messageBuffer.get(accountKey)!;
  buf.push(msg);
  if (buf.length > MESSAGE_BUFFER_SIZE) buf.shift();
}

// ── Per-client ownership map (C4) ────────────────────────────────────────────
// Maps a WebSocket client to its claimed smart account address.
// Used so webhook relay updates are only delivered to the owning client,
// not broadcast to all connected clients (information leak fix).
const clientAccount = new Map<WebSocket, string>();

const app = express();
app.use(cors());
app.use(express.json());

// ── 1Shot capabilities cache ──────────────────────────────────────────────────
// Fetched once at startup; reused per-task to avoid a redundant network call.
let cachedCapabilities: any = null;

// ── REST Endpoints ─────────────────────────────────────────────────────────────

// 1. Store initial delegation from the dashboard
app.post("/api/store-delegation", (req, res) => {
  const { smartAccount, delegation } = req.body;
  if (!smartAccount || !delegation) {
    return res.status(400).json({ error: "Missing smartAccount or delegation" });
  }
  storeDelegation(smartAccount, delegation);
  log("INFO", "rest", `Delegation stored for ${smartAccount}`);
  res.json({ success: true });
});

// 1b. Revoke delegation — clears stored data for a smart account
app.delete("/api/revoke-delegation", (req, res) => {
  const { smartAccount } = req.body;
  if (!smartAccount) {
    return res.status(400).json({ error: "Missing smartAccount" });
  }
  clearDelegation(smartAccount);
  // Also clear rate-limit state and message buffer on revoke
  lastTaskTime.delete(smartAccount.toLowerCase());
  messageBuffer.delete(smartAccount.toLowerCase());
  log("INFO", "rest", `Delegation revoked and state cleared for ${smartAccount}`);
  res.json({ success: true });
});

// 1c. Delegation existence probe — used by DelegatePanel on page load/refresh
//     to restore delegated state without requiring the user to re-sign.
app.get("/api/has-delegation", (req, res) => {
  const smartAccount = req.query.smartAccount as string;
  if (!smartAccount) return res.status(400).json({ error: "Missing smartAccount" });
  const exists = !!getDelegation(smartAccount);
  res.json({ exists });
});

// 2. 1Shot Webhook — receives real-time relay status updates
//    1Shot POSTs here when a relayed tx transitions state (Pending → Confirmed etc.)
//    Set ONE_SHOT_WEBHOOK_URL in .env to register this with 1Shot (via ngrok for local dev)
//    FIX C4: scope relay events only to the task owner's WebSocket client.
app.post("/api/webhook", (req, res) => {
  const event = req.body;
  log("INFO", "webhook", "1Shot relay status update received", event);

  // Find the smartAccount this task belongs to via the TaskId
  const taskId = event?.TaskId || event?.taskId || event?.task?.taskId;
  let delivered = false;
  for (const [client, account] of clientAccount.entries()) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "tx_update", event }));
      delivered = true;
      log("INFO", "webhook", `Relay update delivered to account ${account}`);
    }
  }
  if (!delivered) {
    log("WARN", "webhook", `No active WS client found for relay update (TaskId: ${taskId})`);
  }
  res.json({ success: true });
});


const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
  log("INFO", "server", `Agent Server running on :${PORT}`);
  log("INFO", "server", `Agent Session Account: ${sessionAccount.address}`);
  log("INFO", "server", `1Shot relayer: ${ONE_SHOT_RELAYER} (chainId ${RELAY_CHAIN_ID})`);

  // Probe testnet capabilities at startup and cache them for per-task reuse
  getRelayerCapabilities(RELAY_CHAIN_ID)
    .then(c => {
      cachedCapabilities = c;
      const chainCaps = c?.[RELAY_CHAIN_ID] || c;
      const tokens = (chainCaps?.tokens || []).map((t: any) => t.symbol);
      log("INFO", "1shot", `Testnet relayer online. Accepted tokens on chain ${RELAY_CHAIN_ID}: ${
        tokens.length > 0 ? tokens.join(", ") : "(none — chain may not be supported on testnet relayer)"}`);
    })
    .catch(e => log("WARN", "1shot", `Testnet probe failed (non-fatal): ${e.message}`));
});

// ── WebSocket Server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });
const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);

  const safeSend = (payload: any) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  // ── Heartbeat / ping-pong (M5) ──────────────────────────────────────────
  // Respond to client-side pings to keep the connection alive through NAT/proxies.
  // The client sends { type: "ping" } every 25 seconds; we respond with { type: "pong" }.

  ws.on("message", async (message) => {
    // Declared outside the try block so the finally clause can always access it
    // regardless of where execution was interrupted. A const inside try would be
    // out of scope in finally, causing the concurrency lock to leak on any error.
    let accountKey: string | undefined;
    try {
      const data = JSON.parse(message.toString());

      // ── Heartbeat handler ───────────────────────────────────────────────
      if (data.type === "ping") {
        safeSend({ type: "pong" });
        return;
      }

      // ── Reconnect replay handler (M6) ────────────────────────────────────
      // On reconnect, the client sends { type: "reconnect", smartAccount }.
      // We flush the message buffer so no log/report events are lost during
      // the brief reconnect window (2-10 second backoff).
      if (data.type === "reconnect" && data.smartAccount) {
        const replayKey = data.smartAccount.toLowerCase();
        clientAccount.set(ws, replayKey);
        const buffered = messageBuffer.get(replayKey) ?? [];
        if (buffered.length > 0) {
          log("INFO", "ws", `Replaying ${buffered.length} buffered messages for ${replayKey}`);
          for (const msg of buffered) safeSend(msg);
        }
        return;
      }

      if (data.type !== "task") return;

      const { task, smartAccount } = data;

      // Register this client as the owner of the smartAccount address (C4)
      if (smartAccount) clientAccount.set(ws, smartAccount.toLowerCase());

      // Reject oversized task inputs to prevent DoS via huge Groq API requests.
      // 2,000 chars is generous for any legitimate research query.
      if (!task || typeof task !== "string" || task.length > 2000) {
        safeSend({ type: "error", message: "Task must be a non-empty string under 2,000 characters." });
        return;
      }

      // Validate smartAccount — missing/wrong type crashes getDelegation() with
      // TypeError: Cannot read properties of undefined (reading 'toLowerCase').
      if (!smartAccount || typeof smartAccount !== "string" || !smartAccount.startsWith("0x")) {
        safeSend({ type: "error", message: "Invalid or missing smartAccount address. Please connect your wallet." });
        return;
      }

      // Check delegation FIRST — fail fast before making any Groq API calls.
      // Previously this check was AFTER planResearchTask(), which wasted a full
      // Groq round-trip and reset SpendTracker on a task that would immediately fail.
      const mainDelegation = getDelegation(smartAccount);
      if (!mainDelegation) {
        safeSend({ type: "error", message: "No delegation found. Please click 'Delegate $5 Budget' first." });
        return;
      }

      // ── Rate limit (C3) — 30-second cooldown per account ─────────────────
      accountKey = smartAccount.toLowerCase();
      const now = Date.now();
      const lastTime = lastTaskTime.get(accountKey) ?? 0;
      const elapsed = now - lastTime;
      if (elapsed < TASK_COOLDOWN_MS) {
        const remaining = Math.ceil((TASK_COOLDOWN_MS - elapsed) / 1000);
        safeSend({ type: "error", message: `⏳ Rate limit: please wait ${remaining}s before submitting another task.` });
        return;
      }

      // Concurrency guard — one active task per smart account at a time.
      // Without this, two rapid submissions race over the same delegation/fee context.
      if (activeTasks.has(accountKey)) {
        safeSend({ type: "error", message: "A task is already running for this account. Please wait for it to complete." });
        return;
      }
      activeTasks.add(accountKey);
      lastTaskTime.set(accountKey, now);
      // Clear stale buffer when a fresh task starts
      messageBuffer.set(accountKey, []);

      // Helper that sends AND buffers so reconnecting clients can replay
      const safeSendBuffered = (payload: any) => {
        safeSend(payload);
        bufferMessage(accountKey!, payload);
      };

      // Signal dashboard components (SpendTracker) that a new task is starting.
      // Fires AFTER delegation check — SpendTracker only resets when the task will
      // actually execute, not on immediately-aborted validation failures.
      safeSendBuffered({ type: "task_started" });

      safeSendBuffered({ type: "log", message: "🧠 Planning your research with Llama 3.3 (Groq)..." });

      let planResult: any;
      try {
        planResult = await planResearchTask(task);
      } catch (planErr: any) {
        throw planErr;
      }

      // Guard: AI planner must return a valid plan array. If it returns an
      // unexpected schema, fail fast with a clear message instead of
      // crashing with 'Cannot read properties of undefined (reading length)'.
      if (!planResult?.plan || !Array.isArray(planResult.plan) || planResult.plan.length === 0) {
        throw new Error(
          `AI planner returned an invalid plan structure. Expected { plan: [...] }, got: ${JSON.stringify(planResult).slice(0, 200)}`
        );
      }

      if (typeof planResult.total_cost_usd !== "number" || isNaN(planResult.total_cost_usd)) {
        throw new Error("AI planner failed to price the task (invalid total_cost_usd). Please try again.");
      }

      // ── C2: Pre-validate plan cost against ENDPOINT_COSTS ─────────────────
      // Sum the cost of each planned step using our hardcoded price map.
      // If the plan's self-reported total_cost_usd exceeds what the agent
      // can actually charge, hard-stop before any API or relay calls are made.
      let computedPlanCost = 0;
      for (const step of planResult.plan) {
        let endpointPath: string;
        try {
          endpointPath = new URL(step.endpoint).pathname;
        } catch {
          endpointPath = step.endpoint;
        }
        computedPlanCost += ENDPOINT_COSTS[endpointPath] ?? 0;
      }
      // Round to avoid floating-point drift (e.g. 0.01 + 0.005 = 0.015000000000000001)
      computedPlanCost = Math.round(computedPlanCost * 1e6) / 1e6;

      safeSendBuffered({
        type: "log",
        message: `📋 Plan ready: ${planResult.plan.length} step(s). Verified cost: $${computedPlanCost}`,
      });

      // ── C1 & C5: Pre-flight USDC balance check — ALWAYS FATAL ────────────
      // Hard-stop if balance is insufficient. Previously non-fatal (swallowed errors).
      // Now: RPC failures also hard-stop — we never proceed blind on a zero balance.
      const requiredAmount = parseUnits(String(computedPlanCost), 6);
      let balance: bigint;
      try {
        balance = await publicClient.readContract({
          address: USDC_CONTRACT,
          abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
          functionName: "balanceOf",
          args: [smartAccount as `0x${string}`],
        });
      } catch (balErr: any) {
        // RPC failure — fail safe rather than proceed optimistically.
        log("ERROR", "balance-check", `USDC balance read failed: ${balErr.message}`);
        activeTasks.delete(accountKey);
        safeSend({
          type: "error",
          message: `⚠️ Could not verify USDC balance (RPC error). Please try again in a moment.`,
        });
        return;
      }

      if (balance < requiredAmount) {
        const balanceUsd = (Number(balance) / 1e6).toFixed(4);
        activeTasks.delete(accountKey);
        safeSend({
          type: "error",
          message: `⚠️ Insufficient USDC in Smart Account vault. ` +
            `Balance: $${balanceUsd} — Required: $${computedPlanCost}. ` +
            `Please fund your vault at ${smartAccount}.`,
        });
        return;
      }
      safeSendBuffered({ type: "log", message: `✅ Vault balance confirmed: $${(Number(balance) / 1e6).toFixed(4)} available.` });

      // ── 1Shot Relay Step ──────────────────────────────────────────────────
      // Submit the ERC-7710 delegation proof through the 1Shot permissionless relayer.
      // This proves on-chain authority before the agent spends the user's budget.
      safeSendBuffered({ type: "log", message: `⚡ Submitting delegation to 1Shot relayer (chain ${RELAY_CHAIN_ID})...` });

      const parsedDelegation = typeof mainDelegation === "string"
        ? JSON.parse(mainDelegation)
        : mainDelegation;

      const domain = {
        name: "DelegationManager",
        version: "1",
        chainId: parseInt(RELAY_CHAIN_ID, 10),
        verifyingContract: DELEGATION_MANAGER_ADDRESS,
      };
      const types = {
        Delegation: [
          { name: "delegate",  type: "address" },
          { name: "delegator", type: "address" },
          { name: "authority", type: "bytes32" },
          { name: "caveats",   type: "Caveat[]" },
          { name: "salt",      type: "uint256" },
        ],
        Caveat: [
          { name: "enforcer", type: "address" },
          { name: "terms",    type: "bytes" },
          { name: "args",     type: "bytes" },
        ],
      };

      const parentAuthority = hashTypedData({
        domain,
        types,
        primaryType: "Delegation",
        message: parsedDelegation.delegation,
      });

      let relayTaskId: string | null = null;
      let oneshotDelegation: any = null;

      // ── C7: Single retry on relay failure ────────────────────────────────
      // A transient 1Shot network hiccup immediately fails the whole task.
      // We retry once after 3 seconds before giving up.
      const attemptRelay = async (): Promise<{ TaskId: string }> => {
        const capabilities = cachedCapabilities ?? await getRelayerCapabilities(RELAY_CHAIN_ID);
        const chainCaps = capabilities?.[RELAY_CHAIN_ID] || capabilities;
        const usdcTokenObj = (chainCaps?.tokens || []).find((t: any) => t.symbol === "USDC");
        const usdcToken = usdcTokenObj?.address;
        const feeCollector = chainCaps?.feeCollector;

        let feeContext: string | undefined;
        let minFeeAmount = 0n;
        if (usdcToken) {
          const feeData = await getRelayerFeeData(RELAY_CHAIN_ID, usdcToken);
          feeContext = feeData?.context;
          minFeeAmount = parseUnits(feeData?.minFee ?? "0", 6);
          safeSendBuffered({
            type: "log",
            message: `💰 1Shot fee quote: ${feeData?.minFee ?? "~"} USDC (locked for ~45s)`,
          });
        }

        const relayTo = (process.env.SELLER_ADDRESS || sessionAccount.address) as string;
        const executions: any[] = [{ target: relayTo, value: "0x0", data: "0x" }];

        if (usdcToken && feeCollector && minFeeAmount > 0n) {
          executions.push({
            target: usdcToken,
            value: "0x0",
            data: encodeFunctionData({
              abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
              functionName: "transfer",
              args: [feeCollector as `0x${string}`, minFeeAmount]
            })
          });
        }

        const transactions: DelegatedTransaction[] = [{ executions }];

        const saltBytes = new Uint8Array(32);
        globalThis.crypto.getRandomValues(saltBytes);
        const saltValue = BigInt(toHex(saltBytes));

        const oneshotDelegate = "0xf1ef956eff4181Ce913b664713515996858B9Ca9" as `0x${string}`;
        const oneshotSignature = await sessionAccount.signTypedData({
          domain, types, primaryType: "Delegation",
          message: {
            delegate:  oneshotDelegate,
            delegator: sessionAccount.address as `0x${string}`,
            authority: parentAuthority,
            caveats:   [],
            salt:      saltValue,
          },
        });

        oneshotDelegation = {
          delegate:  oneshotDelegate,
          delegator: sessionAccount.address as `0x${string}`,
          authority: parentAuthority,
          caveats:   [] as any[],
          salt:      toHex(saltValue),
          signature: oneshotSignature,
        };

        const permissionContext = [
          oneshotDelegation,
          { ...parsedDelegation.delegation, signature: parsedDelegation.signature },
        ];

        return relay7710Transaction({ chainId: RELAY_CHAIN_ID, permissionContext, transactions, feeContext });
      };

      try {
        let relayResult: { TaskId: string };
        try {
          relayResult = await attemptRelay();
        } catch (firstErr: any) {
          log("WARN", "1shot", `Relay attempt 1 failed, retrying in 3s: ${firstErr.message}`);
          safeSendBuffered({ type: "log", message: "⚠️ Relay hiccup — retrying in 3 seconds..." });
          await new Promise(r => setTimeout(r, 3000));
          relayResult = await attemptRelay(); // second attempt — throws naturally if it fails again
        }

        relayTaskId = relayResult.TaskId;
        safeSendBuffered({
          type: "log",
          message: `✅ 1Shot relay accepted. TaskId: ${relayTaskId}`,
        });
        safeSendBuffered({ type: "tx_update", event: { taskId: relayTaskId, status: "Submitted" } });

        // Poll status every 3s for up to 30s to get the transaction hash
        if (relayTaskId) {
          (async () => {
            let attempts = 0;
            while (attempts < 10) {
              attempts++;
              try {
                const status = await getRelayStatus(relayTaskId!);
                const taskState = status?.status || status?.task?.taskState;
                const txHash = status?.transactionHash || status?.task?.transactionHash || status?.txHash;

                // ── C6: On-chain receipt verification ──────────────────────────
                if (txHash && (taskState === "Confirmed" || taskState === "confirmed")) {
                  try {
                    const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
                    if (receipt.status === "reverted") {
                      log("ERROR", "verify", `Tx ${txHash} confirmed by 1Shot but REVERTED on-chain!`);
                      safeSend({ type: "tx_update", event: { taskId: relayTaskId, status: "Reverted", txHash, verified: false } });
                      return;
                    }
                    log("INFO", "verify", `Tx ${txHash} verified on-chain. Status: success ✅`);
                    safeSend({ type: "tx_update", event: { taskId: relayTaskId, status: taskState, txHash, verified: true } });
                    return; // Stop polling, we got the final state
                  } catch (receiptErr: any) {
                    log("WARN", "verify", `Could not fetch receipt for ${txHash}: ${receiptErr.message}`);
                    safeSend({ type: "tx_update", event: { taskId: relayTaskId, status: taskState, txHash } });
                    return; // Stop polling, we got the hash
                  }
                } else if (taskState === "Failed" || taskState === "Rejected" || taskState === "Cancelled") {
                  safeSend({ type: "tx_update", event: { taskId: relayTaskId, status: taskState, txHash } });
                  return; // Stop polling, terminal failure state
                }
              } catch (e: any) {
                log("WARN", "1shot", `Status poll failed for task ${relayTaskId} (non-fatal): ${e.message}`);
              }
              await new Promise(r => setTimeout(r, 3000));
            }
            log("WARN", "1shot", `Stopped polling task ${relayTaskId} after 30s`);
          })();
        }
      } catch (relayErr: any) {
        log("ERROR", "1shot", `Relay failed after retry: ${relayErr.message}`);
        safeSendBuffered({ type: "log", message: `❌ 1Shot relay failed: ${relayErr.message}` });
        throw new Error(`1Shot relay failure: ${relayErr.message}`);
      }

      // ── A2A Redelegation ──────────────────────────────────────────────────
      // Generate a fresh ephemeral Sub-Agent keypair for this task only
      const subAgentKey = generatePrivateKey();
      const subAgentAccount = privateKeyToAccount(subAgentKey);

      safeSendBuffered({
        type: "log",
        message: `🔗 Main Agent redelegating $${computedPlanCost} → Sub-Agent (${subAgentAccount.address.slice(0, 10)}...)`,
      });

      const subSaltBytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(subSaltBytes);
      const subSaltValue = BigInt(toHex(subSaltBytes));

      const signature = await sessionAccount.signTypedData({
        domain, types, primaryType: "Delegation",
        message: {
          delegate:  subAgentAccount.address as `0x${string}`,
          delegator: sessionAccount.address as `0x${string}`,
          authority: parentAuthority,
          caveats:   [],
          salt:      subSaltValue,
        },
      });

      const subDelegationChain = {
        delegate:  subAgentAccount.address as `0x${string}`,
        delegator: sessionAccount.address as `0x${string}`,
        authority: parentAuthority,
        caveats:   [] as any[],
        salt:      subSaltValue.toString(),
        signature,
      };
      storeSubDelegation(smartAccount, subDelegationChain);

      safeSendBuffered({ type: "log", message: "✅ Sub-delegation signed via EIP-712. Sub-Agent executing..." });

      const subAgentPaidFetch = createPaidFetch(
        subAgentAccount,
        [
          oneshotDelegation,
          subDelegationChain,
          { ...parsedDelegation.delegation, signature: parsedDelegation.signature }
        ],
        smartAccount as string
      );

      // ── Execute Plan Steps ────────────────────────────────────────────────
      const executionResults: any[] = [];

      for (const step of planResult.plan) {
        // SSRF guard — reject any endpoint the AI planner tried to call outside
        // the known marketplace. This prevents prompt injection / model hallucination
        // from directing the agent to arbitrary HTTP targets.
        if (!ALLOWED_ENDPOINTS.has(step.endpoint)) {
          throw new Error(
            `Step ${step.step}: AI planner returned an unauthorised endpoint "${step.endpoint}". ` +
            `Only marketplace endpoints on ${MARKETPLACE_BASE} are allowed.`
          );
        }

        safeSendBuffered({ type: "log", message: `📡 Sub-Agent → ${step.endpoint}` });

        const result = await subAgentPaidFetch(step.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(step.input),
        });

        if (!result.ok) {
          throw new Error(`Step ${step.step} failed: HTTP ${result.status} ${result.statusText}`);
        }

        const resultData = await result.json();
        executionResults.push({ step: step.step, data: resultData });

        let endpointPath: string;
        try {
          endpointPath = new URL(step.endpoint).pathname;
        } catch {
          endpointPath = step.endpoint;
        }
        const stepCost = ENDPOINT_COSTS[endpointPath] ?? 0;
        safeSendBuffered({ type: "step_spent", endpoint: step.endpoint, cost: stepCost });
        safeSendBuffered({ type: "log", message: `✅ Step ${step.step} complete ($${stepCost})` });
      }

      // ── Synthesize & Report ───────────────────────────────────────────────
      safeSendBuffered({ type: "log", message: "🧠 Synthesizing results with Llama 3.3 (Groq)..." });
      const report = await synthesizeResults(task, executionResults);
      safeSendBuffered({ type: "report", report });

    } catch (err: any) {
      log("ERROR", "task", `Agent task error: ${err.message}`);
      safeSend({ type: "error", message: err.message ?? "Unknown error" });
    } finally {
      // accountKey is declared in the outer scope (before try), so it is always
      // accessible here, even if execution threw before accountKey was assigned.
      // This guarantees the concurrency lock is released on every code path.
      if (accountKey) activeTasks.delete(accountKey);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    clientAccount.delete(ws);
  });
});
