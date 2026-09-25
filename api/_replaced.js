// api/_replaced.js
// Which idle Jim windows can be closed (used by api/worker/report.js, action "replaced"; not a route).
//
// A Jim's window is NEVER closed just because it finished, and never on a timer: it stays open until one of two things
// happens for that question and Jim:
//   1. a FOLLOW-UP has started working  -> the windows that produced the earlier version of the report are listed
//                                          (the original answering window and any earlier follow-up windows);
//   2. the researcher has FINISHED REVIEWING its suggestions (reviewed_at is set on its answer row) -> every window for that
//                                          question and Jim is listed, including the latest follow-up's.
// (Nothing depends on these windows: the report is a file and the suggestions live in the database. A follow-up starts a
// brand-new session anyway.)
//   3. the run belongs to the RESEARCH ASSISTANT: they never review, so nothing else would ever close it - it is listed a\n//      few minutes after it finishes.\n//   -> [ { kind: 'ask' | 'followup' | 'answer', id, model } ]      (the last 14 days are considered)

import { sb } from './_sb.js';
import { requestIsAssistants, questionIsAssistants } from './_owner.js';

const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const ASSISTANT_GRACE_MS = 4 * 60 * 1000;

export async function replacedWindows() {
  const since = encodeURIComponent(new Date(Date.now() - LOOKBACK_MS).toISOString());
  const items = [];
  const seen = new Set();
  const add = (kind, id, model) => { const k = `${kind}:${id}:${model}`; if (!seen.has(k)) { seen.add(k); items.push({ kind, id, model }); } };

  // 1) follow-ups that have started: the earlier windows are replaced
  const started = await sb(`jim_jobs?kind=eq.followup&status=eq.launched&launched_at=gte.${since}&select=followup_id&order=id.desc&limit=40`) || [];
  const ids = [...new Set(started.map((j) => j.followup_id))];
  if (ids.length) {
    const fs = await sb(`followups?id=in.(${ids.join(',')})&select=id,request_id,ai_model`) || [];
    for (const f of fs) {
      add('ask', f.request_id, f.ai_model);                                            // the original answering window
      const earlier = await sb(`followups?request_id=eq.${f.request_id}&ai_model=eq.${f.ai_model}&id=lt.${f.id}&select=id`) || [];
      for (const e of earlier) add('followup', e.id, f.ai_model);                      // earlier follow-up windows
    }
  }

  // 2) reviews that are finished (reviewed_at is set on the Jim's answer row): every window for that question and Jim can go
  try {
    const rr = await sb(`research_results?reviewed_at=gte.${since}&select=request_id,ai_model&order=reviewed_at.desc&limit=60`) || [];
    for (const d of rr) {
      add('ask', d.request_id, d.ai_model);
      const fs = await sb(`followups?request_id=eq.${d.request_id}&ai_model=eq.${d.ai_model}&select=id`) || [];
      for (const f of fs) add('followup', f.id, d.ai_model);
    }
    const ca = await sb(`comparative_answers?reviewed_at=gte.${since}&select=comparative_question_id,ai_model&order=reviewed_at.desc&limit=60`) || [];
    for (const d of ca) add('answer', d.comparative_question_id, d.ai_model);
  } catch (e) {
    console.error('api/_replaced: review lookup failed:', e && e.message);      // e.g. the column does not exist yet
  }

  // 3) the Research Assistant's runs: they cannot review, so close their windows a few minutes after they finish
  try {
    const settled = encodeURIComponent(new Date(Date.now() - ASSISTANT_GRACE_MS).toISOString());
    const rr2 = await sb(`research_results?answered_at=gte.${since}&answered_at=lt.${settled}&select=request_id,ai_model&order=answered_at.desc&limit=60`) || [];
    for (const d of rr2) if (await requestIsAssistants(d.request_id)) add('ask', d.request_id, d.ai_model);
    const fu2 = await sb(`followups?finished_at=gte.${since}&finished_at=lt.${settled}&select=id,request_id,ai_model&order=finished_at.desc&limit=60`) || [];
    for (const f of fu2) if (await requestIsAssistants(f.request_id)) add('followup', f.id, f.ai_model);
    const ca2 = await sb(`comparative_answers?answered_at=gte.${since}&answered_at=lt.${settled}&select=comparative_question_id,ai_model&order=answered_at.desc&limit=60`) || [];
    for (const d of ca2) if (await questionIsAssistants(d.comparative_question_id)) add('answer', d.comparative_question_id, d.ai_model);
  } catch (e) {
    console.error('api/_replaced: assistant lookup failed:', e && e.message);
  }  return items;
}
