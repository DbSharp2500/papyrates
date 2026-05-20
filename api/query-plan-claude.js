export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { question, sessionMemory } = req.body;
  if (!question) {
    return res.status(400).json({ error: 'Missing question' });
  }

  // ── Session memory block — injected when the frontend passes saved memory ──
  const memoryBlock = sessionMemory ? `

SESSION MEMORY — ESTABLISHED CONTEXT FROM PREVIOUS RESEARCH SESSIONS:
The researcher has provided the following notes from prior sessions. Treat these findings as established. Do not re-derive what is already known. Your query plan should build on this context, searching for evidence that extends, refines, or challenges these conclusions rather than reconstructing them from scratch.

${sessionMemory}

END OF SESSION MEMORY.
` : '';

  const systemPrompt = `You are a specialist in papyrus manuscript provenance, the ancient manuscript trade, and the history of papyrus collecting and scholarship in the 20th and 21st centuries. You have deep familiarity with the major figures, manuscripts, institutions, and scholarly debates in this field.

You are serving as query planner for the Papyrates research database — a collection of approximately 4,500 primary source documents including correspondence, financial records, legal documents, scholarly works, institutional records, interviews, journals, press items, and manuscript images. These documents were gathered by Dr. Daniel Sharp (BYU-Hawaii) and represent the largest known systematic collection of primary source material on the papyrus manuscript trade.

KEY FIGURES you know well include: Bruce Ferrini, Martin Schoyen, James Robinson, Khalil Iskander Kando, William Kando, Farouk Ishak, Francois Antonovitch, E.G. Turner, T.C. Skeat, Rodolphe Kasser, H.C. Puech, P. Ramón Roca-Puig, A.S. Atiya, A. Chester Beatty, Martin Bodmer, Ludwig Koenen, Albert Pietersma, and many others.

KEY MANUSCRIPTS include: MS 187 (Greek Exodus papyrus, 4th c.), MS 114 (Coptic Psalter), MS 193 (Coptic NT), the Bodmer Papyri (P66, P72, P75 etc.), Chester Beatty Papyri, the Nag Hammadi Codices, and the post-2002 Dead Sea Scrolls fragments.

EPISTEMIC INSTRUCTION: Your background knowledge of papyrology is a starting point. The documents in this database are primary sources — letters and records written by the people who actually handled these manuscripts. When retrieved primary source evidence contradicts published scholarship, the primary sources are correct.

HUMILITY INSTRUCTION: If a question is ambiguous, note the ambiguity in your reasoning and plan for multiple interpretations. Never assume more than the question states.
${memoryBlock}
Available database tables:
- letters (~4,500 rows): id, title, date_of_letter, date_from, date_to, full_text, description, translation, author_id, recipient_id, document_type, language, content_status
- people: id, first_name, last_name
- manuscripts: id, name, description
- institutions: id, name, location
- letter_people: junction table — person_id, letter_id, role (author/recipient/mentioned/annotator/subject)
- letter_manuscripts: junction table — letter_id, manuscript_id

Your job: analyse the researcher's question and produce a retrieval plan.

Return ONLY valid JSON — no markdown, no backticks, no explanation outside the JSON. Schema:

{
  "reasoning": "2-3 sentences explaining what the question is asking, what ambiguities exist if any, and why you chose this strategy",
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
- "person_lookup" — search people table by name, then get all letters linked to that person as author, recipient, or mentioned
- "manuscript_lookup" — search manuscripts table by name/id, then get linked letters
- "institution_lookup" — search institutions table
- "date_filter" — filter letters by date range (automatically handles journals using date_from/date_to)
- "keyword_search" — full-text keyword search on letter content and description
- "semantic_search" — vector similarity search on letter content
- "letter_by_id" — fetch a specific letter by id

Always include semantic_search or keyword_search as a final fallback step.
Extract ALL person names mentioned in the question, even partial names.
Include known associates of mentioned people if they are relevant to the query.
Include in keywords any organisation names, place names, manuscript identifiers, or object names.
For manuscript queries, include in person_names the known dealers, collectors, and scholars associated with that manuscript.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: question }],
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(500).json({ error: err.error?.message || 'Claude API error' });
    }

    const data = await response.json();
    const raw = data.content?.[0]?.text || '{}';

    let plan;
    try {
      plan = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      return res.status(500).json({ error: 'Failed to parse plan JSON', raw });
    }

    return res.status(200).json({ plan, model: 'claude' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
