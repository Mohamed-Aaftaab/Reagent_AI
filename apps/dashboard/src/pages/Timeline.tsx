import { Link } from "react-router-dom";

export function Timeline() {
  return (
    <main className="page-main">
      <section className="page-hero">
        <p className="eyebrow"><span></span>Roadmap</p>
        <h1>Building the <em>future</em></h1>
        <p>Reagent is an ongoing project to bridge the gap between AI autonomy and on-chain security. Here is our roadmap for the hackathon and beyond.</p>
        <div className="page-actions">
          <Link className="button primary" to="/dashboard">Try Reagent</Link>
        </div>
      </section>

      <section className="timeline section-pad">
        <div className="timeline-panel" style={{ maxWidth: '900px', margin: '0 auto' }}>
          <div>
            <p className="label">Project Milestones</p>
            <h2>From hackathon to mainnet</h2>
            <p>
              Our primary goal is to establish a secure framework where users can
              confidently hand over partial wallet control to an AI agent.
            </p>
          </div>
          <ol>
            <li><span>Phase 1</span> Smart Accounts & Delegation integration (Base Sepolia)</li>
            <li><span>Phase 2</span> Agent conversational interface and planning</li>
            <li><span>Phase 3</span> 1Shot API for sponsored gasless transactions</li>
            <li><span>Phase 4</span> Custom NLP intent parsing for multi-step swaps</li>
          </ol>
        </div>
      </section>
    </main>
  );
}
