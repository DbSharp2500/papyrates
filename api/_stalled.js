// api/_stalled.js
// Jim runs that were launched but never finished - so the Desktop launcher can look inside their session for the reason
// (e.g. the account hit a spend or usage limit) and report it. Used by api/worker/report.js; not a route.
//   openJobs()          -> launched answer/ask/followup jobs, 3 minutes to 6 hours old, that have produced no answer yet
//   markJimFailed(id,e) -> a launched Jim stopped without an answer:
//        - because its account hit a spend / usage limit -> the job goes BACK IN THE QUEUE, marked "waiting for token
//          refresh", and is retried every 30 minutes (see claim.js) until it works - for up to 3 days;
//        - for any other reason -> the job is marked failed with the reason.

import { sb } from './_sb.js';
import { pushOnce, NAMES } from './_push.js';
import { LIMIT_RE, sessionOf } from './_state.js';

const iso = (ms) => encodeURIComponent(new Date(ms).toISOString());
const GIVE_UP_MS = 3 * 24 * 3600 * 1000;

export async function openJobs() {
  const now = Date.now();
  const jobs = await sb(`jim_jobs?kind=in.(answer,ask,followup)&status=eq.launched&launched_at=gte.${iso(now - 6 * 3600000)}&launched_at=lt.${iso(now - 3 * 60000)}&select=id,kind,model,question_id,request_id,followup_id,launched_at,error_text&order=id.asc&limit=40`) || [];
  const out = [];
  for (const j of jobs) {
    let finished = false;
    if (j.kind === 'answer') finished = ((await sb(`comparative_answers?comparative_question_id=eq.${j.question_id}&ai_model=eq.${j.model}&select=id&limit=1`)) || []).length > 0;
    else if (j.kind === 'ask') finished = ((await sb(`research_results?request_id=eq.${j.request_id}&ai_model=eq.${j.model}&select=id&limit=1`)) || []).length > 0;
    else finished = ((await sb(`followups?id=eq.${j.followup_id}&finished_at=not.is.null&select=id&limit=1`)) || []).length > 0;
    if (!finished) out.push({ id: j.id, kind: j.kind, model: j.model, ref: j.question_id || j.request_id || j.followup_id, launched_at: j.launched_at, resume_session: sessionOf(j.error_text) });
  }
  return out;
}

// Returns { updated, requeued }
export async function markJimFailed(id, error, session) {
  const jobs = await sb(`jim_jobs?id=eq.${id}&status=eq.launched&select=id,kind,model,question_id,request_id,followup_id,created_at,requested_by,error_text`) || [];
  if (!jobs.length) return { updated: false, requeued: false };
  const j = jobs[0];
  // keep the stopped session's id with the reason, so a retry can resume it (an earlier id is kept if none is given now)
  const sid = (typeof session === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session)) ? session.toLowerCase() : sessionOf(j.error_text);
  const text = String(error || 'the Jim stopped without an answer').replace(/\s+/g, ' ').slice(0, 260) + (sid ? ' [session ' + sid + ']' : '');

  const limited = LIMIT_RE.test(text) && Date.now() - new Date(j.created_at).getTime() < GIVE_UP_MS;
  if (limited) {
    // back in the queue, marked with the reason and the time of this attempt; claim.js holds it for 30 minutes
    await sb(`jim_jobs?id=eq.${id}&status=eq.launched`, { method: 'PATCH', body: { status: 'queued', error_text: text, claimed_at: new Date().toISOString() } });
    if (j.requested_by !== 'research') {                                     // the assistant's work never alerts
      let label = j.request_id ? `Question ${j.request_id}` : `Comparative Question ${j.question_id}`;
      if (j.followup_id) {
        const f = await sb(`followups?id=eq.${j.followup_id}&select=request_id`) || [];
        label = `your follow-up on Question ${f.length ? f[0].request_id : '?'}`;
      }
      await pushOnce(`limit:${id}`, 'Waiting for token refresh',
        `${NAMES[j.model] || j.model} hit a spend or usage limit on ${label}. It will keep retrying every 30 minutes and carry on by itself once the limit is lifted.`);
    }
    return { updated: true, requeued: true };
  }
  await sb(`jim_jobs?id=eq.${id}&status=eq.launched`, { method: 'PATCH', body: { status: 'failed', error_text: text } });
  return { updated: true, requeued: false };
}