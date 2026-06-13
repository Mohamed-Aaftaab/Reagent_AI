import type { Request, Response } from "express";
import { fetchWithRetry } from "../utils.js";

export async function protocolValidateHandler(req: Request, res: Response): Promise<void> {
  const { protocol_text, instrument } = req.body;

  if (!protocol_text || typeof protocol_text !== "string") {
    res.status(400).json({ error: "Missing or invalid protocol_text — must be a non-empty string" });
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
          content: `You are a lab protocol validator. Analyze the protocol for:
            1. Ambiguous terms ("gently", "overnight", "until clear")
            2. Missing parameters (volumes, temperatures, durations)
            3. Instrument compatibility with ${instrument || 'unspecified instrument'}
            4. Safety issues
            Respond ONLY with JSON matching this schema:
            {
              "validation": {
                "status": "PASS|WARNINGS|FAIL",
                "total_issues": "number",
                "errors": [{"line":"string", "issue":"string"}],
                "warnings": [
                  {
                    "line": "string",
                    "issue": "string",
                    "suggestion": "string",
                    "severity": "low|medium|high",
                    "category": "string"
                  }
                ],
                "resolved_protocol": {
                   "instrument": "string",
                   "steps": [
                      {"step": "number", "action": "string", "details": "object or string"}
                   ]
                },
                "instrument_compatible": "boolean",
                "notes": "string",
                "missing_from_original": ["string"]
              }
            }`
        }, {
          role: "user",
          content: protocol_text
        }],
        response_format: { type: "json_object" },
      }),
    });

    const data = await groq.json() as any;
    if (data.error) {
       console.error("[protocol-validate] Groq API Error:", data.error);
       res.status(500).json({ error: "Groq API error" });
       return;
    }
    // Guard: Groq returns HTTP 200 with no choices[] on content moderation or quota exhaustion.
    // Without this check data.choices[0] throws TypeError and crashes the handler.
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.error("[protocol-validate] Groq returned empty/missing choices:", JSON.stringify(data).slice(0, 300));
      res.status(502).json({ error: "Groq returned empty response" });
      return;
    }
    let validation: any;
    try {
      validation = JSON.parse(content);
    } catch {
      console.error("[protocol-validate] Groq returned non-JSON content:", content.slice(0, 300));
      res.status(502).json({ error: "Groq returned malformed JSON", raw: content.slice(0, 300) });
      return;
    }
    res.json(validation);
  } catch (err) {
    console.error("Error in protocol validate:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
