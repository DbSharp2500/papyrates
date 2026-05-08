/**
 * query-plan-executor.js
 * Shared frontend module used by research.html, research-gpt.html, research-gemini.html
 *
 * Usage:
 *   import { runQueryPlan } from './query-plan-executor.js';
 *   const results = await runQueryPlan(plan, { supabaseUrl, supabaseKey, embedFn });
 *
 * Or include as a <script> tag — exposes window.QueryPlanExecutor
 */

const QueryPlanExecutor = (() => {

  /**
   * Main entry point.
   * @param {Object} plan         - JSON plan returned by a query-plan-*.js endpoint
   * @param {Object} opts
   * @param {string} opts.supabaseUrl
   * @param {string} opts.supabaseKey
   * @param {Function} opts.embedFn  - async (text) => Float32Array  (calls /api/embed)
   * @returns {Promise<{ letters: Array, sources: Object }>}
   */
  async function runQueryPlan(plan, { supabaseUrl, supabaseKey, embedFn }) {
    const headers = {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
    };

    const letterMap = new Map(); // id → letter object, deduplicates across strategies
    const sources = {};          // strategy step → count of results

    for (const step of plan.strategy) {
      try {
        switch (step) {

          case 'person_lookup': {
            if (!plan.person_names?.length) break;
            for (const name of plan.person_names) {
              const parts = name.trim().split(/\s+/);
              const firstName = parts[0] || '';
              const lastName = parts.slice(1).join(' ') || '';

              // Search people table
              let query = `${supabaseUrl}/rest/v1/people?select=id,first_name,last_name`;
              if (firstName) query += `&first_name=ilike.*${encodeURIComponent(firstName)}*`;
              if (lastName)  query += `&last_name=ilike.*${encodeURIComponent(lastName)}*`;
              query += '&limit=10';

              const pResp = await fetch(query, { headers });
              const people = await pResp.json();
              if (!Array.isArray(people) || !people.length) break;

              // Fetch letters linked to each person found
              for (const person of people) {
                const pid = person.id;
                const personLabel = `${person.first_name || ''} ${person.last_name || ''}`.trim();

                // 1. Letters where person is author or recipient (FK lookup)
                const lResp = await fetch(
                  `${supabaseUrl}/rest/v1/letters?select=id,title,date_of_letter,document_type,full_text,author_id,recipient_id&or=(author_id.eq.${pid},recipient_id.eq.${pid})&limit=50`,
                  { headers }
                );
                const letters = await lResp.json();
                if (Array.isArray(letters)) {
                  letters.forEach(l => {
                    if (!letterMap.has(l.id)) letterMap.set(l.id, { ...l, _sources: [], _score: null });
                    letterMap.get(l.id)._sources.push(`person_linked:${personLabel}`);
                  });
                  sources['person_lookup'] = (sources['person_lookup'] || 0) + letters.length;
                }

                // 2. Letters that *mention* the person's name in the text (catches references, not just FK)
                const searchName = encodeURIComponent(person.last_name || person.first_name || '');
                if (searchName) {
                  const mResp = await fetch(
                    `${supabaseUrl}/rest/v1/letters?select=id,title,date_of_letter,document_type,full_text,author_id,recipient_id&full_text=ilike.*${searchName}*&limit=40`,
                    { headers }
                  );
                  const mentioned = await mResp.json();
                  if (Array.isArray(mentioned)) {
                    let newMentions = 0;
                    mentioned.forEach(l => {
                      if (!letterMap.has(l.id)) {
                        letterMap.set(l.id, { ...l, _sources: [], _score: null });
                        newMentions++;
                      }
                      letterMap.get(l.id)._sources.push(`person_mention:${personLabel}`);
                    });
                    sources['person_mention'] = (sources['person_mention'] || 0) + newMentions;
                  }
                }
              }
            }
            break;
          }

          case 'manuscript_lookup': {
            if (!plan.manuscript_names?.length) break;
            for (const name of plan.manuscript_names) {
              const mResp = await fetch(
                `${supabaseUrl}/rest/v1/manuscripts?select=id,name,description&name=ilike.*${encodeURIComponent(name)}*&limit=10`,
                { headers }
              );
              const manuscripts = await mResp.json();
              if (!Array.isArray(manuscripts) || !manuscripts.length) break;

              for (const ms of manuscripts) {
                const lResp = await fetch(
                  `${supabaseUrl}/rest/v1/letters?select=id,title,date_of_letter,document_type,full_text,author_id,recipient_id&papyri_id=eq.${ms.id}&limit=50`,
                  { headers }
                );
                const letters = await lResp.json();
                if (Array.isArray(letters)) {
                  letters.forEach(l => {
                    if (!letterMap.has(l.id)) {
                      letterMap.set(l.id, { ...l, _sources: [], _score: null });
                    }
                    letterMap.get(l.id)._sources.push(`manuscript:${ms.name}`);
                  });
                  sources['manuscript_lookup'] = (sources['manuscript_lookup'] || 0) + letters.length;
                }
              }
            }
            break;
          }

          case 'institution_lookup': {
            if (!plan.institution_names?.length) break;
            for (const name of plan.institution_names) {
              const iResp = await fetch(
                `${supabaseUrl}/rest/v1/institutions?select=id,name&name=ilike.*${encodeURIComponent(name)}*&limit=10`,
                { headers }
              );
              const institutions = await iResp.json();
              if (!Array.isArray(institutions) || !institutions.length) break;

              for (const inst of institutions) {
                const lResp = await fetch(
                  `${supabaseUrl}/rest/v1/letters?select=id,title,date_of_letter,document_type,full_text,author_id,recipient_id&institution_id=eq.${inst.id}&limit=50`,
                  { headers }
                );
                const letters = await lResp.json();
                if (Array.isArray(letters)) {
                  letters.forEach(l => {
                    if (!letterMap.has(l.id)) {
                      letterMap.set(l.id, { ...l, _sources: [], _score: null });
                    }
                    letterMap.get(l.id)._sources.push(`institution:${inst.name}`);
                  });
                  sources['institution_lookup'] = (sources['institution_lookup'] || 0) + letters.length;
                }
              }
            }
            break;
          }

          case 'date_filter': {
            const { start, end } = plan.date_range || {};
            if (!start && !end) break;
            let q = `${supabaseUrl}/rest/v1/letters?select=id,title,date_of_letter,document_type,full_text,author_id,recipient_id`;
            if (start) q += `&date_of_letter=gte.${encodeURIComponent(start)}`;
            if (end)   q += `&date_of_letter=lte.${encodeURIComponent(end)}`;
            q += '&limit=50';

            const lResp = await fetch(q, { headers });
            const letters = await lResp.json();
            if (Array.isArray(letters)) {
              letters.forEach(l => {
                if (!letterMap.has(l.id)) {
                  letterMap.set(l.id, { ...l, _sources: [], _score: null });
                }
                letterMap.get(l.id)._sources.push('date_filter');
              });
              sources['date_filter'] = letters.length;
            }
            break;
          }

          case 'keyword_search': {
            if (!plan.use_keyword) break;
            const kw = [...(plan.keywords || []), ...(plan.person_names || [])].join(' | ');
            if (!kw.trim()) break;

            const kResp = await fetch(
              `${supabaseUrl}/rest/v1/letters?select=id,title,date_of_letter,document_type,full_text,author_id,recipient_id&full_text=fts.${encodeURIComponent(kw)}&limit=30`,
              { headers }
            );
            const letters = await kResp.json();
            if (Array.isArray(letters)) {
              letters.forEach(l => {
                if (!letterMap.has(l.id)) {
                  letterMap.set(l.id, { ...l, _sources: [], _score: null });
                }
                letterMap.get(l.id)._sources.push('keyword_search');
              });
              sources['keyword_search'] = letters.length;
            }
            break;
          }

          case 'semantic_search': {
            if (!plan.use_semantic || !embedFn) break;
            const query = [
              ...(plan.person_names || []),
              ...(plan.keywords || []),
              ...(plan.manuscript_names || []),
            ].join(' ');
            if (!query.trim()) break;

            const embedding = await embedFn(query);
            if (!embedding) break;

            const sResp = await fetch('/api/embed', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query, topK: 30 }),
            });
            if (!sResp.ok) break;

            const sData = await sResp.json();
            const matches = sData.results || [];
            matches.forEach(m => {
              if (!letterMap.has(m.id)) {
                letterMap.set(m.id, { ...m, _sources: [], _score: m.similarity });
              }
              const entry = letterMap.get(m.id);
              entry._sources.push(`semantic_search (${Math.round((m.similarity || 0) * 100)}%)`);
              if (m.similarity && !entry._score) entry._score = m.similarity;
            });
            sources['semantic_search'] = matches.length;
            break;
          }

          case 'letter_by_id': {
            // Handles questions like "show me letter 1234"
            const idMatch = /\b(\d{3,6})\b/.exec(
              [plan.reasoning, ...(plan.keywords || [])].join(' ')
            );
            if (!idMatch) break;
            const lid = idMatch[1];
            const lResp = await fetch(
              `${supabaseUrl}/rest/v1/letters?select=id,title,date_of_letter,document_type,full_text,author_id,recipient_id&id=eq.${lid}`,
              { headers }
            );
            const letters = await lResp.json();
            if (Array.isArray(letters)) {
              letters.forEach(l => {
                if (!letterMap.has(l.id)) {
                  letterMap.set(l.id, { ...l, _sources: [], _score: null });
                }
                letterMap.get(l.id)._sources.push(`letter_by_id:${lid}`);
              });
              sources['letter_by_id'] = letters.length;
            }
            break;
          }

          default:
            console.warn('Unknown strategy step:', step);
        }
      } catch (err) {
        console.error(`Error in step "${step}":`, err);
      }
    }

    const letters = Array.from(letterMap.values());
    return { letters, sources };
  }

  /**
   * Render the plan reasoning panel into a given DOM element.
   * Call this right after you receive the plan, before results arrive.
   */
  function renderPlanPanel(plan, containerEl, modelLabel) {
    const steps = (plan.strategy || []).map(s =>
      `<span class="plan-step">${s.replace(/_/g, ' ')}</span>`
    ).join('');

    const tags = [
      ...(plan.person_names || []).map(n => `👤 ${n}`),
      ...(plan.manuscript_names || []).map(n => `📜 ${n}`),
      ...(plan.institution_names || []).map(n => `🏛️ ${n}`),
      ...(plan.keywords || []).map(k => `🔑 ${k}`),
    ].map(t => `<span class="plan-tag">${t}</span>`).join('');

    containerEl.innerHTML = `
      <div class="plan-panel">
        <div class="plan-header">
          <span class="plan-model">${modelLabel} Query Plan</span>
          <span class="plan-focus">Focus: <strong>${plan.primary_focus || 'unknown'}</strong></span>
        </div>
        <p class="plan-reasoning">${plan.reasoning || ''}</p>
        <div class="plan-steps">${steps}</div>
        ${tags ? `<div class="plan-tags">${tags}</div>` : ''}
      </div>`;
  }

  /**
   * Minimal CSS to paste into each portal's <style> block.
   * Keeps it self-contained — portals can override with their own theme vars.
   */
  const PLAN_CSS = `
.plan-panel {
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 10px;
  padding: 14px 16px;
  margin-bottom: 16px;
  background: var(--surface-2, rgba(255,255,255,0.04));
  font-size: 13px;
}
.plan-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.plan-model {
  font-weight: 700;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.7;
}
.plan-focus { font-size: 12px; opacity: 0.8; }
.plan-reasoning { margin: 0 0 10px; line-height: 1.5; opacity: 0.9; }
.plan-steps { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.plan-step {
  background: var(--accent, #6366f1);
  color: white;
  padding: 2px 9px;
  border-radius: 99px;
  font-size: 11px;
  font-weight: 600;
}
.plan-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.plan-tag {
  background: var(--surface-3, rgba(255,255,255,0.08));
  border: 1px solid var(--border, #e5e7eb);
  padding: 2px 9px;
  border-radius: 99px;
  font-size: 11px;
}`;

  return { runQueryPlan, renderPlanPanel, PLAN_CSS };
})();

// Support both ES module and classic <script> usage
if (typeof module !== 'undefined') module.exports = QueryPlanExecutor;
