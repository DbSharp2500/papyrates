# Query Planner Integration Guide
# Add these snippets into research.html / research-gpt.html / research-gemini.html

## 1. Add the shared executor script (in <head> or before closing </body>)

<script src="/query-plan-executor.js"></script>

## 2. Inject the plan CSS once (paste into each portal's <style> block)

/* Paste contents of QueryPlanExecutor.PLAN_CSS here */
/* OR dynamically inject: */
const style = document.createElement('style');
style.textContent = QueryPlanExecutor.PLAN_CSS;
document.head.appendChild(style);


## 3. Add a plan panel container in the chat area (above the messages div)

<div id="plan-panel-container"></div>


## 4. Replace your existing search logic in handleSubmit / sendMessage
## ─────────────────────────────────────────────────────────────────
## FOR research.html (Claude portal):

async function getContextLetters(question) {
  // Step 1: Get the query plan from Claude
  const planResp = await fetch('/api/query-plan-claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  const { plan } = await planResp.json();

  // Step 2: Show the plan to the user
  const container = document.getElementById('plan-panel-container');
  QueryPlanExecutor.renderPlanPanel(plan, container, '🤖 Claude');

  // Step 3: Execute the plan against Supabase
  const { letters, sources } = await QueryPlanExecutor.runQueryPlan(plan, {
    supabaseUrl: SUPABASE_URL,       // your existing const
    supabaseKey: SUPABASE_ANON_KEY,  // your existing const
    embedFn: null,                   // set to your embed function if available
  });

  console.log('Query plan sources:', sources);
  return letters.slice(0, 30); // cap context size
}


## FOR research-gpt.html (GPT portal):
## Same as above but call /api/query-plan-gpt and label '🟢 GPT-4o'

async function getContextLetters(question) {
  const planResp = await fetch('/api/query-plan-gpt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  const { plan } = await planResp.json();

  const container = document.getElementById('plan-panel-container');
  QueryPlanExecutor.renderPlanPanel(plan, container, '🟢 GPT-4o');

  const { letters } = await QueryPlanExecutor.runQueryPlan(plan, {
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_ANON_KEY,
    embedFn: null,
  });
  return letters.slice(0, 30);
}


## FOR research-gemini.html (Gemini portal):
## Same but call /api/query-plan-gemini and label '✦ Gemini'

async function getContextLetters(question) {
  const planResp = await fetch('/api/query-plan-gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  const { plan } = await planResp.json();

  const container = document.getElementById('plan-panel-container');
  QueryPlanExecutor.renderPlanPanel(plan, container, '✦ Gemini');

  const { letters } = await QueryPlanExecutor.runQueryPlan(plan, {
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_ANON_KEY,
    embedFn: null,
  });
  return letters.slice(0, 30);
}


## 5. Wire into your existing send flow
## ─────────────────────────────────────
## Find where you currently call your search / embed functions and replace:

// BEFORE (old dumb search):
const letters = await semanticSearch(question, 30);

// AFTER (smart query plan):
const letters = await getContextLetters(question);

// Then pass letters to your AI call exactly as before:
const context = letters.map(l => `[Letter ${l.id}] ${l.title}\n${l.full_text?.slice(0, 500)}`).join('\n\n');


## 6. Confirm DB column names first (run in Supabase SQL editor)
## ─────────────────────────────────────────────────────────────
SELECT column_name FROM information_schema.columns WHERE table_name = 'manuscripts' ORDER BY ordinal_position;
SELECT column_name FROM information_schema.columns WHERE table_name = 'institutions' ORDER BY ordinal_position;
SELECT column_name FROM information_schema.columns WHERE table_name = 'letters' ORDER BY ordinal_position;
SELECT column_name FROM information_schema.columns WHERE table_name = 'people' ORDER BY ordinal_position;
## → Update query-plan-executor.js column names if they differ from what's assumed above.
