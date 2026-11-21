// api/_explorer-chart-build.js
// Turns the rows of the explorer_fragments table (and the cited documents from the letters table) into the data object the
// Explorer Fragment Chart page draws. Not a route (Vercel excludes files starting with "_"); used by api/db-proxy/[...path].js
// for the Admin-only route /api/db-proxy/explorer-chart.
// What the page shows: narratives not held back, custody steps whose display is "show", the owner's stated position, first appearance,
// published scholarly assessments. Rows come in Lying Pen order (the numbering of the Lying Pen list), then the rows that are not on that list.

import { LP_ROWS, LP_ORDER, LP_PIECES, LP_NOTES } from './_explorer-chart-lp.js';

export const COLUMNS_BASE = 'id,label,text_identification,identifiers,current_holder,owner_stated_position,published_scholarly_assessments,first_documented_appearance,custody_chain,provenance_stories';
// custody_claims (added 2026-11-20, jsonb): the chains of custody the chart's "Collector(s)/collection(s)" column draws:
//   [{ nodes: [{n: name, y: year}], docs: [citation strings, one footnote number each], support: [narrative ids] }]
// The route asks for it with the other columns and falls back to COLUMNS_BASE if the column does not exist yet.
export const COLUMNS = COLUMNS_BASE + ',custody_claims';

// The chart's provenance column shows narratives that rest on PRIMARY SOURCE DOCUMENTS only (Dan, 20 Nov 2026). Each narrative carries a list of the
// kinds of source it cites, stored with the fragment in provenance_stories.narrative_types = { "<narrative id>": ["letters", "internal", ...] }.
// A narrative is shown only if every kind it cites is in this list (MIX_RULE 'all'; 'some' would show a narrative that cites at least one).
// A narrative with no kinds recorded is not shown. Not on the list: published articles/news (news), blogs, scholarly works, compiled databases,
// lab/expert reports (reports), later accounts by people not directly involved (later_other).
export const PRIMARY_TYPES = ['court_testimony', 'court_filings', 'contracts', 'letters', 'internal', 'interviews', 'later_accounts', 'statements', 'seller', 'owner_sites'];
const MIX_RULE = 'all';

const strip = (s) => (s == null ? null : String(s));
const DOC_RE = /\bDocs?\.?\s*#?\s*(\d{2,5}(?:\s*(?:,|and|&)\s*\d{2,5})*)/gi;

function narrativesFor(r) {
  const ps = r.provenance_stories;
  if (ps && !Array.isArray(ps) && ps.built) {
    return { narratives: ps.narratives || [], none: ps.no_narrative_found, note: ps.no_narrative_note, searched: ps.documents_searched || [], unreadable: ps.unreadable_sources || [] };
  }
  // A row that has not been through the narrative pass yet: nothing to show.
  return { narratives: [], none: true, note: 'No narrative file for this row.', searched: [], unreadable: [] };
}

function lpRank(lp) {
  if (!lp.length) return 1e6;
  const i = LP_ORDER.indexOf(lp[0]);
  return i < 0 ? 1e6 : i;
}

// The ids of the Papyrates documents ("Doc 3567") cited anywhere in the shown data, so the page can link them.
export function docIdsOf(data) {
  const ids = new Set();
  const scan = (s) => { if (typeof s !== 'string') return; for (const m of s.matchAll(DOC_RE)) for (const n of m[1].matchAll(/\d{2,5}/g)) ids.add(Number(n[0])); };
  for (const r of data.rows) {
    for (const n of r.narratives) for (const s of n.sources || []) { scan(s.doc); scan(s.locator); }
    for (const c of r.custody) for (const s of c.sources || []) scan(typeof s === 'string' ? s : s && s.doc);
    for (const s of r.first.shown || []) scan(s.source);
    scan(r.owner.source);
    for (const c of r.claims || []) for (const d of c.docs || []) scan(d);
  }
  for (const l of data.links || []) if (l.doc != null) ids.add(l.doc);   // a scan that is a copy of a Papyrates document links to that document
  return [...ids].sort((a, b) => a - b);
}

