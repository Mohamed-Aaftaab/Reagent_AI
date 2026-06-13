import type { Request, Response } from "express";
import { fetchWithRetry } from "../utils.js";

export async function sequenceCheckHandler(req: Request, res: Response): Promise<void> {
  const { sequences, organism } = req.body;

  if (!sequences || !Array.isArray(sequences) || sequences.length === 0) {
    res.status(400).json({ error: "Missing or empty sequences array" });
    return;
  }

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
          content: `You are a bioinformatics assistant. Analyze the following primer sequences for Tm, GC%, hairpin risk, self-dimer dG, and off-target hits. Respond ONLY with a JSON object matching this exact schema:
            {
              "results": [
                {
                  "name": "string",
                  "sequence": "string",
                  "length": "number",
                  "tm_celsius": "number",
                  "gc_percent": "number",
                  "hairpin_risk": "none|low|medium|high",
                  "self_dimer_dG_kcal": "number",
                  "off_target_hits": "number",
                  "verdict": "PASS|WARNING|FAIL",
                  "warnings": ["string"]
                }
              ],
              "pair_analysis": {
                "PAIR_NAME": {
                  "tm_difference": "number",
                  "verdict": "EXCELLENT|GOOD|POOR",
                  "note": "string"
                }
              },
              "cross_pair_note": "string"
            }`
        }, {
          role: "user",
          content: JSON.stringify({ sequences, organism })
        }],
        response_format: { type: "json_object" },
      }),
    });

    const data = await groq.json() as any;
    if (data.error) {
       console.error("[sequence-check] Groq API Error:", data.error);
       res.status(500).json({ error: "Groq API error" });
       return;
    }
    // Guard: Groq returns HTTP 200 with no choices[] on content moderation or quota exhaustion.
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.error("[sequence-check] Groq returned empty/missing choices:", JSON.stringify(data).slice(0, 300));
      res.status(502).json({ error: "Groq returned empty response" });
      return;
    }
    let validation: any;
    try {
      validation = JSON.parse(content);
    } catch {
      console.error("[sequence-check] Groq returned non-JSON content:", content.slice(0, 300));
      res.status(502).json({ error: "Groq returned malformed JSON", raw: content.slice(0, 300) });
      return;
    }
    res.json(validation);
  } catch (err) {
    console.error("Error in sequence check:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
