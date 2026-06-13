import type { Request, Response } from "express";
import { fetchWithRetry } from "../utils.js";

export async function reagentPriceHandler(req: Request, res: Response): Promise<void> {
  const { reagents, vendor_preference } = req.body;

  if (!reagents || !Array.isArray(reagents) || reagents.length === 0) {
    res.status(400).json({ error: "Missing or empty reagents array" });
    return;
  }

  // try block was accidentally removed during a prior edit — restored here
  try {
    const groq = await fetchWithRetry("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{
          role: "system",
          content: `You are a lab procurement assistant. Provide realistic pricing and stock status for the requested reagents. Vendor preference: ${vendor_preference || 'any'}.
            Respond ONLY with a JSON object matching this schema:
            {
              "quotes": [
                {
                  "name": "string",
                  "catalog_number": "string",
                  "vendor": "string",
                  "unit_price_usd": "number",
                  "unit_size": "string",
                  "in_stock": "boolean",
                  "lead_time_business_days": "number",
                  "note": "string"
                }
              ],
              "total_estimated_usd": "number",
              "recommendation": "string",
              "queried_at": "string (ISO datetime)"
            }`
        }, {
          role: "user",
          content: JSON.stringify({ reagents })
        }],
        response_format: { type: "json_object" },
      }),
    });

    const data = await groq.json() as any;
    if (data.error) {
       console.error("[reagent-price] Groq API Error:", data.error);
       res.status(500).json({ error: "Groq API error" });
       return;
    }
    // Guard: Groq returns HTTP 200 with no choices[] on content moderation or quota exhaustion.
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.error("[reagent-price] Groq returned empty/missing choices:", JSON.stringify(data).slice(0, 300));
      res.status(502).json({ error: "Groq returned empty response" });
      return;
    }
    let quotes: any;
    try {
      quotes = JSON.parse(content);
    } catch {
      console.error("[reagent-price] Groq returned non-JSON content:", content.slice(0, 300));
      res.status(502).json({ error: "Groq returned malformed JSON", raw: content.slice(0, 300) });
      return;
    }
    res.json(quotes);
  } catch (err) {
    console.error("Error in reagent price:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
