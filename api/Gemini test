// api/gemini-test.js — visit /api/gemini-test in your browser to see available models
export default async function handler(req, res) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  // Fetch list of available models
  const listRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`
  );
  const listData = await listRes.json();

  const models = (listData.models || [])
    .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
    .map(m => m.name); // e.g. "models/gemini-2.0-flash"

  // Try a tiny test call on each model to see which ones actually work
  const results = [];
  for (const modelPath of models.slice(0, 10)) {
    const modelName = modelPath.replace('models/', '');
    const testRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }],
          generationConfig: { maxOutputTokens: 5 }
        })
      }
    );
    results.push({
      model: modelName,
      status: testRes.status,
      ok: testRes.ok
    });
  }

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({ available: models, testResults: results });
}
