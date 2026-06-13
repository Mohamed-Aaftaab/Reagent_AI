import { Link } from "react-router-dom";

export function Footer() {
  return (
    <footer className="site-footer">
      <div>
        <p className="footer-brand">Reagent</p>
        <span>Autonomous AI agents powered by Smart Accounts.</span>
      </div>
      <div>
        <p>App</p>
        <Link to="/dashboard">Agent Chat</Link>
        <Link to="/features">Features</Link>
        <Link to="/timeline">Roadmap</Link>
      </div>
      <div>
        <p>Built with</p>
        <a href="https://base.org" target="_blank" rel="noreferrer">Base Sepolia</a>
        <a href="https://metamask.io" target="_blank" rel="noreferrer">MetaMask Smart Accounts</a>
        <a href="https://groq.com" target="_blank" rel="noreferrer">Llama 3.3 (Groq)</a>
      </div>
      <div>
        <p>Project</p>
        <span>AI Delegation Toolkit</span>
        <span>Testnet-ready concept</span>
      </div>
    </footer>
  );
}
