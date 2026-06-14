import express from "express";
import cors from "cors";
import { paymentMiddleware } from "@x402/express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { Erc7710ExactEvmScheme } from "./scheme.js";
import { encodeFunctionData, parseAbi } from "viem";

import { sequenceCheckHandler } from "./endpoints/sequence-check.js";
import { reagentPriceHandler } from "./endpoints/reagent-price.js";
import { protocolValidateHandler } from "./endpoints/protocol-validate.js";

// Network string for x402 payment requirements.
// Defaults to Base Sepolia — set PAYMENT_NETWORK="eip155:8453" in .env for mainnet.
const NETWORK = process.env.PAYMENT_NETWORK ?? "eip155:84532";
const PAY_TO = process.env.SELLER_ADDRESS || "0x0000000000000000000000000000000000000000";
if (!process.env.SELLER_ADDRESS) {
  console.warn("\u26a0\ufe0f  WARNING: SELLER_ADDRESS is not set. All x402 payments will be sent to the zero address (burned). Set SELLER_ADDRESS in apps/marketplace/.env");
}
const FACILITATOR_URL = "https://tx-sentinel-base-sepolia.dev-api.cx.metamask.io/platform/v2/x402";

// ── Chain / token config — env-var driven (M1, M2) ───────────────────────────
// RELAY_CHAIN_ID drives which 1Shot relayer URL and chain params are used.
// For mainnet: set RELAY_CHAIN_ID=8453 and USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
const RELAY_CHAIN_ID = process.env.RELAY_CHAIN_ID ?? "84532";
const ONE_SHOT_RELAYER_URL = RELAY_CHAIN_ID === "8453"
  ? "https://relayer.1shotapi.com/relayers"
  : "https://relayer.1shotapi.dev/relayers";

// USDC contract address — env-var driven, defaults to Base Sepolia.
const USDC_BASE_SEPOLIA = (
  process.env.USDC_ADDRESS ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
);

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const app = express();

// ── IP Rate Limiter helpers (M4) ──────────────────────────────────────────────
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const ipRequestCounts = new Map<string, { count: number; resetAt: number }>();

function getRealIp(req: any): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return (forwarded as string).split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = ipRequestCounts.get(ip);
  if (!entry || now > entry.resetAt) {
    ipRequestCounts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

// ── Idempotency Key Cache (M3) ────────────────────────────────────────────────
const IDEMPOTENCY_TTL_MS = 5 * 60_000;
const idempotencyCache = new Map<string, { status: number; body: any; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of idempotencyCache.entries()) {
    if (now > entry.expiresAt) idempotencyCache.delete(key);
  }
}, 60_000);

app.use(cors({ 
  exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"],
  origin: "*"
}));
app.use(express.json());

// ── Rate limit middleware (M4) ───────────────────────────────────────────────
app.use((req, res, next) => {
  const ip = getRealIp(req);
  if (isRateLimited(ip)) {
    console.warn(`[rate-limit] ${ip} exceeded ${RATE_LIMIT_MAX} req/min on ${req.method} ${req.path}`);
    return res.status(429).json({ error: "Rate limit exceeded. Max 10 requests per minute per IP." });
  }
  next();
});

// ── Idempotency middleware (M3) ──────────────────────────────────────────────
app.use((req, res, next) => {
  const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
  if (idempotencyKey && req.method === "POST") {
    const cached = idempotencyCache.get(idempotencyKey);
    if (cached && Date.now() < cached.expiresAt) {
      console.log(`[idempotency] Replaying cached response for key: ${idempotencyKey}`);
      return res.status(cached.status).json(cached.body);
    }
    // Attach the key to res.locals so route handlers can cache their response
    res.locals.idempotencyKey = idempotencyKey;
  }
  next();
});

