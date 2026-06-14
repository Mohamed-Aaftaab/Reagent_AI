/**
 * Groq LLM client — fast, free-tier inference via the Groq API.
 *
 * Uses the OpenAI-compatible endpoint at https://api.groq.com/openai/v1/
 * Model: llama-3.3-70b-versatile (fast, supports JSON schema output)
 *
 * Note: The product UI uses "AI" branding generically.
 * VENICE_API_KEY is reserved in .env for future Venice AI integration
 * once the paid tier is activated.
 */

const LLM_API = "https://api.groq.com/openai/v1/chat/completions";
const LLM_MODEL = "llama-3.3-70b-versatile";

// Fail fast at startup — do not silently make API calls with an empty key.
// Same pattern as AGENT_SESSION_KEY guard in x402-buyer.ts.
if (!process.env.GROQ_API_KEY) {
  console.error("[venice.ts] FATAL: GROQ_API_KEY is not set. Exiting.");
  process.exit(1);
}

// Per-attempt fetch timeout — prevents a hung Groq connection from freezing
// the task handler for 2+ min per attempt (up to 6 min for 3 retries total).
// 30s is generous for a typical LLM response start.
const GROQ_FETCH_TIMEOUT_MS = 30_000;

async function fetchWithRetry(url: string, options: any, retries = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    // Fresh AbortController per attempt — sharing one across retries would
    // abort all subsequent attempts the moment the first one times out.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GROQ_FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer); // Prevent timer leak whether fetch succeeds or throws
    }
    // Retry on 429 (rate-limit) AND 5xx (transient server errors).
    // Client errors (4xx) are not retried — they indicate bad input.
    if (response.status === 429 || response.status >= 500) {
      const label = response.status === 429 ? "Rate limit (429)" : `Server error (${response.status})`;
      console.warn(`[Groq] ${label}. Retrying in ${2 * (i + 1)}s... (attempt ${i + 1}/${retries})`);
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
      continue;
    }
    return response;
  }
  throw new Error("[Groq] Max retries exceeded (rate limit or server error).");
}

function authHeader(): string {
  return `Bearer ${process.env.GROQ_API_KEY ?? ""}`;
}

export async function planResearchTask(task: string) {
  const marketplaceBase = process.env.MARKETPLACE_URL || "http://127.0.0.1:4402";
  
  const response = await fetchWithRetry(LLM_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": authHeader(),
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{
        role: "system",
        content: `You are a lab research agent. Given a research task, decide which paid APIs to call and in what order. Available APIs:
          - POST ${marketplaceBase}/api/sequence-check ($0.01) — validate primer/probe sequences. Input schema: { "sequences": [ { "sequence": "string", "type": "string" } ], "organism": "human" }
          - POST ${marketplaceBase}/api/reagent-price ($0.005) — get reagent pricing. Input schema: { "reagents": [ "string" ], "vendor_preference": "any" }
          - POST ${marketplaceBase}/api/protocol-validate ($0.02) — validate lab protocol. Input schema: { "protocol_text": "string", "instrument": "string" }
          
          Respond ONLY with a STRICTLY valid JSON object matching this schema:
          { 
            "plan": [
              {
                "step": "number",
                "endpoint": "string",
                "reason": "string",
                "input": "object"
              }
            ],
            "total_cost_usd": "number",
            "synthesis_plan": "string"
          }`
      }, {
        role: "user",
        content: task
      }],
      response_format: { type: "json_object" },
    }),
  });

  const data = await response.json() as any;
  if (data.error) throw new Error(`[Groq] Planning error: ${JSON.stringify(data.error)}`);
  // Guard: Groq can return HTTP 200 with no choices[] when content is moderated
  // or when the request hits a quota limit (empty response body).
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`[Groq] Returned empty or missing choices. Full response: ${JSON.stringify(data).slice(0, 300)}`);
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`[Groq] Returned malformed JSON plan. Raw: ${content.slice(0, 200)}`);
  }
}

export async function synthesizeResults(task: string, results: any[]) {
  const response = await fetchWithRetry(LLM_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": authHeader(),
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{
        role: "system",
        content: "Synthesize these lab data results into a clear, professional research report. Output in markdown format. Start directly with the content — no preamble or greeting."
      }, {
        role: "user",
        content: `Task: ${task}\n\nResults:\n${JSON.stringify(results, null, 2)}`
      }],
    }),
  });

  const data = await response.json() as any;
  if (data.error) throw new Error(`[Groq] Synthesis error: ${JSON.stringify(data.error)}`);
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`[Groq] Synthesis returned empty response. Full: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return content;
}
