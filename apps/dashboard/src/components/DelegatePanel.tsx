import { useState, useEffect } from "react";
import { encodeAbiParameters, toHex } from "viem";

// USDC contract on Base Sepolia — single source of truth.
// Update to mainnet address (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) for production.
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
// Spending cap: $5.00 in USDC (6 decimals)
const DELEGATION_CAP = 5_000_000n;

export function DelegatePanel({ smartAccount }: { smartAccount: any }) {
  const [delegated, setDelegated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revoking, setRevoking] = useState(false);
  // isChecking: true while probing the server — hides the button during the
  // initial fetch so it doesn't flash "Delegate" before resolving to "Delegated".
  const [isChecking, setIsChecking] = useState(true);

  // On mount (and on smart account change), probe the agent server to see
  // whether a delegation is already stored. This restores the delegated state
  // after a page refresh without requiring the user to re-sign.
  useEffect(() => {
    if (!smartAccount?.address) { setIsChecking(false); return; }
    setIsChecking(true);
    // 5s timeout — bounds the shimmer duration if the agent server is slow to
    // cold-start (tsx JIT). Without this, isChecking stays true indefinitely
    // until the browser's OS-level TCP timeout (~300s) fires.
    const probeController = new AbortController();
    const probeTimer = setTimeout(() => probeController.abort(), 5_000);
    const AGENT_URL = import.meta.env.VITE_AGENT_URL ?? "http://localhost:4000";
    fetch(`${AGENT_URL}/api/has-delegation?smartAccount=${smartAccount.address}`, {
      signal: probeController.signal,
    })
      .then(r => r.json())
      .then((data: { exists: boolean }) => { setDelegated(data.exists); })
      .catch(() => { /* Non-fatal — if probe fails just show the delegate button */ })
      .finally(() => { clearTimeout(probeTimer); setIsChecking(false); });
  }, [smartAccount?.address]);

  async function createDelegation() {
    setLoading(true);
    try {
      // Hard crash if the agent address is not configured — delegating to the
      // zero address is a silent failure that allows no agent execution.
      const agentAddress = import.meta.env.VITE_AGENT_SESSION_ADDRESS as `0x${string}`;
      if (!agentAddress || agentAddress === "0x0000000000000000000000000000000000000000") {
        throw new Error(
          "VITE_AGENT_SESSION_ADDRESS is not set. " +
          "Please add the agent session wallet address to your environment variables."
        );
      }

      // Generate a cryptographically random 32-byte salt for each delegation.
      // This prevents replay attacks and allows the user to re-delegate safely
      // (each delegation will have a unique EIP-712 hash even for the same delegate).
      const saltBytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(saltBytes);
      const salt = BigInt(toHex(saltBytes));

      const delegation = {
        delegate: agentAddress,
        delegator: smartAccount.address as `0x${string}`,
        // Must be a proper 32-byte hex zero — "0x" alone is invalid and causes signDelegation to throw
        authority: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
        // Real caveat: 5 USDC limit enforced by ERC20TransferAmountEnforcer
        // USDC on Base Sepolia: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
        // $5.00 in 6 decimals = 5000000
        caveats: [
          {
            enforcer: "0x2DbF1eab62768134BBA672ed0bEb1BfEAE1a8a61" as `0x${string}`, // ERC20TransferAmountEnforcer 1.3.0
            terms: encodeAbiParameters(
              [{ type: "address" }, { type: "uint256" }],
              [USDC_BASE_SEPOLIA, DELEGATION_CAP]
            ),
            args: "0x" as `0x${string}`,
          }
        ],
        salt,
      };

      const signedDelegation = await smartAccount.signDelegation({ delegation });

      // Convert BigInts to strings for JSON serialization
      const jsonSafeDelegation = {
        ...delegation,
        salt: toHex(delegation.salt),
        caveats: delegation.caveats.map(c => ({
          ...c,
          terms: c.terms, // already a hex string from encodeAbiParameters
          args: c.args,
        })),
      };

      const AGENT_URL = import.meta.env.VITE_AGENT_URL ?? "http://localhost:4000";
      const res = await fetch(`${AGENT_URL}/api/store-delegation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          smartAccount: smartAccount.address,
          delegation: {
            delegation: jsonSafeDelegation,
            signature: signedDelegation,
          },
        }),
      });

      if (res.ok) {
        setDelegated(true);
      } else {
        throw new Error("Failed to store delegation on Agent server");
      }
    } catch (err) {
      console.error(err);
      alert("Delegation failed: " + (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function revokeDelegation() {
    setRevoking(true);
    try {
      const AGENT_URL = import.meta.env.VITE_AGENT_URL ?? "http://localhost:4000";
      const res = await fetch(`${AGENT_URL}/api/revoke-delegation`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ smartAccount: smartAccount.address }),
      });
      if (res.ok) {
        setDelegated(false);
      } else {
        throw new Error("Server failed to revoke delegation");
      }
    } catch (err) {
      console.error(err);
      alert("Revoke failed: " + (err as Error).message);
    } finally {
      setRevoking(false);
    }
  }

  return (
    <>
      {isChecking ? (
        <div className="mt-4 h-9 w-36 rounded-lg bg-white/10 animate-pulse" />
      ) : delegated ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 p-3 rounded-lg border border-green-500/20 bg-green-500/10 text-green-400 text-sm font-medium">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
              <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
            $5.00 USDC Delegated to Agent
          </div>
          <button
            onClick={revokeDelegation}
            disabled={revoking}
            className="text-xs px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {revoking ? "Revoking..." : "Revoke Delegation"}
          </button>
        </div>
      ) : (
        <button
          onClick={createDelegation}
          disabled={loading}
          className="mt-4 px-4 py-2 rounded-lg border border-orange-500/30 bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
        >
          {loading ? "Signing..." : "Delegate $5 Budget"}
        </button>
      )}
    </>
  );
}