// Links to cited files. The table keeps them per fragment, inside provenance_stories.source_links, as
//   { "<citation exactly as written>": { u: "https://…", t: "label", k: "od|web|kf" }  or  { doc: 3559, k: "scan" } }
// (a "scan" is a copy of a document that already has a Doc number). Only https addresses are passed on. The page gets one
// shared list (data.links) and each row's citation -> index into it, so the same file is not sent again for every fragment.
function makeLinks() {
  const list = []; const seen = new Map();
  const add = (l) => {
    if (!l || typeof l !== 'object') return null;
    let item;
    if (l.doc != null && Number.isInteger(Number(l.doc))) item = { doc: Number(l.doc), k: String(l.k || 'scan').slice(0, 8) };
    else if (typeof l.u === 'string' && /^https:\/\//i.test(l.u.trim())) item = { u: l.u.trim(), t: String(l.t || '').slice(0, 160), k: String(l.k || '').slice(0, 8) };
    else return null;
    const key = JSON.stringify(item); let i = seen.get(key);
    if (i == null) { i = list.length; list.push(item); seen.set(key, i); }
    return i;
  };
  return { list, add };
}

export function buildChartData(live, docRows = []) {
  const LK = makeLinks();
  const rows = live.map((r) => {
    const sl = {};
    const ps0 = r.provenance_stories;
    if (ps0 && !Array.isArray(ps0) && ps0.source_links && typeof ps0.source_links === 'object') for (const [cite, l] of Object.entries(ps0.source_links)) { const i = LK.add(l); if (i != null) sl[cite] = i; }
    // chains of custody (new column custody_claims): names and years in order, plus the documents that support each chain
    const claims = (Array.isArray(r.custody_claims) ? r.custody_claims : []).map((c) => ({
      nodes: (Array.isArray(c && c.nodes) ? c.nodes : []).map((x) => ({ n: String((x && x.n) || '').slice(0, 80), y: x && x.y != null && String(x.y).trim() ? String(x.y).trim().slice(0, 40) : null })).filter((x) => x.n),
      docs: (Array.isArray(c && c.docs) ? c.docs : []).map((d) => String(d || '').slice(0, 400)).filter(Boolean),
    })).filter((c) => c.nodes.length >= 2 && c.docs.length >= 1);   // a chain nobody can click through to a document is not shown
    const nv = narrativesFor(r);
    const kinds = ps0 && !Array.isArray(ps0) && ps0.narrative_types && typeof ps0.narrative_types === 'object' ? ps0.narrative_types : {};
    const isPrimary = (n) => { const t = kinds[n.id]; if (!Array.isArray(t) || !t.length) return false; return MIX_RULE === 'all' ? t.every((x) => PRIMARY_TYPES.includes(x)) : t.some((x) => PRIMARY_TYPES.includes(x)); };
    const notHeld = nv.narratives.filter((n) => n.display !== 'hold back');
    const shown = notHeld.filter(isPrimary);
    const held = nv.narratives.length - notHeld.length;
    const notPrimary = notHeld.length - shown.length;
    const o = r.owner_stated_position || {};
    const f = r.first_documented_appearance || {};
    const sch = r.published_scholarly_assessments || {};
    const steps = (r.custody_chain || []).filter((s) => s.verification?.display === 'show');
    const omitted = (r.custody_chain || []).length - steps.length;
    const lp = LP_ROWS[String(r.id)] || [];
    return {
      id: Number(r.id), lp, lp_pieces: LP_PIECES[String(r.id)] || null, lp_note: LP_NOTES[String(r.id)] || null, label: r.label, text_id: strip(r.text_identification),
      identifiers: Array.isArray(r.identifiers) ? r.identifiers : (r.identifiers ? [String(r.identifiers)] : []),
      holder: strip(r.current_holder),
      owner: { display: o.display ?? null, position: o.position ?? null, owner: o.owner ?? null, speaker: o.speaker ?? null, quote: o.quote ?? null, source: o.source ?? null, scope: o.scope ?? null, date: o.statement_date ?? null },
      scholars: (sch.assessments || []).map((a) => ({ scholars: a.scholars ?? null, affiliation: a.affiliation ?? null, year: a.year ?? null, work: a.work ?? null, conclusion: a.conclusion ?? null, quote: a.quote ?? null })),
      first: { display: f.display ?? null, shown: (f.shown || []).map((s) => ({ what: s.what, grade: s.grade, date: s.date_iso, source: s.source, quote: s.quote })) },
      narratives: shown.map((n) => ({ id: n.id, told_by: n.told_by, role: n.told_by_role, date: n.date, date_basis: n.date_basis, identity: n.identity, identity_note: n.identity_note, story: n.story, sources: n.sources, differs_from: n.differs_from, status: n.verification?.status, caution: n.display === 'show with caution' })),
      narratives_held: held, narratives_not_primary: notPrimary, no_narrative: !!nv.none && !shown.length, no_narrative_note: nv.note || null, searched: nv.searched, unreadable: nv.unreadable,
      custody: steps.map((s) => ({ holder: s.holder ?? null, from: s.from ?? null, to: s.to ?? null, how: s.how, sources: s.sources || [], level: s.evidence_level ?? null })), custody_omitted: omitted,
      sl, claims,
    };
  });
  // Lying Pen order first, then the rows that are not on that list (by row number)
  rows.sort((a, b) => (lpRank(a.lp) - lpRank(b.lp)) || (a.id - b.id));
  const nNarr = rows.reduce((a, r) => a + r.narratives.length, 0);
  const nHeld = rows.reduce((a, r) => a + r.narratives_held, 0);
  const nNotPrimary = rows.reduce((a, r) => a + r.narratives_not_primary, 0);
  const nCaution = rows.reduce((a, r) => a + r.narratives.filter((n) => n.caution).length, 0);
  const nSteps = rows.reduce((a, r) => a + r.custody.length, 0);
  const data = {
    built: new Date().toISOString().slice(0, 10),
    counts: { fragments: rows.length, fragments_with_narratives: rows.filter((r) => r.narratives.length).length, narratives: nNarr, not_primary: nNotPrimary, caution: nCaution, held: nHeld, custody_steps: nSteps, narrative_source: 'table', on_lp_list: rows.filter((r) => r.lp.length).length, lp_entries: LP_ORDER.length },
    lp_order: LP_ORDER,
    rows,
    links: LK.list,
    docs: {},
  };
  // Cited documents: id -> {t: title, u: link to the original document (or null)}
  for (const d of docRows || []) data.docs[d.id] = { t: String(d.title || '').slice(0, 160), u: d.sharing_link && String(d.sharing_link).trim() ? String(d.sharing_link).trim() : null };
  return data;
}
