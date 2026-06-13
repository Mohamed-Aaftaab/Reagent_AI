import { BrowserRouter, Routes, Route } from "react-router-dom";
import { NavBar } from "./components/NavBar";
import { Footer } from "./components/Footer";
import { BackgroundCanvas } from "./components/BackgroundCanvas";

import { Landing } from "./pages/Landing";
import { Dashboard } from "./pages/Dashboard";
import { Features } from "./pages/Features";
import { HowItWorks } from "./pages/HowItWorks";
import { Timeline } from "./pages/Timeline";

export default function App() {
  // WebSocket lifecycle is managed by Dashboard.tsx — only opens when user
  // is on the /dashboard route, not on every page visit.
  return (
    <BrowserRouter>
      <BackgroundCanvas />
      <NavBar />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/features" element={<Features />} />
        <Route path="/how-it-works" element={<HowItWorks />} />
        <Route path="/timeline" element={<Timeline />} />
      </Routes>
      <Footer />
    </BrowserRouter>
  );
}
