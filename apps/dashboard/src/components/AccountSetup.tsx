import { useState } from "react";
import { toMetaMaskSmartAccount, Implementation } from "@metamask/smart-accounts-kit";
import { createWalletClient, custom } from "viem";
import { baseSepolia } from "viem/chains";
import { publicClient } from "../lib/metamask";
import { DelegatePanel } from "./DelegatePanel";
import { Card, CardHeader, CardContent } from "./ui/card";
import { Button } from "./ui/button";

export function AccountSetup({ onAccountReady }: { onAccountReady: (addr: string) => void }) {
  const [smartAccount, setSmartAccount] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  async function createSmartAccount() {
    setLoading(true);
    try {
      if (!(window as any).ethereum) throw new Error("MetaMask not found");

      const [address] = await (window as any).ethereum.request({ method: "eth_requestAccounts" });

      // Automatically prompt MetaMask to switch to Base Sepolia (chainId 84532 -> 0x14a34)
      try {
        await (window as any).ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x14a34" }],
        });
      } catch (switchError: any) {
        // Error 4902 indicates that the chain has not been added to MetaMask.
        if (switchError.code === 4902) {
          try {
            await (window as any).ethereum.request({
              method: "wallet_addEthereumChain",
              params: [
                {
                  chainId: "0x14a34",
                  chainName: "Base Sepolia",
                  rpcUrls: ["https://sepolia.base.org"],
                  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
                  blockExplorerUrls: ["https://sepolia.basescan.org"],
                },
              ],
            });
          } catch (addError) {
            console.error("Failed to add Base Sepolia to MetaMask:", addError);
          }
        } else {
          // Non-4902 errors typically mean the user rejected the switch.
          // Alert so the user knows to manually switch — continuing on the wrong
          // chain causes silent failures in toMetaMaskSmartAccount.
          const msg = switchError?.message ?? String(switchError);
          console.warn("Could not auto-switch to Base Sepolia:", switchError);
          alert(`⚠️ Please switch MetaMask to Base Sepolia manually before continuing.\n\nReason: ${msg}`);
          setLoading(false);
          return; // Abort setup — do not proceed on wrong chain
        }
      }

      // Build a proper viem WalletClient from the MetaMask provider.
      // The SAK signer field requires a WalletClient with actual signing capability,
      // not a plain { account } object which cannot produce signatures.
      const walletClient = createWalletClient({
        account: address as `0x${string}`,
        chain: baseSepolia,
        transport: custom((window as any).ethereum),
      });

      const account = await toMetaMaskSmartAccount({
        // @ts-ignore - viem version mismatch in SAK types
        client: publicClient,
        implementation: Implementation.Hybrid,
        deployParams: [address, [], [], []],
        // Must be a 32-byte hex — "0x" alone may produce an unexpected account address
        deploySalt: "0x0000000000000000000000000000000000000000000000000000000000000000",
        signer: { walletClient },
      });

      setSmartAccount(account);
      onAccountReady(account.address);
    } catch (err) {
      console.error(err);
      alert("Failed to setup Smart Account. Check the console for details.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="glass relative overflow-hidden bg-black/40 border-white/5 backdrop-blur-xl">
      <div className="absolute inset-0 bg-radial-glow opacity-30 pointer-events-none" />
      <CardHeader>
        <div className="text-xs tracking-widest text-primary uppercase mb-2 font-mono">The Vault Setup</div>
      </CardHeader>
      <CardContent className="space-y-8 relative z-10">
        
        <div className="flex gap-4">
          <div className="flex-shrink-0 w-8 h-8 rounded-full border border-primary/30 flex items-center justify-center text-primary text-xs font-mono shadow-[0_0_15px_rgba(0,255,255,0.3)]">01</div>
          <div className="space-y-2">
            <h3 className="text-lg font-medium text-foreground tracking-tight">Connect Wallet</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">Approve the connection in your wallet to begin. Your address is your identity.</p>
            {!smartAccount ? (
              <Button 
                onClick={createSmartAccount} 
                disabled={loading}
                variant="outline"
                className="mt-4 border-primary/30 hover:bg-primary/10 text-primary transition-all duration-300"
              >
                {loading ? "Connecting..." : "Connect MetaMask"}
              </Button>
            ) : (
              <div className="mt-4 p-3 rounded-lg border border-white/5 bg-white/5">
                <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Connected Address</div>
                <div className="font-mono text-sm text-primary">{smartAccount.address}</div>
              </div>
            )}
          </div>
        </div>

        <div className="flex gap-4">
          <div className="flex-shrink-0 w-8 h-8 rounded-full border border-accent/30 flex items-center justify-center text-accent text-xs font-mono shadow-[0_0_15px_rgba(255,0,255,0.3)]">02</div>
          <div className="space-y-2">
            <h3 className="text-lg font-medium text-foreground tracking-tight">Smart Account Vault</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">A secure vault is automatically created to hold your USDC.</p>
            {!smartAccount ? (
              <div className="mt-4 p-3 rounded-lg border border-white/5 bg-white/5 opacity-50">
                <div className="font-mono text-xs text-muted-foreground uppercase tracking-wider">Waiting for wallet...</div>
              </div>
            ) : (
              <div className="mt-4 p-3 rounded-lg border border-accent/20 bg-accent/5 flex items-center gap-2 text-accent">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                  <polyline points="22 4 12 14.01 9 11.01"></polyline>
                </svg>
                <span className="text-sm font-medium">Vault Active</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex gap-4">
          <div className="flex-shrink-0 w-8 h-8 rounded-full border border-orange-500/30 flex items-center justify-center text-orange-400 text-xs font-mono shadow-[0_0_15px_rgba(255,165,0,0.3)]">03</div>
          <div className="space-y-2">
            <h3 className="text-lg font-medium text-foreground tracking-tight">Delegate Authority</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">Grant the Sub-Agent a fixed USDC budget to spend on your behalf.</p>
            {!smartAccount ? (
              <div className="mt-4 p-3 rounded-lg border border-white/5 bg-white/5 opacity-50">
                <div className="font-mono text-xs text-muted-foreground uppercase tracking-wider">Waiting for vault...</div>
              </div>
            ) : (
              <div className="mt-4">
                <DelegatePanel smartAccount={smartAccount} />
              </div>
            )}
          </div>
        </div>

      </CardContent>
    </Card>
  );
}
