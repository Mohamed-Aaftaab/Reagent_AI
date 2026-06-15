import { Link } from "react-router-dom";

export function HowItWorks() {
  return (
    <main className="page-main">
      <section className="page-hero">
        <p className="eyebrow"><span></span>How it Works</p>
        <h1>Three steps to <em>autonomy</em></h1>
        <p>No seed phrases shared. No complex signing. From connecting your wallet to fully autonomous AI research in under a minute.</p>
        <div className="page-actions">
          <Link className="button primary" to="/dashboard">Get Started</Link>
        </div>
      </section>

      <section className="section-pad">
        <div className="steps">
          <article className="step-card">
            <span className="step-number">01</span>
            <h3>Connect your MetaMask</h3>
            <p>
              Connect your EOA wallet and we instantly deploy an ERC-4337 Smart Account
              on Base Sepolia linked to your address.
            </p>
            <div className="mini-ui wallet">
              <span>Smart Account</span>
              <strong>0x4f...a3e1</strong>
              <b>Deployed</b>
            </div>
          </article>

          <article className="step-card">
            <span className="step-number">02</span>
            <h3>Delegate Budget</h3>
            <p>
              Sign a one-time message granting the AI agent permission to spend up to
              $5 USDC. You never give away your private key.
            </p>
            <div className="mini-ui upload">
              <span>Signing Delegation</span>
              <strong>5.00 USDC Limit</strong>
              <b><i></i></b>
            </div>
          </article>

          <article className="step-card">
            <span className="step-number">03</span>
            <h3>Agent Executes</h3>
            <p>
              The AI agent creates transactions, signs them with its session key,
              and relays them via 1Shot. It stops when the budget is hit.
            </p>
            <div className="mini-ui seals">
              <span>Paid /api/sequence-check <b>$0.01</b></span>
              <span>Paid /api/protocol-validate <b>$0.01</b></span>
              <span>Remaining Budget: <b>$4.98</b></span>
            </div>
          </article>
        </div>
      </section>
    </main>
  );
}
