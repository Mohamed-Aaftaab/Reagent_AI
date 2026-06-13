import { Link } from "react-router-dom";

export function Features() {
  return (
    <main className="page-main">
      <section className="page-hero">
        <p className="eyebrow"><span></span>Agentic Architecture</p>
        <h1>An agent that <em>respects</em> your limits</h1>
        <p>You shouldn't have to choose between convenience and security. Reagent leverages MetaMask Smart Accounts and Base Sepolia to let AI act on your behalf, with hard cryptographic limits.</p>
        <div className="page-actions">
          <Link className="button primary" to="/dashboard">Deploy Smart Account</Link>
          <Link className="button secondary" to="/how-it-works">See architecture</Link>
        </div>
      </section>

      <section className="section-pad">
        <div className="feature-grid">
          <article className="feature-card">
            <span className="card-kicker">MetaMask SAK</span>
            <h3>Programmable Auth</h3>
            <p>
              Your EOA controls a Smart Account. You can grant limited permissions
              to session keys representing the AI agent.
            </p>
            <dl>
              <div><dt>Standard</dt><dd>ERC-4337</dd></div>
              <div><dt>Signatures</dt><dd>ERC-1271</dd></div>
            </dl>
          </article>

          <article className="feature-card raised">
            <span className="card-kicker">Strict Caveats</span>
            <h3>Hard Spend Limits</h3>
            <p>
              The agent is restricted by Caveats. We enforce a $5 USDC limit,
              preventing the agent from spending a penny more.
            </p>
            <dl>
              <div><dt>Allowance</dt><dd>Up to $5 USDC</dd></div>
              <div><dt>Timebox</dt><dd>Customizable</dd></div>
            </dl>
          </article>

          <article className="feature-card">
            <span className="card-kicker">Gasless UX</span>
            <h3>Sponsored Txs</h3>
            <p>
              The agent pays for gas using a Paymaster. You never need to fund
              the Smart Account with ETH, only the USDC it intends to spend.
            </p>
            <dl>
              <div><dt>Relayer</dt><dd>1Shot API</dd></div>
              <div><dt>Gas Token</dt><dd>Sponsored</dd></div>
            </dl>
          </article>
        </div>
      </section>
    </main>
  );
}
