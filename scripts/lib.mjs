// lib.mjs — shared helpers for the babysitter scripts.
// All GitHub I/O goes through the `gh` CLI (preinstalled on ubuntu-24.04),
// authenticated from GH_TOKEN. Copilot identities and the marker-comment
// protocol are defined here so fetch/assess/apply agree on them.

import { execFileSync } from 'node:child_process';

// -------- the three Copilot identities (see README) --------
export const COPILOT_AGENT = 'copilot-swe-agent';            // authors/fixes PRs; drives lifecycle events
export const COPILOT_REVIEWER = 'copilot-pull-request-reviewer'; // leaves review threads (the gate)

// -------- gh helpers --------
// GH_TOKEN drives auth; callers pass which token to use via env.
export function gh(args, { token, maxBuffer = 20 * 1024 * 1024 } = {}) {
  const env = { ...process.env };
  if (token) env.GH_TOKEN = token;
  return execFileSync('gh', args, { encoding: 'utf8', env, maxBuffer });
}
export function ghJson(args, opts) {
  return JSON.parse(gh(args, opts));
}
// gh api graphql with a query string; returns parsed .data (throws on errors).
export function ghGraphql(query, opts) {
  const out = ghJson(['api', 'graphql', '-f', `query=${query}`], opts);
  if (out.errors) throw new Error(`graphql: ${JSON.stringify(out.errors).slice(0, 300)}`);
  return out.data;
}

// -------- marker-comment protocol --------
// The babysitter records state as hidden HTML comments on the PR, so its own
// prior actions are machine-detectable regardless of author or prose. Kinds:
//   ping       — an @copilot fix request; also the race guard against double-pinging
//   ready      — posted when the "ready for review" Teams card fires (re-arm anchor)
//   rerun      — one written per flaky-job re-run, tagged with the check name (cap)
//   attempt    — one written per obstacle-handling attempt; carries a `data`
//                payload (JSON) with whatever the ledger needs, e.g.
//                { obstacle, head, n }
//   escalated  — posted when the babysitter gives up and hands off to a human
// Markers may carry a `data='<json>'` attribute (single-quoted so the inner
// JSON's double quotes don't need escaping) in addition to plain `key="value"`
// attributes.
const TAG = 'babysitter';

// Author logins whose babysitter markers are trusted for ledger counting.
// Only markers written by identities we control can be used for the obstacle-cap
// and attempt-count logic — otherwise a third party could fake a marker to reset or
// saturate the cap. For the octan POC these are the two identities that post markers:
//   - "github-actions[bot]"  — markers posted via ghRead (GITHUB_TOKEN)
//   - the Copilot user login  — pings posted via ghCopilot token (apply.mjs)
export const BABYSITTER_MARKER_AUTHORS = new Set([
  'github-actions[bot]',
  'copilot-swe-agent',
]);

export function buildMarker(kind, extra = {}) {
  const ts = new Date().toISOString();
  const { data, ...rest } = extra;
  const attrs = Object.entries(rest).map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '')}"`).join('');
  const dataAttr = data && typeof data === 'object' ? ` data='${JSON.stringify(data)}'` : '';
  return `<!-- ${TAG}:${kind} ts="${ts}"${attrs}${dataAttr} -->`;
}

// Parse every babysitter marker out of a list of comment bodies+timestamps(+author).
// Returns [{ kind, ts (Date), check?, data, author }] — ts is the marker's own
// ts attr if present, else the comment's createdAt. `data` is the parsed JSON
// payload from a data="..." or data='...' attribute (null if absent or
// unparseable). `author` is passed through from the comment as-is (null if
// absent).
export function parseMarkers(comments) {
  const re = new RegExp(`<!--\\s*${TAG}:(\\w+)([^>]*)-->`);
  const attr = (s, name) => (s.match(new RegExp(`${name}="([^"]*)"`)) || [])[1];
  const dataAttr = (s) => {
    const m = s.match(/data="([^"]*)"/) || s.match(/data='([^']*)'/);
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  };
  const out = [];
  for (const c of comments) {
    const m = (c.body || '').match(re);
    if (!m) continue;
    const kind = m[1];
    const tsAttr = attr(m[2], 'ts');
    out.push({
      kind,
      ts: new Date(tsAttr || c.createdAt),
      check: attr(m[2], 'check'),
      data: dataAttr(m[2]),
      author: c.author ?? null,
    });
  }
  return out;
}
export const newestOf = (dates) => (dates.length ? new Date(Math.max(...dates.map((d) => +d))) : null);

