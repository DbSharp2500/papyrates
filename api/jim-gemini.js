// api/jim-gemini.js
// Jim-Gemini — Papyrates Research Specialist, Vercel serverless endpoint
// Handles one conversation turn: receives history, calls Gemini with
// function calling, executes Supabase queries as needed, returns final text.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyAzkkwLHxP7KZUUSsh1-BrhBkpA7BDLsII';
const SUPABASE_URL   = 'https://vzfwobsnfqnnqvnsfksq.supabase.co';
const SUPABASE_KEY   = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6ZndvYnNuZnFubnF2bnNma3NxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Njg4ODA3MCwiZXhwIjoyMDkyNDY0MDcwfQ.J_TE4qWj9r6TIvGeptM58r2WtI6ytOe9zg7BBe29wHI';
const MODEL          = 'gemini-2.5-flash';

const DB_HEADERS = {
  'apikey':        SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type':  'application/json',
};

// ── Database helper ────────────────────────────────────────────────────────────
async function queryDatabase(sql) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/execute_research_query`, {
      method: 'POST',
      headers: DB_HEADERS,
      body: JSON.stringify({ query_text: sql }),
    });
    const text = await r.text();
    if (!r.ok) return `Query error ${r.status}: ${text.slice(0, 500)}`;
    return text; // already JSON string
  } catch (e) {
    return `Query error: ${e.message}`;
  }
}

// ── Startup context (loaded fresh each session open) ──────────────────────────
async function buildStartupContext() {
  const [corrections, memories, counts] = await Promise.all([
    queryDatabase('SELECT * FROM researcher_knowledge'),
    queryDatabase('SELECT * FROM gemini_memory ORDER BY created_at DESC'),
    queryDatabase('SELECT entity_type, COUNT(*) as count FROM dossiers GROUP BY entity_type'),
  ]);
  return `=== DATABASE STARTUP CONTEXT ===

RESEARCHER CORRECTIONS (authoritative — override training, dossiers, and memory):
${corrections}

GEMINI MEMORY (findings from previous sessions — apply only if topically relevant):
${memories}

DOSSIER COUNTS:
${counts}

=== END STARTUP CONTEXT ===`;
}

// ── System prompt ──────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Your name is Jim. Introduce yourself as Jim at the start of each session.

You are a manuscript provenance specialist with deep expertise in ancient manuscripts,
the 20th–21st century manuscript trade, and the history of papyrus and codex
collections. Bring your full training knowledge to every session.

## Governing Epistemological Principle

Your prior knowledge is a hypothesis to be tested against the documents, not a
baseline to defend. Your training reflects published scholarship — secondary sources.
The Papyrates database consists of primary source documents (correspondence, financial
records, unpublished letters) that are largely new to scholarship.

When training knowledge contradicts the database:
1. Flag the conflict explicitly
2. Prioritize the database — primary sources outweigh secondary literature
3. Treat the conflict as a finding

## Session Startup

You are given a STARTUP CONTEXT block containing researcher corrections and Gemini
memory loaded from the database. Apply researcher corrections as authoritative.
Apply memory only if topically relevant.

Report one line: "Database live: [N] person dossiers, [N] manuscript dossiers.
[N] researcher corrections, [N] memory entries loaded." Then wait for the question.

## Query Discipline

Always use query_database to retrieve data. Never guess database contents.

Standard workflow:
1. Dossiers first: SELECT content, researcher_notes, contradiction_count,
   source_document_count, generated_at FROM dossiers WHERE entity_type='person' AND entity_id=X;
2. Post-dossier update check using generated_at date
3. Find entities: SELECT id, name FROM people WHERE name ILIKE '%term%';
   SELECT id, canonical_name FROM manuscripts WHERE canonical_name ILIKE '%term%';

Bodmer canonical names: 'bodmer PB X / TM XXXXX'

## Memory Management

Never write to gemini_memory autonomously. When the researcher types "done",
present the end-of-session proposal list:
  MEMORIES TO SAVE: [numbered]
  OPEN QUESTIONS TO SAVE: [lettered]
  CONTRADICTIONS TO SAVE: [roman numerals]
State each category explicitly even if empty. After researcher approves items,
write them to the database. Tell them to type "exit" when finished.

## Output Format

Use clear section headers: Summary | Analysis | Source Documents | Open Questions | Contradictions
Cite documents inline as [Doc 1234]. Include sharing_link URLs when available.
Format responses with markdown — use **bold**, headers, and bullet points.

## Database Schema

dossiers: entity_type, entity_id, canonical_name, content, researcher_notes,
          contradiction_count, source_document_count, generated_at
letters: id, title, full_text, author_name, recipient_name, date_of_letter,
         language, description, translation, sharing_link, updated_at
people: id, name | manuscripts: id, canonical_name
letter_people: person_id, letter_id | letter_manuscripts: manuscript_id, letter_id
researcher_knowledge: id, topic, assertion, confidence
gemini_memory: id, topic, content, created_at
open_research_questions: id, question, topic, context, status, created_at
contradictions: id, topic, standard_account, database_shows, source_documents, confidence, created_at
research_sessions: id, ai_model, session_date, topic, research_question, summary,
                   key_findings, open_questions, contradictions_found, document_ids, output_file_url`;

// ── Gemini tool declaration ────────────────────────────────────────────────────
const TOOLS = [{
  functionDeclarations: [{
    name: 'query_database',
    description: 'Execute a SQL SELECT or INSERT query against the Papyrates research database. Returns results as JSON.',
    parameters: {
      type: 'OBJECT',
      properties: {
        sql: { type: 'STRING', description: 'The SQL query to execute' },
      },
      required: ['sql'],
    },
  }],
}];

// ── Handler ────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, loadStartup } = req.body;

  // Build system instruction — include startup context on first message
  let systemText = SYSTEM_PROMPT;
  if (loadStartup) {
    const ctx = await buildStartupContext();
    systemText = SYSTEM_PROMPT + '\n\n' + ctx;
  }

  let contents = [...messages];

  // Function calling loop — max 10 iterations
  for (let i = 0; i < 10; i++) {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemText }] },
          contents,
          tools: TOOLS,
          generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );

    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      return res.status(500).json({ error: data.error?.message || 'Gemini API error' });
    }

    const candidate = data.candidates?.[0];
    if (!candidate) return res.status(500).json({ error: 'No response from Gemini' });

    const modelContent = candidate.content;
    const fnCalls = (modelContent.parts || []).filter(p => p.functionCall);

    if (fnCalls.length === 0) {
      // Final text response
      const text = (modelContent.parts || []).filter(p => p.text).map(p => p.text).join('\n');
      const updatedMessages = [...contents, modelContent];
      return res.status(200).json({ text, messages: updatedMessages });
    }

    // Execute function calls
    contents.push(modelContent);
    const fnResponseParts = await Promise.all(
      fnCalls.map(async part => {
        const { name, args } = part.functionCall;
        const result = name === 'query_database'
          ? await queryDatabase(args.sql)
          : 'Unknown function';
        return { functionResponse: { name, response: { result } } };
      })
    );
    contents.push({ role: 'user', parts: fnResponseParts });
  }

  return res.status(500).json({ error: 'Function call loop exceeded maximum iterations' });
}
