import { spawn } from "child_process";

console.log("Starting Reagent Backend Cluster...");

const agent = spawn("npx", ["tsx", "apps/agent/src/index.ts"], { stdio: "inherit" });
const marketplace = spawn("npx", ["tsx", "apps/marketplace/src/index.ts"], { 
  stdio: "inherit",
  env: { ...process.env, PORT: "4402" } // Force internal port so it doesn't collide with Render's external PORT
});

function handleExit(signal) {
  console.log(`Received ${signal}. Shutting down cluster...`);
  agent.kill(signal);
  marketplace.kill(signal);
  process.exit();
}

process.on("SIGINT", () => handleExit("SIGINT"));
process.on("SIGTERM", () => handleExit("SIGTERM"));
