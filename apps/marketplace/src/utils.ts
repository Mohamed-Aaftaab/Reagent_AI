/**
 * Shared Groq AI retry helper for all marketplace endpoint handlers.
 * Handles HTTP 429 rate-limit and 5xx transient server errors with exponential backoff.
 */

// Fail fast at startup — all marketplace endpoints require GROQ_API_KEY.
// Without this guard, every Groq API call silently sends "Bearer undefined"
// until the first 401 error surfaces at request time (hard to debug).
if (!process.env.GROQ_API_KEY) {
  console.error("[marketplace] FATAL: GROQ_API_KEY is not set. Exiting.");
  process.exit(1);
}

// Per-attempt fetch timeout — prevents a hung Groq connection from freezing
// the marketplace for 2+ min per attempt (up to 6 min for 3 retries total).
const GROQ_FETCH_TIMEOUT_MS = 30_000;

export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3
): Promise<Response> {
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
    // Client errors (4xx) are not retried — they indicate bad input or auth issues.
    if (response.status === 429 || response.status >= 500) {
      const label =
        response.status === 429
          ? "Rate limit (429)"
          : `Server error (${response.status})`;
      console.warn(
        `[Groq] ${label}. Retrying in ${2 * (i + 1)}s... (attempt ${i + 1}/${retries})`
      );
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
      continue;
    }
    return response;
  }
  throw new Error("Max retries exceeded (rate limit or Groq server error).");
}