// -------- CI classification (REST) --------
// We read CI from two REST endpoints (both need only checks:read / statuses:read),
// avoiding gh's statusCheckRollup GraphQL which requires broader integration
// access than the default GITHUB_TOKEN grants:
//   GET /repos/{o}/{r}/commits/{ref}/check-runs  → modern CheckRuns
//   GET /repos/{o}/{r}/commits/{ref}/status      → legacy combined StatusContexts
// Normalise both to { name, state: 'pass'|'fail'|'pending', runId }.
const FAIL_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
const PASS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

// check-runs: [{ name, status, conclusion, details_url }]
// combined status: { statuses: [{ context, state }] }
//
// A single logical check can appear on BOTH endpoints — as a modern check-run
// AND as a legacy commit status under the same name — and the two can disagree
// (a green check-run alongside a stale red status whose target_url is just a PR
// comment). GitHub's own merge box de-duplicates by name with the check-run
// authoritative; we do the same. Otherwise a stale legacy status surfaces as a
// phantom failing check with no runId → no log → the assess prompt defaults it
// to caused-by-pr and pings Copilot to "fix" an already-green check. Legacy
// statuses with NO matching check-run are still kept (the reason we read both).
// Map a legacy commit-status state to a checkRun-style conclusion.
function mapLegacyState(state) {
  if (state === 'success') return 'success';
  if (state === 'pending' || state === 'expected') return null; // still running
  return 'failure';
}

// Pick the "latest" attempt of a check: the one that sorts last by
// completedAt, tiebroken by startedAt, then by position (later wins).
function latestAttempt(attempts) {
  const at = (v) => (v ? new Date(v).getTime() : -Infinity);
  let best = attempts[0];
  let bestIdx = 0;
  for (let i = 1; i < attempts.length; i++) {
    const a = attempts[i];
    const cmp = at(a.completedAt) - at(best.completedAt) || at(a.startedAt) - at(best.startedAt) || (i - bestIdx);
    if (cmp >= 0) {
      best = a;
      bestIdx = i;
    }
  }
  return best;
}

// Groups check-runs (and legacy commit-statuses) by logical check name.
// Returns the raw attempt history — do NOT collapse to a single state; that
// judgment belongs to the model. Legacy status de-duplication is fine (two
// representations of one signal). Unknown conclusions set incomplete=true
// rather than being silently swallowed (the completeness veto in apply.mjs
// needs this signal).
export function groupChecks({ checkRuns = [], statuses = [] } = {}) {
  const byName = new Map(); // name -> attempts[]
  const checkRunNames = new Set(checkRuns.map((c) => c.name));
  const unknownConclusions = new Set();
  let incomplete = false;
  for (const c of checkRuns) {
    if (c.status === 'completed' && c.conclusion != null && !FAIL_CONCLUSIONS.has(c.conclusion) && !PASS_CONCLUSIONS.has(c.conclusion)) {
      unknownConclusions.add(c.conclusion);
      incomplete = true;
    }
    // parse run id from details_url: .../actions/runs/<runId>/job/<jobId>
    const runId = (String(c.details_url || '').match(/\/actions\/runs\/(\d+)/) || [])[1] || null;
    const attempt = { conclusion: c.conclusion, status: c.status, runId, startedAt: c.started_at || null, completedAt: c.completed_at || null };
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name).push(attempt);
  }
  for (const s of statuses) {
    if (checkRunNames.has(s.context)) continue; // check-run of the same name wins
    const attempt = {
      conclusion: mapLegacyState(s.state),
      status: s.state === 'pending' || s.state === 'expected' ? 'in_progress' : 'completed',
      runId: null,
      startedAt: null,
      completedAt: null,
    };
    if (!byName.has(s.context)) byName.set(s.context, []);
    byName.get(s.context).push(attempt);
  }
  const checks = [...byName.entries()].map(([name, attempts]) => ({
    name,
    attempts,
    runId: latestAttempt(attempts).runId,
  }));
  return { checks, incomplete, unknownConclusions: [...unknownConclusions] };
}

// Parse a leading Jira-style key (e.g. PMO-2039) from a PR title, if present.
export function jiraKeyFromTitle(title) {
  return (String(title).match(/[A-Z][A-Z0-9]+-\d+/) || [])[0] || null;
}
