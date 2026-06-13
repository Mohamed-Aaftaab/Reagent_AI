import { createPublicClient, http, fallback } from "viem";
import { baseSepolia } from "viem/chains";

// Multiple RPC endpoints in priority order — viem's fallback() transport
// automatically tries the next one if the primary is rate-limited or unreachable.
// Base Sepolia's public RPC is free but heavily rate-limited during demos.
export const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: fallback([
    http("https://sepolia.base.org"),                              // Primary — Coinbase public
    http("https://base-sepolia.blockpi.network/v1/rpc/public"),   // Fallback 1 — BlockPI
    http("https://84532.rpc.thirdweb.com"),                       // Fallback 2 — Thirdweb
  ]),
});
