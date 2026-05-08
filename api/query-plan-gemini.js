export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { question } = req.body;
  if (!question) {
    return res.status(400).json({ error: 'Missing question' });
  }

  const systemPrompt = `You are a query planner for the Papyrates research database — a collection of 7,457 historical Arabic papyrus letters.

Available database tables:
- letters (7,457 rows): main table. Key columns: id, title, date, ocr_text, author_id, recipient_id, manuscript_id, institution_id, document_type
- people: id, first_name, last_name — named individuals (authors, recipients, mentioned persons)
- manuscripts: represents physical papyrus objects/collections
- institutions: libraries, archives, museums that hold the papyri

Your job: analyse the researcher's question and produce a retrieval plan.

Return ONLY valid JSON — no markdown, no backticks, no explanation outside the JSON. Schema:

{
  "reasoning": "2-3 sentences explaining what the question is asking and why you chose this strategy",
  "strategy": ["ordered", "list", "of", "steps"],
  "person_names": ["Full Name"],
  "manuscript_names": [],
  "institution_names": [],
  "keywords": ["word1", "word2"],
  "date_range": { "start": null, "end": null },
  "use_semantic": true,
  "use_keyword": true,
  "primary_focus": "person | manuscript | institution | theme | transaction | time_period | unknown"
}

Strategy steps must be chosen from:
- "person_lookup" — search people table by name, then get all letters linked to that person
- "manuscript_lookup" — search manuscripts table by name/id
- "institution_lookup" — search institutions table
- "date_filter" — filter letters by date range
- "keyword_search" — full-text keyword search on letter content
- "semantic_search" — vector similarity search on letter content
- "letter_by_id" — fetch a specific letter by id if the question mentions one

Always include semantic_search or keyword_search as a final fallback step.
Extract ALL person names mentioned in the question, even partial names.
Also include in person_names any well-known associates of the people mentioned — for example, if asked about a dealer, include known colleagues or institutional contacts if you know them.
Include in keywords any organisation names, place names, or object names relevant to the question.`;

  const GEMINI_MODELS = [
    'gemini-2.0-flash',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
  ];

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: question }] }],
    generationConfig: {
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
    },
  };

  let lastError = null;

  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.json();
        lastError = err.error?.message || `Gemini API error (${model})`;
        continue; // try next model
      }

      const data = await response.json();
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

      let plan;
      try {
        plan = JSON.parse(raw.replace(/```json|```/g, '').trim());
      } catch {
        return res.status(500).json({ error: 'Failed to parse plan JSON', raw });
      }

      return res.status(200).json({ plan, model: 'gemini', usedModel: model });
    } catch (err) {
      lastError = err.message;
    }
  }

  return res.status(500).json({ error: lastError || 'All Gemini models failed' });
}
