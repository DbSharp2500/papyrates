// api/embed.js — Query embedding endpoint
// Converts a search query into a vector using Voyage AI
// Called by all three research portals for semantic search

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const VOYAGE_KEY = process.env.VOYAGE_API_KEY;
  if (!VOYAGE_KEY) return res.status(500).json({ error: 'VOYAGE_API_KEY not configured' });

  const { text } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text field required' });
  }

  try {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VOYAGE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        input: [text.slice(0, 4000)],
        model: 'voyage-large-2'   // same model used to embed the letters
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: `Voyage AI error: ${err}` });
    }

    const data = await response.json();
    const embedding = data.data?.[0]?.embedding;

    if (!embedding) {
      return res.status(500).json({ error: 'No embedding returned from Voyage AI' });
    }

    return res.status(200).json({ embedding });

  } catch (err) {
    console.error('embed.js error:', err);
    return res.status(500).json({ error: err.message });
  }
}
