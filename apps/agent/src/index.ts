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

// Known costs per endpoint — used to emit live spend events to the dashboard
const ENDPOINT_COSTS: Record<string, number> = {
  "/api/sequence-check": 0.01,
  "/api/reagent-price": 0.005,
  "/api/protocol-validate": 0.02,
};

// The only marketplace host the AI planner is authorised to call.
// Any step.endpoint not in this set is rejected before execution (SSRF guard).
const MARKETPLACE_BASE = "http://127.0.0.1:4402";
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

// Per-account concurrency lock.
// Prevents two WebSocket clients from running parallel tasks for the same smart
// account simultaneously, which would race over the same delegation and fee context.
const activeTasks = new Set<string>();

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
  res.json({ success: true });
});

// 1b. Revoke delegation — clears stored data for a smart account
app.delete("/api/revoke-delegation", (req, res) => {
  const { smartAccount } = req.body;
  if (!smartAccount) {
    return res.status(400).json({ error: "Missing smartAccount" });
  }
  clearDelegation(smartAccount);
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
app.post("/api/webhook", (req, res) => {
  const event = req.body;
  console.log("[1Shot Webhook] Relay status update:", JSON.stringify(event, null, 2));
  broadcast({ type: "tx_update", event });
  res.json({ success: true });
});



const server = app.listen(4000, () => {
  console.log("Agent Server running on :4000");
  console.log("Agent Session Account:", sessionAccount.address);
  console.log(`[1Shot] Using relayer: ${ONE_SHOT_RELAYER} (chainId ${RELAY_CHAIN_ID})`);

  // Probe testnet capabilities at startup and cache them for per-task reuse
  getRelayerCapabilities(RELAY_CHAIN_ID)
    .then(c => {
      cachedCapabilities = c;
      const chainCaps = c?.[RELAY_CHAIN_ID] || c;
      const tokens = (chainCaps?.tokens || []).map((t: any) => t.symbol);
      console.log(`[1Shot] Testnet relayer online. Accepted tokens on chain ${RELAY_CHAIN_ID}:`,
        tokens.length > 0 ? tokens.join(", ") : "(none — chain may not be supported on testnet relayer)");
    })
    .catch(e => console.warn("[1Shot] Testnet probe failed (non-fatal):", e.message));
});

// ── WebSocket Server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });
const clients = new Set<WebSocket>();

function broadcast(msg: any) {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(msg));
    }
  }
}

