import { Link } from "react-router-dom";
import { OneShotStatus } from "./OneShotStatus";

export function NavBar() {
  return (
    <header className="site-header">
      <nav className="nav-shell" aria-label="Primary navigation">
        <Link className="brand" to="/" aria-label="Reagent home">
          <span className="brand-mark" aria-hidden="true"></span>
          <span>Reagent</span>
        </Link>

        <div className="nav-links" aria-label="Page sections">
          <Link to="/dashboard">Agent</Link>
          <Link to="/features">Features</Link>
          <Link to="/how-it-works">How it works</Link>
          <Link to="/timeline">Roadmap</Link>
        </div>

        <div className="nav-actions">
          <OneShotStatus />
          <span className="network-pill"><span></span>Testnet Live</span>
          <Link className="button secondary compact" to="/dashboard">Dashboard</Link>
        </div>
      </nav>
    </header>
  );
}
