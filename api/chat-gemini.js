// api/chat-gemini.js — Gemini research portal serverless function

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  try {
    const { messages, system } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }

    // Gemini requires strictly alternating user/model turns.
    // Merge consecutive same-role messages to be safe.
    const rawContents = messages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    const geminiContents = [];
    for (const turn of rawContents) {
      const last = geminiContents[geminiContents.length - 1];
      if (last && last.role === turn.role) {
        last.parts[0].text += '\n' + turn.parts[0].text;
      } else {
        geminiContents.push(turn);
      }
    }

    // Must start with a user turn
    if (geminiContents.length === 0 || geminiContents[0].role !== 'user') {
      return res.status(400).json({ error: 'Conversation must start with a user message' });
    }

    const requestBody = {
      contents: geminiContents,
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.7,
      }
    };

    if (system) {
      requestBody.systemInstruction = {
        parts: [{ text: system }]
      };
    }

    // Try models in order of preference
    const models = [
      'gemini-2.0-flash',
      'gemini-1.5-pro-latest',
      'gemini-1.5-flash',
    ];

    let lastError = null;
    for (const model of models) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const geminiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (geminiRes.ok) {
        const data = await geminiRes.json();
        const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        console.log(`Gemini responded using model: ${model}`);
        return res.status(200).json({ content, model });
      }

      const errText = await geminiRes.text();
      console.error(`Model ${model} failed (${geminiRes.status}):`, errText);
      lastError = `${model}: ${geminiRes.status} — ${errText}`;

      // Don't try fallbacks for auth errors
      if (geminiRes.status === 400 || geminiRes.status === 403) break;
    }

    return res.status(500).json({ error: `All Gemini models failed. Last error: ${lastError}` });

  } catch (err) {
    console.error('chat-gemini error:', err);
    return res.status(500).json({ error: err.message });
  }
}
