import { useState, useEffect } from "react";
import { AccountSetup } from "../components/AccountSetup";
import { SpendTracker } from "../components/SpendTracker";
import { AgentChat } from "../components/AgentChat";
import { agentWs } from "../lib/websocket";

export function Dashboard() {
  const [smartAccount, setSmartAccount] = useState<string | null>(null);

  // Open the agent WebSocket only when the user is on the Dashboard.
  // Closing on unmount (navigation away) avoids an idle connection on Landing etc.
  // The websocket singleton auto-reconnects on the next Dashboard mount.
  useEffect(() => {
    agentWs.connect();
    return () => agentWs.close();
  }, []);

  return (
    <main className="app-shell" style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) 2fr', gap: '24px', padding: '24px', width: 'min(1400px, 100%)', margin: '0 auto', minHeight: 'calc(100vh - 200px)' }}>
      <section className="app-panel" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <AccountSetup onAccountReady={setSmartAccount} />
        <SpendTracker />
      </section>
      <section className="app-panel" style={{ position: 'relative', overflow: 'hidden' }}>
        <AgentChat smartAccountAddress={smartAccount} />
      </section>
    </main>
  );
}