wss.on("connection", (ws) => {
  clients.add(ws);

  const safeSend = (payload: any) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  ws.on("message", async (message) => {
    // Declared outside the try block so the finally clause can always access it
    // regardless of where execution was interrupted. A const inside try would be
    // out of scope in finally, causing the concurrency lock to leak on any error.
    let accountKey: string | undefined;
    try {
      const data = JSON.parse(message.toString());
      if (data.type !== "task") return;

      const { task, smartAccount } = data;

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

      // Concurrency guard — one active task per smart account at a time.
      // Without this, two rapid submissions race over the same delegation/fee context.
      accountKey = smartAccount.toLowerCase();
      if (activeTasks.has(accountKey)) {
        safeSend({ type: "error", message: "A task is already running for this account. Please wait for it to complete." });
        return;
      }
      activeTasks.add(accountKey);

      // Signal dashboard components (SpendTracker) that a new task is starting.
      // Fires AFTER delegation check — SpendTracker only resets when the task will
      // actually execute, not on immediately-aborted validation failures.
      safeSend({ type: "task_started" });

      safeSend({ type: "log", message: "🧠 Planning your research with Llama 3.3 (Groq)..." });

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

      safeSend({
        type: "log",
        message: `📋 Plan ready: ${planResult.plan.length} step(s). Budget: $${planResult.total_cost_usd}`,
      });

      // ── Pre-flight USDC balance check ────────────────────────────────────
      // Checks the Smart Account vault has enough USDC to cover the planned spend.
      // Fails fast before the 1Shot relay fee is paid and any Groq calls are made.
      try {
        const requiredAmount = parseUnits(String(planResult.total_cost_usd ?? "0"), 6);
        const balance = await publicClient.readContract({
          address: USDC_CONTRACT,
          abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
          functionName: "balanceOf",
          args: [smartAccount as `0x${string}`],
        });
        if (balance < requiredAmount) {
          const balanceUsd = (Number(balance) / 1e6).toFixed(4);
          activeTasks.delete(accountKey);
          safeSend({
            type: "error",
            message: `⚠️ Insufficient USDC in Smart Account vault. ` +
              `Balance: $${balanceUsd} — Required: $${planResult.total_cost_usd}. ` +
              `Please fund your vault at ${smartAccount}.`,
          });
          return;
        }
        safeSend({ type: "log", message: `✅ Vault balance confirmed: sufficient USDC available.` });
      } catch (balErr: any) {
        // Non-fatal — RPC may be flaky; proceed optimistically and let the on-chain tx fail naturally.
        console.warn("[balance-check] Could not verify USDC balance (non-fatal):", balErr.message);
      }

      // ── 1Shot Relay Step ──────────────────────────────────────────────────
      // Submit the ERC-7710 delegation proof through the 1Shot permissionless relayer.
      // This proves on-chain authority before the agent spends the user's budget.
      // Uses the TESTNET relayer (relayer.1shotapi.dev) which matches the
      // Smart Account's signing domain (Base Sepolia, chainId 84532).
      safeSend({ type: "log", message: `⚡ Submitting delegation to 1Shot relayer (chain ${RELAY_CHAIN_ID})...` });

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
      try {
        // Use startup-cached capabilities; fall back to a fresh fetch if not ready yet
        const capabilities = cachedCapabilities ?? await getRelayerCapabilities(RELAY_CHAIN_ID);

        // Find a USDC token address from capabilities (accepted stablecoin for gas payment)
        const chainCaps = capabilities?.[RELAY_CHAIN_ID] || capabilities;
        const usdcTokenObj = (chainCaps?.tokens || []).find((t: any) => t.symbol === "USDC");
        const usdcToken = usdcTokenObj?.address;
        const feeCollector = chainCaps?.feeCollector;

        // Lock a fee quote if USDC is available on this chain
        let feeContext: string | undefined;
        let minFeeAmount = 0n;
        if (usdcToken) {
          const feeData = await getRelayerFeeData(RELAY_CHAIN_ID, usdcToken);
          feeContext = feeData?.context;
          minFeeAmount = parseUnits(feeData?.minFee ?? "0", 6);
          safeSend({
            type: "log",
            message: `💰 1Shot fee quote: ${feeData?.minFee ?? "~"} USDC (locked for ~45s)`,
          });
        }

        // Build a minimal but VALID transaction payload.
        // A zero-value ETH transfer to the seller address is always accepted.
        const relayTo = (process.env.SELLER_ADDRESS || sessionAccount.address) as string;
        const executions: any[] = [
          {
            target: relayTo,
            value: "0x0",
            data: "0x",
          }
        ];

        // 1Shot Relayer strictly validates that the transaction array contains
        // an ERC20 transfer of the exact fee quote to the relayer's feeCollector.
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

        // Compute a cryptographically random salt
        const saltBytes = new Uint8Array(32);
        globalThis.crypto.getRandomValues(saltBytes);
        const saltValue = BigInt(toHex(saltBytes));

        // Create delegation to 1Shot Relayer
        const oneshotDelegate = "0xf1ef956eff4181Ce913b664713515996858B9Ca9" as `0x${string}`;
        const oneshotSignature = await sessionAccount.signTypedData({
          domain,
          types,
          primaryType: "Delegation",
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

        // The 1Shot API expects the first item in the array to be the leaf delegation targeting the 1Shot wallet
        // Followed by the parent delegations up the tree
        const permissionContext = [
          oneshotDelegation,
          {
            ...parsedDelegation.delegation,
            signature: parsedDelegation.signature,
          }
        ];

        const relayResult = await relay7710Transaction({
          chainId: RELAY_CHAIN_ID,
          permissionContext,
          transactions,
          feeContext,
        });

        relayTaskId = relayResult.TaskId;
        safeSend({
          type: "log",
          message: `✅ 1Shot relay accepted. TaskId: ${relayTaskId}`,
        });
        // Emit tx_update so the dashboard renders a clickable Basescan link
        // (AgentChat renders all tx_update events with "View on Basescan ↗️").
        // Use safeSend (not broadcast) — relay status belongs to THIS client's task only.
        safeSend({ type: "tx_update", event: { taskId: relayTaskId, status: "Submitted" } });

        // Poll status once after 3 s (non-blocking; webhook delivers real-time updates)
        if (relayTaskId) {
          setTimeout(async () => {
            try {
              const status = await getRelayStatus(relayTaskId!);
              console.log(`[1Shot] Task ${relayTaskId} status:`, status?.status || status?.task?.taskState);
              // Extract the actual blockchain transaction hash if the relayer provides it
              const txHash = status?.transactionHash || status?.task?.transactionHash || status?.txHash;
              // Again: safeSend not broadcast — per-task relay status
              safeSend({ type: "tx_update", event: { taskId: relayTaskId, status: status?.status || status?.task?.taskState, txHash } });
            } catch (e: any) {
              console.warn(`[1Shot] Status poll failed for task ${relayTaskId} (non-fatal):`, e.message);
            }
          }, 3000);
        }
      } catch (relayErr: any) {
        // FATAL — Real mode enabled: 1Shot relay failure blocks the x402 demo flow.
        console.error("[1Shot] Relay attempt failed (FATAL):", relayErr.message);
        safeSend({
          type: "log",
          message: `❌ 1Shot relay failed: ${relayErr.message}`,
        });
        throw new Error(`1Shot relay failure: ${relayErr.message}`);
      }

      // ── A2A Redelegation ──────────────────────────────────────────────────
      // Generate a fresh ephemeral Sub-Agent keypair for this task only
      const subAgentKey = generatePrivateKey();
      const subAgentAccount = privateKeyToAccount(subAgentKey);

      safeSend({
        type: "log",
        message: `🔗 Main Agent redelegating $${planResult.total_cost_usd} → Sub-Agent (${subAgentAccount.address.slice(0, 10)}...)`,
      });

      // Compute a cryptographically random salt for the Sub-Agent
      const subSaltBytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(subSaltBytes);
      const subSaltValue = BigInt(toHex(subSaltBytes));

      const signature = await sessionAccount.signTypedData({
        domain,
        types,
        primaryType: "Delegation",
        message: {
          delegate:  subAgentAccount.address as `0x${string}`,
          delegator: sessionAccount.address as `0x${string}`,
          authority: parentAuthority,
          caveats:   [],
          salt:      subSaltValue,
        },
      });

      // Build the clean sub-delegation object — 5 canonical ERC-7715 fields + signature.
      // salt stored as string (JSON cannot represent 256-bit BigInt natively).
      // No extra fields (parentDelegation, limit, etc.) that would confuse verifiers.
      const subDelegationChain = {
        delegate:  subAgentAccount.address as `0x${string}`,
        delegator: sessionAccount.address as `0x${string}`,
        authority: parentAuthority,
        caveats:   [] as any[],
        salt:      subSaltValue.toString(),   // string is the canonical JSON representation of uint256
        signature,
      };
      storeSubDelegation(smartAccount, subDelegationChain);

      safeSend({ type: "log", message: "✅ Sub-delegation signed via EIP-712. Sub-Agent executing..." });

      // Pass the FULL chain: [oneshotDelegation, subDelegation, parsedDelegation].
      // This gives the marketplace the ability to use 1Shot to settle!
      const subAgentPaidFetch = createPaidFetch(
        subAgentAccount,
        [
          oneshotDelegation,
          subDelegationChain,
          {
            ...parsedDelegation.delegation,
            signature: parsedDelegation.signature,
          }
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

        safeSend({ type: "log", message: `📡 Sub-Agent → ${step.endpoint}` });

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

        // Use URL.pathname instead of string replace — handles any variation of
        // host/port the AI might return (127.0.0.1, different port, etc.).
        let endpointPath: string;
        try {
          endpointPath = new URL(step.endpoint).pathname;
        } catch {
          endpointPath = step.endpoint; // fallback if URL parsing fails
        }
        const stepCost = ENDPOINT_COSTS[endpointPath] ?? 0;
        safeSend({ type: "step_spent", endpoint: step.endpoint, cost: stepCost });
        safeSend({ type: "log", message: `✅ Step ${step.step} complete ($${stepCost})` });
      }

      // ── Synthesize & Report ───────────────────────────────────────────────
      safeSend({ type: "log", message: "🧠 Synthesizing results with Llama 3.3 (Groq)..." });
      const report = await synthesizeResults(task, executionResults);
      safeSend({ type: "report", report });

    } catch (err: any) {
      console.error("Agent task error:", err);
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
  });
});
