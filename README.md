# Reagent — Autonomous Scientific Data Marketplace

Reagent is a pay-per-query scientific data marketplace built for the **MetaMask Smart Accounts Kit × 1Shot API × Venice AI** hackathon.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│              Dashboard (React + Vite)                   │
│  MetaMask SAK → Smart Account → ERC-7710 Delegation     │
└──────────────────┬──────────────────────────────────────┘
                   │  WebSocket (ws://localhost:4000)
                   ▼
┌─────────────────────────────────────────────────────────┐
│               Agent Server (Bun + Express)              │
│  Main Agent → Venice AI Planner                         │
│      └─ EIP-712 Redelegation → Ephemeral Sub-Agent      │
│             └─ @x402/fetch + X-Delegation-Chain header  │
└──────────────────┬──────────────────────────────────────┘
                   │  HTTP 402 / x402 Protocol
                   ▼
┌─────────────────────────────────────────────────────────┐
│             Marketplace (Bun + Express)                 │
│  /api/sequence-check   ($0.01)  — Venice AI             │
│  /api/reagent-price    ($0.005) — Venice AI             │
│  /api/protocol-validate($0.02)  — Venice AI             │
│  Erc7710ExactEvmScheme → MetaMask Facilitator           │
└─────────────────────────────────────────────────────────┘
```

## Key Technologies

| Technology | Usage |
|------------|-------|
| MetaMask Smart Accounts Kit | EIP-7702 account upgrade, `signDelegation` |
| 1Shot API | Gasless relayer for account upgrade transactions |
| Venice AI (llama-3.3-70b) | Research planning, scientific analysis, synthesis |
| x402 Protocol | HTTP-native micropayments (`@x402/express`, `@x402/fetch`) |
| ERC-7710 | Delegation chain embedded in payment headers |
| EIP-712 | Typed-data signing for A2A sub-delegations |
| viem | Wallet/account/signing primitives |

## A2A Redelegation Flow

1. **User** connects MetaMask, upgrades to a Smart Account via 1Shot.
2. **User** signs an ERC-7710 delegation granting the Main Agent a $5 USDC budget.
3. **Main Agent** receives a research task via WebSocket.
4. **Main Agent** uses Venice AI to plan which paid APIs to call and the total cost.
5. **Main Agent** generates an ephemeral Sub-Agent keypair and signs an EIP-712 sub-delegation for exactly that cost.
6. **Sub-Agent** executes the plan using `@x402/fetch`, attaching both the x402 payment signature and the full delegation chain (`X-Delegation-Chain` header).
7. **Marketplace** receives each request, verifies payment via the MetaMask Facilitator, and logs the delegation chain.
8. **Venice AI** performs the scientific analysis (primer validation, reagent pricing, protocol checking).
9. **Main Agent** synthesizes all results and streams a final report back via WebSocket.

## Running Locally

### Setup

```bash
# 1. Fill in your API keys
# Edit apps/agent/.env, apps/marketplace/.env, apps/dashboard/.env

# 2. Install dependencies
bun install

# 3. Start all three services (in separate terminals)
cd apps/marketplace && bun dev   # :4402
cd apps/agent && bun dev         # :4000
cd apps/dashboard && bun dev     # :5173
```

### Environment Variables

| App | Variable | Description |
|-----|----------|-------------|
| agent | `AGENT_SESSION_KEY` | 0x-prefixed private key for the Main Agent |
| agent | `VENICE_API_KEY` | Venice AI API key |
| marketplace | `SELLER_ADDRESS` | Wallet address to receive USDC payments |
| marketplace | `VENICE_API_KEY` | Venice AI API key |
| dashboard | `VITE_AGENT_SESSION_ADDRESS` | Public address of the agent session key |
