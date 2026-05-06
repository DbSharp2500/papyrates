// api/chat-gemini.js — Gemini 1.5 Pro research portal serverless function
// Deploy to: /api/chat-gemini.js in your Vercel project

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  }

  try {
    const { messages, system } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }

    // Convert messages to Gemini format
    // Gemini uses 'user' and 'model' roles (not 'assistant')
    const geminiContents = messages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    const requestBody = {
      contents: geminiContents,
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.7,
      }
    };

    // Add system instruction if provided
    if (system) {
      requestBody.systemInstruction = {
        parts: [{ text: system }]
      };
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini API error:', errText);
      return res.status(geminiRes.status).json({ error: `Gemini API error: ${errText}` });
    }

    const data = await geminiRes.json();

    // Extract text from Gemini response
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    return res.status(200).json({ content });

  } catch (err) {
    console.error('chat-gemini error:', err);
    return res.status(500).json({ error: err.message });
  }
}
