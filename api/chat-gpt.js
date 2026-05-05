// api/chat-gpt.js
// Serverless function that calls OpenAI GPT-4o.
// Mirrors api/chat.js so research-gpt.html can call it identically.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
  }

  const { model, max_tokens, system, messages } = req.body || {};

  // Build OpenAI messages array — system message goes as first message with role "system"
  const openaiMessages = [];
  if (system) {
    openaiMessages.push({ role: "system", content: system });
  }
  if (Array.isArray(messages)) {
    openaiMessages.push(...messages);
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model:      "gpt-4o",
        max_tokens: max_tokens || 4096,
        messages:   openaiMessages
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(502).json({ error: `OpenAI error: ${err}` });
    }

    const data = await response.json();

    // Reformat to match Anthropic response shape so research-gpt.html works identically
    const text = data?.choices?.[0]?.message?.content || "No response received.";
    return res.status(200).json({
      content: [{ type: "text", text }]
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
