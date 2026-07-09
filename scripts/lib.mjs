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
//   ping   — an @copilot fix request; also the race guard against double-pinging
//   ready  — posted when the "ready for review" Teams card fires (re-arm anchor)
//   rerun  — one written per flaky-job re-run, tagged with the check name (cap)
const TAG = 'babysitter';

export function buildMarker(kind, extra = {}) {
  const ts = new Date().toISOString();
  const attrs = Object.entries(extra).map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '')}"`).join('');
  return `<!-- ${TAG}:${kind} ts="${ts}"${attrs} -->`;
}

// Parse every babysitter marker out of a list of comment bodies+timestamps.
// Returns [{ kind, ts (Date), check? }] — ts is the marker's own ts attr if
// present, else the comment's createdAt.
export function parseMarkers(comments) {
  const re = new RegExp(`<!--\\s*${TAG}:(\\w+)([^>]*)-->`);
  const attr = (s, name) => (s.match(new RegExp(`${name}="([^"]*)"`)) || [])[1];
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
// A single logical check (e.g. "Danger") can appear on BOTH endpoints — as a
// modern check-run AND as a legacy commit status — and the two can disagree
// (a green check-run alongside a stale red status whose target_url is just a PR
// comment). GitHub's own merge box de-duplicates by name with the check-run
// authoritative; we do the same. Otherwise a stale legacy status surfaces as a
// phantom failing check with no runId → no log → the assess prompt defaults it
// to caused-by-pr and pings Copilot to "fix" an already-green check. Legacy
// statuses with NO matching check-run are still kept (the reason we read both).
export function classifyChecks({ checkRuns = [], statuses = [] } = {}) {
  const checks = [];
  const checkRunNames = new Set(checkRuns.map((c) => c.name));
  for (const c of checkRuns) {
    let state = 'pending';
    if (c.status === 'completed') state = FAIL_CONCLUSIONS.has(c.conclusion) ? 'fail' : PASS_CONCLUSIONS.has(c.conclusion) ? 'pass' : 'pending';
    // parse run id from details_url: .../actions/runs/<runId>/job/<jobId>
    const runId = (String(c.details_url || '').match(/\/actions\/runs\/(\d+)/) || [])[1] || null;
    checks.push({ name: c.name, state, runId });
  }
  for (const s of statuses) {
    if (checkRunNames.has(s.context)) continue; // check-run of the same name wins
    const state = s.state === 'success' ? 'pass' : (s.state === 'pending' || s.state === 'expected') ? 'pending' : 'fail';
    checks.push({ name: s.context, state, runId: null });
  }
  return checks;
}

// Parse a leading Jira-style key (e.g. PMO-2039) from a PR title, if present.
export function jiraKeyFromTitle(title) {
  return (String(title).match(/[A-Z][A-Z0-9]+-\d+/) || [])[0] || null;
}
