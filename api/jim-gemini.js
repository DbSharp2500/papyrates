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
const SUPABASE_URL   = 'https://vzfwobsnfqnnqvnsfksq.supabase.co';
const SUPABASE_KEY   = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6ZndvYnNuZnFubnF2bnNma3NxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Njg4ODA3MCwiZXhwIjoyMDkyNDY0MDcwfQ.J_TE4qWj9r6TIvGeptM58r2WtI6ytOe9zg7BBe29wHI';
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
Your only job is to return a JSON array of SQL SELECT queries needed to answer the researcher's question.

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

RULES:
- Return ONLY a valid JSON array of SQL strings. Nothing else. No explanation.
- Maximum 6 queries.
- Use ILIKE for name searches. Use '%term%' wildcards.
- Bodmer manuscript names follow format: 'bodmer PB X / TM XXXXX'
- For people searches always start with: SELECT id, name FROM people WHERE name ILIKE '%term%'
- For dossiers use: SELECT content, researcher_notes, contradiction_count, source_document_count, generated_at FROM dossiers WHERE entity_type='person' AND entity_id=X
- If no database queries are needed return: []`;

  const planContents = [{
    role: 'user',
    parts: [{ text: `Previous conversation:\n${historyText}\n\nCurrent question: ${userQuestion}\n\nReturn the JSON array of queries needed.` }],
  }];

  try {
    const raw = await callGemini(planSystem, planContents);
    const match = raw.match(/\[[\s\S]*\]/);
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

## Database Results
When DATABASE QUERY RESULTS are provided in the context, reason over them carefully. Cite documents inline as [Doc 1234]. Include sharing_link URLs when available as clickable links.

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
