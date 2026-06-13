import { privateKeyToAccount } from "viem/accounts";
import { toHex, getAddress } from "viem";

const agentSessionKey = process.env.AGENT_SESSION_KEY as `0x${string}`;
if (!agentSessionKey) {
  console.warn("WARNING: AGENT_SESSION_KEY is not set. Agent cannot sign payments.");
  process.exit(1); // Hard-fail — do not silently use a public test key
}

// The Main Agent's persistent session account
export const sessionAccount = privateKeyToAccount(agentSessionKey);

// Chain ID for payment signing — must match the chain the Smart Account is deployed on.
// Reads from RELAY_CHAIN_ID env var so mainnet upgrades only need a single .env change.
const PAYMENT_CHAIN_ID = parseInt(process.env.RELAY_CHAIN_ID ?? "84532", 10);

// Timeout for x402 fetch calls to the marketplace (localhost:4402).
// 30s is conservative for a local server — prevents 2-min hangs if the marketplace
// process accepts the TCP connection but hangs processing the request.
const X402_FETCH_TIMEOUT_MS = 30_000;

// ── EIP-3009 TransferWithAuthorization typed data ────────────────────────────
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from",        type: "address" },
    { name: "to",          type: "address" },
    { name: "value",       type: "uint256" },
    { name: "validAfter",  type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce",       type: "bytes32" },
  ],
} as const;

/**
 * Decodes the base64-encoded PAYMENT-REQUIRED header sent by the @x402/express
 * middleware. Returns the parsed payment requirements object.
 */
function decodePaymentRequired(headerValue: string): any {
  try {
    // The header is base64(JSON.stringify(paymentRequirements[]))
    const json = Buffer.from(headerValue, "base64").toString("utf-8");
    const parsed = JSON.parse(json);
    // The header wraps the array in { accepts: [...] } or is the array itself
    if (Array.isArray(parsed)) return parsed[0];
    if (parsed.accepts) return parsed.accepts[0];
    return parsed;
  } catch {
    throw new Error(`Could not decode PAYMENT-REQUIRED header: ${headerValue.slice(0, 80)}`);
  }
}

/**
 * Creates an ERC-7710 aware x402 payment payload.
 *
 * The key insight: instead of paying from the Sub-Agent's empty wallet, we sign a
 * TransferWithAuthorization whose `from` field is the Smart Account vault (which holds
 * the USDC). The delegation chain attached alongside proves that the Sub-Agent is
 * authorised to sign on behalf of that vault.
 *
 * The MetaMask x402 facilitator verifies the delegation chain on-chain and executes
 * the USDC transfer from the vault.
 */
