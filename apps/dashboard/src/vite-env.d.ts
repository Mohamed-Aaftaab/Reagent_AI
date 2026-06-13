/// <reference types="vite/client" />

/**
 * Augment the global Window interface with MetaMask's injected Ethereum provider.
 * Without this declaration, `window.ethereum` causes TypeScript build errors
 * (`tsc -b`) even though it works fine at runtime in a browser with MetaMask.
 */
interface EthereumProvider {
  /** Send a JSON-RPC request to the wallet. */
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  /** Subscribe to wallet events (accountsChanged, chainChanged, etc.) */
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  /** Unsubscribe from wallet events. */
  removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
  /** True when MetaMask is the active provider. */
  isMetaMask?: boolean;
}

declare global {
  interface Window {
    /**
     * EIP-1193 Ethereum provider injected by MetaMask.
     * Optional — may be undefined if MetaMask is not installed.
     */
    ethereum?: EthereumProvider;
  }
}
