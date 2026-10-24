// api/_queue.js
// Queues ONE Jim job for the owner without a dashboard login, optionally held until a given time. Used by
// api/worker/report.js (action "queue_job"; the worker token is required there). Not a route.
//
// Why it exists: after a Jim's account hits its usage limit, the job can only be asked again by someone logged in to
// the dashboard. This lets the Desktop (or the owner's own script) queue the retry ahead of time, held until the limit
// resets, so it starts by itself. The hold reuses what claim.js already does for limits: a queued job whose error_text
// names a limit and whose claimed_at is recent is not handed out until RETRY_MS after claimed_at. Setting claimed_at to
// (hold time - RETRY_MS) makes it wait exactly until the hold time; the Ask and Comparative pages show it as
// "waiting for token refresh" with the minutes left, and the owner can still cancel it.
//
// Only fixed shapes are accepted (a Jim name, a question number, an optional time), the same as api/jobs.js, so a job
// can never carry free text into a command. The wording stored with a held job is built here, not taken from the caller.

import { sb } from './_sb.js';
import { NAMES } from './_push.js';
import { RETRY_MS } from './_state.js';

const MODELS = ['claude', 'gpt', 'gemini', 'judge'];
const MAX_HOLD_MS = 7 * 24 * 3600 * 1000;

const hst = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'Pacific/Honolulu', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' HST';

// -> { status, body }
export async function queueHeldJob(input) {
  const body = input || {};
  const model = String(body.model || '');
  if (!MODELS.includes(model)) return { status: 400, body: { error: 'Unknown model' } };
  const qid = Number(body.question_id);
  if (!Number.isInteger(qid) || qid < 1 || qid > 1000000) return { status: 400, body: { error: 'Invalid question id' } };

  let holdMs = null;
  if (body.hold_until !== undefined && body.hold_until !== null && body.hold_until !== '') {
    const t = new Date(String(body.hold_until)).getTime();
    if (!Number.isFinite(t)) return { status: 400, body: { error: 'Invalid hold_until' } };
    if (t > Date.now() + MAX_HOLD_MS) return { status: 400, body: { error: 'hold_until is more than 7 days away' } };
    if (t > Date.now()) holdMs = t;                       // a time that has already passed just means "start now"
  }

  const q = await sb(`comparative_questions?id=eq.${qid}&select=id`);
  if (!q || q.length === 0) return { status: 404, body: { error: 'No such comparative question' } };

  const kind = model === 'judge' ? 'evaluate' : 'answer';
  if (kind === 'answer') {
    const have = await sb(`comparative_answers?comparative_question_id=eq.${qid}&ai_model=eq.${model}&select=id&limit=1`);
    if (have && have.length) return { status: 409, body: { error: 'That Jim has already answered this question' } };
  }
  const dup = await sb(`jim_jobs?model=eq.${model}&kind=eq.${kind}&question_id=eq.${qid}&status=in.(queued,claimed)&select=id&limit=1`);
  if (dup && dup.length) return { status: 409, body: { error: 'That job is already queued', id: dup[0].id } };

  const row = { kind, model, question_id: qid, requested_by: 'admin' };
  if (holdMs) {
    row.claimed_at = new Date(holdMs - RETRY_MS).toISOString();
    row.error_text = `Waiting for ${NAMES[model] || model}'s usage limit to reset (about ${hst(holdMs)}). It starts by itself then.`;
  }
  const created = await sb('jim_jobs', { method: 'POST', body: row, prefer: 'return=representation' });
  return { status: 201, body: { job: created && created[0], held_until: holdMs ? new Date(holdMs).toISOString() : null } };
}