async function buildErc7710PaymentPayload(
  subAgentAccount: ReturnType<typeof privateKeyToAccount>,
  smartAccountAddress: string,
  paymentReqs: any,
  delegationChain: any[]
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const maxTimeout = paymentReqs.maxTimeoutSeconds ?? 300;

  // Random 32-byte nonce (EIP-3009 requirement)
  const nonceBytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(nonceBytes);
  const nonce = toHex(nonceBytes);

  // Chain ID sourced from RELAY_CHAIN_ID env var — not hardcoded — so mainnet
  // upgrades don't require a code change, only a .env update.
  const chainId = PAYMENT_CHAIN_ID;

  // EIP-712 domain from the USDC token contract
  const domain = {
    name:              paymentReqs.extra?.name    ?? "USD Coin",
    version:           paymentReqs.extra?.version ?? "2",
    chainId,
    verifyingContract: getAddress(paymentReqs.asset),
  };

  const message = {
    from:        getAddress(smartAccountAddress),   // ← Smart Account vault, not Sub-Agent!
    to:          getAddress(paymentReqs.payTo),
    value:       BigInt(paymentReqs.amount),
    validAfter:  BigInt(0),
    validBefore: BigInt(now + maxTimeout),
    nonce,
  };

  // Sub-Agent signs on behalf of the Smart Account vault.
  // The delegation chain proves it has authority to do so.
  const signature = await subAgentAccount.signTypedData({
    domain,
    types:       TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });

  const payload = {
    x402Version: 1,
    scheme:      "exact",
    network:     paymentReqs.network,
    payload: {
      authorization: {
        from:        message.from,
        to:          message.to,
        value:       message.value.toString(),
        validAfter:  message.validAfter.toString(),
        validBefore: message.validBefore.toString(),
        nonce,
      },
      signature,
      // Embed the full delegation chain so the facilitator can verify authority
      delegationChain,
    },
  };

  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/**
 * Factory — creates an ERC-7710 aware paid fetch for a Sub-Agent.
 *
 * When the marketplace returns HTTP 402 with assetTransferMethod "erc7710",
 * this wrapper:
 *   1. Parses the PAYMENT-REQUIRED header to get payment requirements
 *   2. Signs a TransferWithAuthorization from the Smart Account vault
 *   3. Attaches the full delegation chain as proof of authority
 *   4. Retries the request with the PAYMENT-SIGNATURE header
 *
 * Falls back to a plain EIP-3009 flow (signing from Sub-Agent wallet) if the
 * server does not advertise erc7710 — preserving backwards compatibility.
 *
 * @param subAgentAccount    - The ephemeral Sub-Agent keypair for this task
 * @param smartAccountAddress - The Smart Account vault address that holds USDC
 * @param delegationChain    - The signed chain: SmartAccount → MainAgent → SubAgent
 */
export function createPaidFetch(
  subAgentAccount: ReturnType<typeof privateKeyToAccount>,
  delegationChain?: any[],
  smartAccountAddress?: string
) {
  return async (url: string, options: RequestInit = {}): Promise<Response> => {
    // ── Step 1: Initial request (no payment header) ────────────────────────
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string> ?? {}),
      // Always send the delegation chain so the marketplace can log the authority chain
      ...(delegationChain ? { "X-Delegation-Chain": JSON.stringify(delegationChain) } : {}),
    };

    // AbortController timeout: 30s. Prevents a 2-min hang if marketplace
    // accepts TCP but stalls processing (e.g. blocked in a slow middleware).
    const firstController = new AbortController();
    const firstTimer = setTimeout(() => firstController.abort(), X402_FETCH_TIMEOUT_MS);
    let firstResponse: Response;
    try {
      firstResponse = await fetch(url, { ...options, headers, signal: firstController.signal });
    } finally {
      clearTimeout(firstTimer);
    }

    if (firstResponse.status !== 402) {
      return firstResponse; // Success or unrelated error — pass through
    }

    // ── Step 2: Parse the 402 payment requirements ─────────────────────────
    // HTTP/1.1 header names are case-insensitive but Node.js lowercases incoming headers.
    // Check lowercase first (the canonical Node.js form), then the uppercase alias used
    // by some @x402/express versions.
    const paymentRequiredHeader =
      firstResponse.headers.get("payment-required") ??
      firstResponse.headers.get("PAYMENT-REQUIRED");

    if (!paymentRequiredHeader) {
      throw new Error("Got HTTP 402 but no PAYMENT-REQUIRED header was present.");
    }

    let paymentReqs: any;
    try {
      paymentReqs = decodePaymentRequired(paymentRequiredHeader);
    } catch (err: any) {
      throw new Error(`Failed to parse PAYMENT-REQUIRED: ${err.message}`);
    }

    const transferMethod = paymentReqs?.extra?.assetTransferMethod;
    console.log(`[x402] 402 received. Transfer method: ${transferMethod}, amount: ${paymentReqs?.amount}, asset: ${paymentReqs?.asset}`);

    // ── Step 3: Build the payment payload ─────────────────────────────────
    let paymentB64: string;

    // Use the ERC-7710 delegation path whenever we have a delegation chain and
    // a smart account vault — regardless of what assetTransferMethod the server
    // advertised in the 402 header. This ensures buildErc7710PaymentPayload
    // (which signs from the Smart Account vault, not the empty Sub-Agent wallet)
    // is always invoked when delegation authority is available.
    // Previously this required `transferMethod === "erc7710"` from the server,
    // but enhancePaymentRequirements may not be called if the bypass intercepts
    // the request before paymentMiddleware runs.
    if (smartAccountAddress && delegationChain?.length) {
      // ERC-7710 path: sign from Smart Account vault using delegation as authority
      console.log(`[x402] Using ERC-7710 delegation path. Signing from vault: ${smartAccountAddress} (server method: ${transferMethod ?? "unset"})`);
      paymentB64 = await buildErc7710PaymentPayload(
        subAgentAccount,
        smartAccountAddress,
        paymentReqs,
        delegationChain
      );
    } else {
      // Standard EIP-3009 path: sign directly from Sub-Agent wallet
      // (will fail if Sub-Agent has no USDC — included for completeness)
      console.warn("[x402] Falling back to standard EIP-3009 (Sub-Agent pays directly). Sub-Agent must hold USDC.");
      const now = Math.floor(Date.now() / 1000);
      const nonceBytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(nonceBytes);
      const nonce = toHex(nonceBytes);
      const domain = {
        name:    paymentReqs.extra?.name    ?? "USD Coin",
        version: paymentReqs.extra?.version ?? "2",
        // Use the same env-driven chain ID as the primary path — not hardcoded.
        chainId: PAYMENT_CHAIN_ID,
        verifyingContract: getAddress(paymentReqs.asset),
      };
      const message = {
        from:        subAgentAccount.address,
        to:          getAddress(paymentReqs.payTo),
        value:       BigInt(paymentReqs.amount),
        validAfter:  BigInt(0),
        validBefore: BigInt(now + (paymentReqs.maxTimeoutSeconds ?? 300)),
        nonce,
      };
      const signature = await subAgentAccount.signTypedData({
        domain,
        types:       TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message,
      });
      const payload = {
        x402Version: 1,
        scheme:      "exact",
        network:     paymentReqs.network,
        payload: {
          authorization: {
            from: message.from, to: message.to,
            value: message.value.toString(),
            validAfter: "0", validBefore: message.validBefore.toString(), nonce,
          },
          signature,
        },
      };
      paymentB64 = Buffer.from(JSON.stringify(payload)).toString("base64");
    }

    // ── Step 4: Retry with payment header ──────────────────────────────────
    const retryHeaders: Record<string, string> = {
      ...(options.headers as Record<string, string> ?? {}),
      "PAYMENT-SIGNATURE":             paymentB64,
      "X-PAYMENT":                     paymentB64, // some middleware checks this alias
      "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
      ...(delegationChain ? { "X-Delegation-Chain": JSON.stringify(delegationChain) } : {}),
    };

    console.log(`[x402] Retrying ${url} with payment signature (erc7710: ${transferMethod === "erc7710"})`);
    const secondController = new AbortController();
    const secondTimer = setTimeout(() => secondController.abort(), X402_FETCH_TIMEOUT_MS);
    let secondResponse: Response;
    try {
      secondResponse = await fetch(url, { ...options, headers: retryHeaders, signal: secondController.signal });
    } finally {
      clearTimeout(secondTimer);
    }
    console.log(`[x402] Payment response status: ${secondResponse.status}`);

    return secondResponse;
  };
}
