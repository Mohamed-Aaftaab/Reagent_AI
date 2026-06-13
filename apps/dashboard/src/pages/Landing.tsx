import { Link } from "react-router-dom";

export function Landing() {
  return (
    <main id="top">
      <section className="hero section-pad">
        <div className="hero-art" aria-hidden="true">
          <div className="memory-chip chip-one"></div>
          <div className="memory-chip chip-two"></div>
          <div className="memory-chip chip-three"></div>
        </div>

        <p className="eyebrow"><span></span>Autonomous AI Delegation</p>
        <h1>Never manage <em>transactions</em> manually again</h1>
        <p className="hero-copy">
          Give your AI companion an allowance. Let it spend on your behalf.
          Powered by MetaMask Smart Accounts and Base Sepolia, you are always
          in control of the budget.
        </p>

        <div className="hero-actions">
          <Link className="button primary" to="/dashboard">Talk to Reagent AI</Link>
          <Link className="button secondary" to="/how-it-works">How it works</Link>
        </div>

        <div className="trust-line" aria-label="Protocol benefits">
          <span></span>
          <strong>Smart Accounts</strong>
          <b></b>
          <strong>Delegation</strong>
          <b></b>
          <strong>Autonomous</strong>
          <span></span>
        </div>
      </section>

      <section className="integrations" aria-label="Protocol stack">
        <div>
          <span>Reagent AI</span>
          <strong>Agent Companion</strong>
        </div>
        <div>
          <span>MetaMask</span>
          <strong>Smart Accounts Kit</strong>
        </div>
        <div>
          <span>Base</span>
          <strong>Layer 2 Network</strong>
        </div>
        <div>
          <span>1Shot</span>
          <strong>Paymaster Relayer</strong>
        </div>
      </section>

      <section className="stats section-narrow" aria-label="Live protocol stats">
        <div>
          <strong>0.01s</strong>
          <span>Delegation Time</span>
        </div>
        <div>
          <strong>100%</strong>
          <span>User Controlled</span>
        </div>
        <div>
          <strong>$5.00</strong>
          <span>Default Limit</span>
        </div>
        <div>
          <strong>∞</strong>
          <span>Possibilities</span>
        </div>
      </section>

      <section className="split section-pad" id="companion">
        <div className="failure-card">
          <div className="drive-visual" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <p>Manual signing sucks</p>
          <strong>10 popups for a single swap</strong>
        </div>

        <div className="section-copy">
          <p className="label">The Problem</p>
          <h2>Agents need <em>budget</em></h2>
          <p>
            When AI agents try to interact with Web3, they get blocked by wallet
            prompts. You shouldn't have to stay online to click "Approve" for every
            single micro-transaction your agent performs.
          </p>
          <p>
            Reagent gives your AI a strict on-chain allowance. By delegating
            authority over a specific amount of USDC, the agent can execute
            complex strategies autonomously while you sleep.
          </p>
          <div className="quote-stat">
            <strong>0</strong>
            <span>manual wallet popups after the initial delegation</span>
          </div>
        </div>
      </section>

      <section className="section-pad" id="features">
        <div className="section-head">
          <p className="label">The Setup</p>
          <h2>Built for <em>autonomy</em></h2>
          <p>
            A smart account vault with programmable spending limits, ensuring
            your agent can never drain your wallet.
          </p>
        </div>

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

      <section className="cta section-pad" id="connect">
        <p className="label">Ready to start?</p>
        <h2>Unleash your <em>agent</em></h2>
        <p>
          Deploy a smart account. Delegate your budget. Let the AI work for you.
        </p>
        <div className="hero-actions">
          <Link className="button primary" to="/dashboard">Deploy Smart Account</Link>
        </div>
      </section>
    </main>
  );
}
