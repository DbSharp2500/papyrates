// api/jim-gemini.js
// Jim-Gemini — Papyrates Research Specialist
//
// Architecture: Two-phase per message
//   Phase 1 (Plan)   — Ask Gemini which SQL queries are needed to answer the question.
//                       Returns a JSON array of SQL strings. No tools, no function calling.
//   Phase 2 (Answer) — Execute those queries server-side, inject results into context,
//                       ask Gemini for the full research response.
//
// This avoids all Gemini function-calling complexity entirely.

const GEMENI_API_KEY = process.env.GEMENI_API_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const MODEL          = 'gemini-2.5-flash';

const DB_HEADERS = {
  'apikey':        SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type':  'application/json',
};

// ── Database ───────────────────────────────────────────────────────────────────
async function sql(query) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/execute_research_query`, {
      method:  'POST',
      headers: DB_HEADERS,
      body:    JSON.stringify({ query_text: query }),
    });
    const text = await r.text();
    if (!r.ok) return `[DB error ${r.status}: ${text.slice(0, 300)}]`;
    return text;
  } catch (e) {
    return `[DB error: ${e.message}]`;
  }
}

// ── Startup context ────────────────────────────────────────────────────────────
async function loadStartupContext() {
  const [corrections, memories, counts] = await Promise.all([
    sql('SELECT * FROM researcher_knowledge'),
    sql('SELECT * FROM gemini_memory ORDER BY created_at DESC'),
    sql('SELECT entity_type, COUNT(*) as count FROM dossiers GROUP BY entity_type'),
  ]);
  return `=== STARTUP CONTEXT ===
RESEARCHER CORRECTIONS (always authoritative — override training and memory):
${corrections}

GEMINI MEMORY (prior session findings — apply only if topically relevant):
${memories}

DOSSIER COUNTS:
${counts}
=== END STARTUP CONTEXT ===`;
}

// ── Call Gemini (simple, no tools) ────────────────────────────────────────────
async function callGemini(systemText, contents) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMENI_API_KEY}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemText }] },
        contents,
        generationConfig: { temperature: 0.7 },
      }),
    }
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `Gemini error ${r.status}`);
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.filter(p => p.text).map(p => p.text).join('\n');
}

// ── Phase 1: Plan — ask Gemini which queries it needs ─────────────────────────
async function planQueries(userQuestion, conversationHistory) {
  const historyText = conversationHistory
    .map(m => `${m.role === 'user' ? 'Researcher' : 'Jim'}: ${(m.parts || []).map(p => p.text || '').join(' ')}`)
    .join('\n');

  const planSystem = `You are a SQL query planner for the Papyrates manuscript research database.

CRITICAL OUTPUT RULE: Your ENTIRE response must be ONLY a raw JSON array.
- Start your response with [ and end with ]
- No explanation. No markdown. No code fences. No other text whatsoever.
- CORRECT:   ["SELECT id, name FROM people WHERE name ILIKE '%kasser%'"]
- INCORRECT: Here are the queries: \`\`\`json ["SELECT..."] \`\`\`

DATABASE SCHEMA:
- dossiers: entity_type, entity_id, canonical_name, content, researcher_notes, contradiction_count, source_document_count, generated_at
- letters: id, title, full_text, author_name, recipient_name, date_of_letter, language, description, translation, sharing_link, updated_at
- people: id, name
- manuscripts: id, canonical_name
- letter_people: person_id, letter_id
- letter_manuscripts: manuscript_id, letter_id
- researcher_knowledge: id, topic, assertion, confidence
- gemini_memory: id, topic, content, created_at
- open_research_questions: id, question, topic, context, status, created_at
- contradictions: id, topic, standard_account, database_shows, source_documents, confidence, created_at
- research_sessions: id, ai_model, session_date, topic, research_question, summary, key_findings, document_ids

QUERY RULES:
- Maximum 5 queries. Use ILIKE with '%term%' wildcards.
- For any research question about a topic, search: dossiers (content ILIKE), letters (full_text ILIKE), contradictions, open_research_questions
- For people: SELECT id, name FROM people WHERE name ILIKE '%term%' first, then fetch their dossier
- For manuscripts: SELECT id, canonical_name FROM manuscripts WHERE canonical_name ILIKE '%term%'
- For session startup / greeting messages only: return []
- For ALL substantive research questions: return at least 2–3 queries`;

  const planContents = [{
    role: 'user',
    parts: [{ text: `Previous conversation:\n${historyText}\n\nCurrent question: ${userQuestion}\n\nReturn ONLY the JSON array (start with [, end with ]).` }],
  }];

  try {
    const raw = await callGemini(planSystem, planContents);
    // Strip thinking blocks and markdown fences before extracting JSON
    const stripped = raw
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .replace(/```[a-z]*\n?/gi, '')
      .replace(/```/g, '')
      .trim();
    const match = stripped.match(/\[[\s\S]*\]/);
    if (!match) return [];
    return JSON.parse(match[0]);
  } catch {
    return [];
  }
}

