// api/_owner.js
// Who started a question. The Research Assistant's questions are marked requested_by = 'research' (on research_requests
// and on their jim_jobs rows); the owner's are 'admin'. Used to keep the assistant to their own questions, and to send
// them no phone alerts. Not a route (Vercel excludes files starting with "_").

import { sb } from './_sb.js';

export const ASSISTANT = 'research';

// An everyday question (research_requests.id)
export async function requestIsAssistants(rid) {
  const r = await sb(`research_requests?id=eq.${rid}&select=requested_by`) || [];
  return r.length > 0 && r[0].requested_by === ASSISTANT;
}

// A comparative question (comparative_questions.id): the assistant started it if its Jim jobs were theirs
export async function questionIsAssistants(qid) {
  const j = await sb(`jim_jobs?kind=eq.answer&question_id=eq.${qid}&requested_by=eq.${ASSISTANT}&select=id&limit=1`) || [];
  return j.length > 0;
}

// A follow-up (followups.id) belongs to the assistant if its question does
export async function followupIsAssistants(fid) {
  const f = await sb(`followups?id=eq.${fid}&select=request_id`) || [];
  return f.length > 0 && requestIsAssistants(f[0].request_id);
}