// Helper: cache a route response for idempotency replay
function cacheIdempotentResponse(res: any, status: number, body: any) {
  const key = res.locals.idempotencyKey;
  if (key) {
    idempotencyCache.set(key, { status, body, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
  }
}

// ── Delegation chain logger ──────────────────────────────────────────────────
// Log the delegation chain header when present — proves A2A authority chain
app.use((req, _res, next) => {
  const chain = req.headers["x-delegation-chain"];
  if (chain) {
    try {
      const parsed = JSON.parse(chain as string);
      console.log(`[ERC-7710] Delegation chain received on ${req.method} ${req.path}:`, JSON.stringify(parsed, null, 2));
    } catch {
      console.warn("[ERC-7710] Malformed X-Delegation-Chain header");
    }
  }
  next();
});

const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new Erc7710ExactEvmScheme(facilitatorClient));

// Route price map — mirrors paymentMiddleware config below.
// Used by the bypass to reconstruct payment requirements for real settlement.
// amount is the raw USDC integer at 6 decimals (e.g. 10000 = $0.01).
const ROUTE_REQUIREMENTS: Record<string, { price: string; amount: string }> = {
  "/api/sequence-check":  { price: "$0.01",  amount: "10000" },
  "/api/reagent-price":   { price: "$0.005", amount: "5000"  },
  "/api/protocol-validate": { price: "$0.02",  amount: "20000" },
};

// USDC contract on Base Sepolia — single source of truth used throughout this file.
// Update to the mainnet address when PAYMENT_NETWORK switches to eip155:8453.

// ── ERC-7710 Payment Intercept ───────────────────────────────────────────────
// Requests that carry BOTH a delegation chain AND a payment signature have
// already built an ERC-7710 payment payload in x402-buyer.ts. We intercept
// here and attempt REAL settlement via the Sentinel facilitator.
//
// Flow:
//   1. Decode the base64 payment header → PaymentPayload
//   2. Call facilitatorClient.settle() with the decoded payload
//   3. If settled → log the tx hash (REAL USDC moved!) and serve the endpoint
//   4. If the Sentinel rejects (ERC-7710 not yet fully supported) →
//      log the rejection and fall back to simulation so the demo continues
app.use(async (req, res, next) => {
  const chain   = req.headers["x-delegation-chain"];
  const payment = (req.headers["payment-signature"] || req.headers["x-payment"]) as string | undefined;

  if (chain && payment && req.method === "POST") {
    const routePrice = ROUTE_REQUIREMENTS[req.path]?.price;
    let settled = false;
    if (routePrice) {
      // Decode the base64 payment header the client sent
      let paymentPayload: any;
      try {
        paymentPayload = JSON.parse(Buffer.from(payment, "base64").toString("utf-8"));
      } catch {
        console.warn("[ERC-7710] Could not decode payment header — skipping real settlement attempt");
      }

      if (paymentPayload) {
        // ── Direct 1Shot Relayer Settlement ───────────────────────────────
        // We bypass the broken MetaMask Sentinel Facilitator and use the 1Shot API directly.
        let settleTimer: ReturnType<typeof setTimeout> | null = null;
        try {
          const auth = paymentPayload.payload?.authorization;
          if (!auth) throw new Error("Missing authorization payload");

          // Encode USDC transfer calldata for the marketplace payment
          const routeAmount = ROUTE_REQUIREMENTS[req.path]?.amount ?? "0";
          const data = encodeFunctionData({
            abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
            functionName: "transfer",
            args: [PAY_TO as `0x${string}`, BigInt(routeAmount)],
          });

          const executions: any[] = [{
            target: USDC_BASE_SEPOLIA,
            value: "0x0",
            data
          }];

          // Fetch relayer fee and append fee transfer
          // Both inner fetches use a 10 s AbortController timeout so a slow/unreachable
          // 1Shot server cannot hang Node.js's single-threaded event loop per request.
          let feeContext: string | undefined;
          let feeAmount = 0n;
          try {
            const feeController = new AbortController();
            const feeTimer = setTimeout(() => feeController.abort(), 10_000);
            let feeRes: Response;
            try {
              feeRes = await fetch(ONE_SHOT_RELAYER_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 2,
                  method: "relayer_getFeeData",
                  params: { chainId: RELAY_CHAIN_ID, token: USDC_BASE_SEPOLIA }
                }),
                signal: feeController.signal,
              });
            } finally {
              clearTimeout(feeTimer);
            }
            
            if (feeRes.ok) {
              const feeDataJson = await feeRes.json();
              const feeData = feeDataJson?.result;
              if (feeData) {
                feeContext = feeData.context;
                feeAmount = BigInt(Math.ceil(parseFloat(feeData.minFee ?? "0") * 1e6));
              }

              const capsController = new AbortController();
              const capsTimer = setTimeout(() => capsController.abort(), 10_000);
              let capsRes: Response;
              try {
                capsRes = await fetch(ONE_SHOT_RELAYER_URL, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "relayer_getCapabilities",
                    params: [RELAY_CHAIN_ID]
                  }),
                  signal: capsController.signal,
                });
              } finally {
                clearTimeout(capsTimer);
              }
              
              if (!capsRes.ok) {
                console.log(`[Marketplace 1Shot] capsRes failed: ${capsRes.status} ${await capsRes.text()}`);
              } else {
                const capsData = await capsRes.json();
                const feeCollector = capsData?.result?.[RELAY_CHAIN_ID]?.feeCollector || capsData?.[RELAY_CHAIN_ID]?.feeCollector;
                console.log(`[Marketplace 1Shot] capsData:`, JSON.stringify(capsData));
                console.log(`[Marketplace 1Shot] feeCollector: ${feeCollector}, feeAmount: ${feeAmount}`);
                if (feeCollector && feeAmount > 0n) {
                  executions.push({
                    target: USDC_BASE_SEPOLIA,
                    value: "0x0",
                    data: encodeFunctionData({
                      abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
                      functionName: "transfer",
                      args: [feeCollector as `0x${string}`, feeAmount]
                    })
                  });
                }
              }

            }
          } catch (e) {
            console.warn("Failed to fetch 1Shot fee context:", e);
          }

          // The Agent sent the full delegation chain, ending with a delegation to 1Shot
          const permissionContext = paymentPayload.payload.delegationChain;
          if (!permissionContext || !Array.isArray(permissionContext)) {
            throw new Error("Missing delegationChain for 1Shot relay");
          }

          const settlePromise = fetch(ONE_SHOT_RELAYER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 3,
              method: "relayer_send7710Transaction",
              params: {
                chainId: RELAY_CHAIN_ID,
                transactions: [{
                  executions,
                  permissionContext,
                }],
                ...(feeContext ? { context: feeContext } : {}),
                memo: "Reagent marketplace settlement — ERC-7710",
              }
            })
          });

          const timeoutPromise = new Promise<Response>((_, reject) => {
            settleTimer = setTimeout(() => reject(new Error("timed out")), 15_000);
          });
          const settleRes = await Promise.race([settlePromise, timeoutPromise]);
          const json = await settleRes.json() as any;

          const txHash = typeof json.result === "string" ? json.result : json.result?.TaskId;
          if (txHash) {
            console.log(`[ERC-7710] ✅ REAL settlement succeeded via 1Shot! TaskId: ${txHash}`);
            res.setHeader("PAYMENT-RESPONSE", Buffer.from(JSON.stringify({ success: true, txHash })).toString("base64"));
            settled = true;
          } else {
            console.warn(`[ERC-7710] 1Shot returned non-success:`, JSON.stringify(json).slice(0, 300));
          }
        } catch (settleErr: any) {
          const reason = settleErr.message;
          console.error(`[ERC-7710] Real settlement attempt failed (${reason}).`);
        } finally {
          // settleTimer may be null if the throw happened before setTimeout was called
          if (settleTimer !== null) clearTimeout(settleTimer);
        }
      }
    }

    if (!settled) {
      // FATAL — Real mode enabled: if the Sentinel does not settle the tx,
      // we reject the request. No simulated fallbacks.
      console.error(`[ERC-7710] Real settlement failed. Rejecting request.`);
      return res.status(402).json({ error: "ERC-7710 payment settlement failed on-chain." });
    }

    if (req.path === "/api/sequence-check")    return sequenceCheckHandler(req, res);
    if (req.path === "/api/reagent-price")     return reagentPriceHandler(req, res);
    if (req.path === "/api/protocol-validate") return protocolValidateHandler(req, res);
  }

  next();
});

app.use(paymentMiddleware({
  "POST /api/sequence-check": {
    accepts: [{ scheme: "exact", price: "$0.01", network: NETWORK, payTo: PAY_TO }],
    description: "Primer/probe sequence validation",
    mimeType: "application/json",
  },
  "POST /api/reagent-price": {
    accepts: [{ scheme: "exact", price: "$0.005", network: NETWORK, payTo: PAY_TO }],
    description: "Reagent pricing and availability",
    mimeType: "application/json",
  },
  "POST /api/protocol-validate": {
    accepts: [{ scheme: "exact", price: "$0.02", network: NETWORK, payTo: PAY_TO }],
    description: "AI-powered protocol validation",
    mimeType: "application/json",
  },
}, resourceServer));

app.post("/api/sequence-check", sequenceCheckHandler);
app.post("/api/reagent-price", reagentPriceHandler);
app.post("/api/protocol-validate", protocolValidateHandler);

const PORT = process.env.PORT || 4402;
app.listen(PORT, () => {
  console.log(`Marketplace running on :${PORT}`);
  console.log(`PAY_TO address: ${PAY_TO}`);
  console.log(`Network: ${NETWORK}`);
});
