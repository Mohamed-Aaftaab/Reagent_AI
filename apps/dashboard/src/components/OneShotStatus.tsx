import { useState, useEffect } from "react";
import { Badge } from "./ui/badge";

// The testnet relayer is what the app actually uses for all task relay.
// We probe it directly from the browser so the badge honestly reflects
// operational status — not mainnet connectivity the app doesn't use.
const TESTNET_RELAYER = "https://relayer.1shotapi.dev/relayers";

export function OneShotStatus() {
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    fetch(TESTNET_RELAYER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "relayer_getCapabilities", params: ["84532"] }),
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((data) => setOnline(!!data?.result))
      .catch(() => setOnline(false))
      .finally(() => clearTimeout(timer));
  }, []);

  const label =
    online === null ? "Connecting 1Shot..." :
    online         ? "1Shot: Online" :
                     "1Shot: Offline";

  return (
    <Badge
      variant="outline"
      className={`px-3 py-1 text-xs font-mono tracking-wide rounded-full ${
        online === false ? "bg-destructive/10 text-destructive border-destructive/20" :
        online === true  ? "bg-green-500/10 text-green-400 border-green-500/20" :
                           "bg-primary/10 text-primary border-primary/20"
      }`}
    >
      <div
        className={`w-1.5 h-1.5 rounded-full mr-2 flex-shrink-0 ${
          online === false ? "bg-destructive shadow-[0_0_8px_rgba(239,68,68,0.8)]" :
          online === true  ? "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.8)]" :
                             "bg-primary shadow-[0_0_8px_rgba(0,255,255,0.8)] animate-pulse"
        }`}
      />
      {label}
    </Badge>
  );
}