// ── System prompt for Phase 2 ──────────────────────────────────────────────────
const JIM_SYSTEM = `Your name is Jim. You are a manuscript provenance specialist with deep expertise in ancient manuscripts, the 20th-21st century manuscript trade, and the history of papyrus and codex collections.

## Governing Epistemological Principle
Your prior knowledge is a hypothesis to be tested against the documents, not a baseline to defend. The Papyrates database contains primary source documents — correspondence, financial records, unpublished letters — largely new to scholarship. When your training contradicts the database:
1. Flag the conflict explicitly: state what published scholarship says vs. what the documents show
2. Prioritize the database
3. Treat the conflict as a finding

## Session Startup
You will be given a STARTUP CONTEXT block with researcher corrections and prior memory. Apply corrections as authoritative. Apply memory only if topically relevant. Report: "Database live: [N] person dossiers, [N] manuscript dossiers. [N] corrections, [N] memory entries loaded." Then wait for the question.

## Database Access — CRITICAL RULES
The system automatically runs SQL queries and injects results into your context before every response. You have full database access. You must NEVER ask the researcher to provide query results, run queries, or supply data themselves.

- If DATABASE QUERY RESULTS appear above: reason over them carefully. Cite documents inline as [Doc 1234]. Include sharing_link URLs when available as clickable links.
- If no DATABASE QUERY RESULTS appear: the system determined no queries were needed, OR the queries returned empty results. State clearly what the database showed (or did not show), then supplement from your knowledge. Do NOT ask the researcher to provide data.

## Memory and End of Session
Never write to gemini_memory autonomously. When the researcher types "done", present:
  MEMORIES TO SAVE: [numbered list]
  OPEN QUESTIONS TO SAVE: [lettered list]
  CONTRADICTIONS TO SAVE: [roman numerals]
State each category even if empty. After approval write to the database. Tell researcher to type "exit" when finished.

## Output Format
Use markdown: **bold**, ## headers, bullet points. Section headers: Summary | Analysis | Source Documents | Open Questions | Contradictions.`;

// ── Main handler ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!GEMENI_API_KEY) return res.status(500).json({ error: 'GEMENI_API_KEY not set in Vercel environment variables' });

  const { messages, loadStartup } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'No messages provided' });

  // Get the user's latest message
  const lastMessage   = messages[messages.length - 1];
  const userQuestion  = (lastMessage.parts || []).map(p => p.text || '').join(' ');
  const priorMessages = messages.slice(0, -1);

  // ── Load startup context on first message ──────────────────────────────────
  let startupContext = '';
  if (loadStartup) {
    startupContext = await loadStartupContext();
  }

  // ── Phase 1: Plan queries ──────────────────────────────────────────────────
  let queryResultsText = '';
  const queries = await planQueries(userQuestion, priorMessages);

  if (queries.length > 0) {
    const results = await Promise.all(
      queries.slice(0, 6).map(async q => {
        const result = await sql(q);
        return `SQL: ${q}\nRESULT: ${result}`;
      })
    );
    queryResultsText = `\n\n=== DATABASE QUERY RESULTS ===\n${results.join('\n\n')}\n=== END QUERY RESULTS ===`;
  }

  // ── Phase 2: Answer ────────────────────────────────────────────────────────
  const systemText = JIM_SYSTEM
    + (startupContext ? '\n\n' + startupContext : '')
    + queryResultsText;

  let responseText;
  try {
    responseText = await callGemini(systemText, messages);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Append Jim's response to history
  const updatedMessages = [
    ...messages,
    { role: 'model', parts: [{ text: responseText }] },
  ];

  return res.status(200).json({ text: responseText, messages: updatedMessages });
}
