#!/usr/bin/env node
// babysit-assess.mjs
// The deterministic OUTER LOOP over prs.json. For each PR it gathers state via
// gh, applies the idempotency gate, and — only when there is real work to judge
// — runs a FRESH, read-only Claude session that decides what Copilot should do.
// Writes decisions.json for the apply step. NO side effects here (reads only).
//
// Per-PR decision (mirrors the agreed design):
//   1. Idempotency gate: ping only if newest copilot_work_started is NEWER than
//      our newest ping-marker. Else -> skip (Copilot working, or already pinged
//      and not yet started — our own marker closes the ~90s trigger-lag race).
//   2. Comments FIRST (they preempt CI: a fix-commit re-triggers CI anyway).
//      Unresolved copilot-pull-request-reviewer threads -> Claude synthesises a
//      single instruction -> action "ping".
//   3. CI only when the comment queue is empty. Claude attributes each failing
//      check from diff + log tail: flaky -> "rerun"; caused-by-pr -> "ping".
//   4. Terminal: idle AND no unresolved reviewer threads AND CI green AND not
//      already posted -> action "ready".
//
// Claude is read-only (Read/Grep/Glob, no network): it reasons over text this
// script gathers; the apply step performs every mutation.
//
// Env required: ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, BABYSIT_MODEL, GITHUB_TOKEN, GITHUB_REPOSITORY
// Env optional: BABYSIT_MAX_TURNS (15), MAX_DIFF_BYTES (60000), MAX_LOG_LINES (200), RERUN_CAP (2)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  gh, ghJson, ghGraphql, COPILOT_AGENT, COPILOT_REVIEWER,
  parseMarkers, newestOf, classifyChecks,
} from './lib.mjs';

const { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, BABYSIT_MODEL, GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;
for (const [k, v] of Object.entries({ ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, BABYSIT_MODEL, GITHUB_TOKEN, GITHUB_REPOSITORY })) {
  if (!v) { console.error(`::error::Missing required env var ${k}`); process.exit(1); }
}
const [owner, repo] = GITHUB_REPOSITORY.split('/');
const maxTurns = process.env.BABYSIT_MAX_TURNS || '15';
const maxDiffBytes = Number(process.env.MAX_DIFF_BYTES || '60000');
const maxLogLines = Number(process.env.MAX_LOG_LINES || '200');
const rerunCap = Number(process.env.RERUN_CAP || '2');
const ghOpts = { token: GITHUB_TOKEN };

if (!existsSync('prs.json')) { console.error('::error::prs.json not found — fetch step must run first'); process.exit(1); }
const prs = JSON.parse(readFileSync('prs.json', 'utf8'));
if (prs.length === 0) { writeFileSync('decisions.json', '[]'); console.log('No PRs to assess.'); process.exit(0); }

const L1 = readFileSync(new URL('./babysit-prompt.md', import.meta.url), 'utf8');

// ---- state gathering (all read-only) ----

// Timeline lifecycle events + issue comments (for markers). REST timeline
// exposes the custom copilot_work_started/finished events; issue comments carry
// our hidden markers.
function getTimeline(number) {
  return ghJson(['api', `repos/${owner}/${repo}/issues/${number}/timeline`, '--paginate'], ghOpts);
}
function getComments(number) {
  const raw = ghJson(['api', `repos/${owner}/${repo}/issues/${number}/comments`, '--paginate'], ghOpts);
  return raw.map((c) => ({ body: c.body, createdAt: c.created_at }));
}
function getReviewThreads(number) {
  const data = ghGraphql(`
    { repository(owner:"${owner}", name:"${repo}") { pullRequest(number:${number}) {
      reviewThreads(first:100) { nodes {
        isResolved
        comments(first:1){ nodes { author{login} body path } }
      } } } } }`, ghOpts);
  return data.repository.pullRequest.reviewThreads.nodes.map((t) => ({
    isResolved: t.isResolved,
    author: t.comments.nodes[0]?.author?.login || '',
    body: t.comments.nodes[0]?.body || '',
    path: t.comments.nodes[0]?.path || '',
  }));
}
function getChecks(number) {
  const d = ghJson(['pr', 'view', String(number), '--repo', `${owner}/${repo}`, '--json', 'statusCheckRollup'], ghOpts);
  return classifyChecks(d.statusCheckRollup || []);
}
function getDiff(number) {
  const d = gh(['pr', 'diff', String(number), '--repo', `${owner}/${repo}`], ghOpts);
  return d.length > maxDiffBytes ? d.slice(0, maxDiffBytes) + `\n\n… [diff truncated at ${maxDiffBytes} bytes] …` : d;
}
function getFailingLog(runId) {
  if (!runId) return '(no run id available for this check)';
  try {
    const log = gh(['run', 'view', runId, '--repo', `${owner}/${repo}`, '--log-failed'], ghOpts);
    const lines = log.split('\n');
    return lines.slice(-maxLogLines).join('\n');
  } catch (e) {
    return `(could not fetch log for run ${runId}: ${String(e.message).slice(0, 120)})`;
  }
}

// Newest lifecycle event of a given type from the timeline.
function newestEvent(timeline, event) {
  const ts = timeline.filter((e) => e.event === event).map((e) => new Date(e.created_at || e.submitted_at));
  return newestOf(ts);
}

// ---- Claude session (read-only reasoning) ----
function runClaude(taskPrompt) {
  const stdout = execFileSync('claude', [
    '-p', taskPrompt,
    '--append-system-prompt', L1,
    '--allowedTools', 'Read', 'Grep', 'Glob',
    '--max-turns', maxTurns,
    '--model', BABYSIT_MODEL,
    '--output-format', 'json',
  ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, env: process.env });
  const envelope = JSON.parse(stdout);
  return envelope.result ?? envelope.text ?? '';
}
// Balanced first {...}, string-aware (prompts may embed braces/quotes/newlines).
function extractJson(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('no JSON object in model output');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('no balanced JSON object in model output');
}

// ---- main loop ----
const decisions = [];
for (const pr of prs) {
  const n = pr.number;
  console.log(`\n=== Assessing #${n}: ${pr.title} ===`);
  const base = { prNumber: n, title: pr.title, url: pr.url };
  try {
    const timeline = getTimeline(n);
    const markers = parseMarkers(getComments(n));

    const workStarted = newestEvent(timeline, 'copilot_work_started');
    const workFinished = newestEvent(timeline, 'copilot_work_finished');
    const newestPing = newestOf(markers.filter((m) => m.kind === 'ping').map((m) => m.ts));
    const newestReady = newestOf(markers.filter((m) => m.kind === 'ready').map((m) => m.ts));

    // (1) Idempotency gate.
    // Copilot is mid-flight if work_started is the latest lifecycle event.
    const idle = !workStarted || (workFinished && workFinished >= workStarted);
    // We have an outstanding ping if our newest ping post-dates the newest
    // work_started (Copilot hasn't picked it up yet — the trigger-lag race).
    const pingOutstanding = newestPing && (!workStarted || newestPing > workStarted);
    if (!idle) { console.log('  gate: Copilot mid-flight → skip'); decisions.push({ ...base, action: 'skip', reason: 'copilot working' }); continue; }
    if (pingOutstanding) { console.log('  gate: ping outstanding, not yet started → skip'); decisions.push({ ...base, action: 'skip', reason: 'ping not yet picked up' }); continue; }

    // Re-arm note: if a PR was already marked ready, we only continue past here
    // when new Copilot work happened after that ready-marker (human nits →
    // work_started). Otherwise it's terminal-and-quiet → skip (don't re-post).
    const alreadyPosted = newestReady && (!workStarted || newestReady >= workStarted);
    if (alreadyPosted) { console.log('  already posted ready + no new work since → skip'); decisions.push({ ...base, action: 'skip', reason: 'ready already posted' }); continue; }

    // (2) Comments first.
    const threads = getReviewThreads(n);
    const openReviewer = threads.filter((t) => !t.isResolved && t.author === COPILOT_REVIEWER);
    const checks = getChecks(n);
    const failing = checks.filter((c) => c.state === 'fail');
    const pending = checks.filter((c) => c.state === 'pending');

    if (openReviewer.length > 0) {
      console.log(`  ${openReviewer.length} unresolved reviewer thread(s) → Claude synthesises fix instruction`);
      const task =
        `A GitHub Copilot pull request has unresolved automated review comments. Explore the repository to understand them, then return the decision JSON with action "ping".\n\n` +
        `PR #${n}: ${pr.title}\n\nUnresolved review threads from ${COPILOT_REVIEWER}:\n` +
        openReviewer.map((t, i) => `\n[${i + 1}] file: ${t.path}\n${t.body}`).join('\n') +
        `\n\nDiff under review:\n\`\`\`diff\n${getDiff(n)}\n\`\`\``;
      const out = extractJson(runClaude(task));
      decisions.push({ ...base, action: 'ping', instruction: out.instruction, reason: out.reason || `${openReviewer.length} review thread(s)` });
      console.log(`  → ping (${openReviewer.length} thread(s))`);
      continue;
    }

    // (3) CI — only reached when the comment queue is empty.
    if (pending.length > 0) { console.log('  CI still pending, no open comments → skip (wait)'); decisions.push({ ...base, action: 'skip', reason: 'CI pending' }); continue; }

    if (failing.length > 0) {
      // How many times have we already re-run each failing check? (cap guard)
      const rerunCounts = {};
      for (const m of markers.filter((m) => m.kind === 'rerun' && m.check)) rerunCounts[m.check] = (rerunCounts[m.check] || 0) + 1;

      const task =
        `A GitHub Copilot pull request has failing CI checks. For EACH failing check decide whether the failure is caused by this PR's changes ("caused-by-pr") or is flaky/infra/unrelated ("flaky"). Explore the repository as needed, then return the decision JSON.\n\n` +
        `PR #${n}: ${pr.title}\n\nFailing checks and the tail of each failing job log:\n` +
        failing.map((c) => `\n### check: ${c.name} (rerun so far: ${rerunCounts[c.name] || 0}/${rerunCap})\n\`\`\`\n${getFailingLog(c.runId)}\n\`\`\``).join('\n') +
        `\n\nDiff under review:\n\`\`\`diff\n${getDiff(n)}\n\`\`\``;
      const out = extractJson(runClaude(task));

      // Model returns per-check verdicts; we split into rerun vs ping and apply the cap.
      const verdicts = Array.isArray(out.checks) ? out.checks : [];
      const rerun = [], causedBy = [];
      for (const c of failing) {
        const v = verdicts.find((x) => x.name === c.name);
        const verdict = v?.verdict || 'caused-by-pr'; // unknown → treat as real (safer)
        if (verdict === 'flaky') {
          if ((rerunCounts[c.name] || 0) >= rerunCap) { causedBy.push({ ...c, note: 'flaky but rerun cap reached → escalate' }); }
          else rerun.push({ name: c.name, runId: c.runId });
        } else causedBy.push({ ...c });
      }

      if (rerun.length > 0 && causedBy.length === 0) {
        decisions.push({ ...base, action: 'rerun', rerun, reason: out.reason || `${rerun.length} flaky check(s)` });
        console.log(`  → rerun ${rerun.map((r) => r.name).join(', ')}`);
      } else if (causedBy.length > 0) {
        // Real breakage (possibly alongside flakes) → ping Copilot to fix. We do
        // NOT rerun in the same tick; the fix-commit re-triggers CI anyway.
        decisions.push({ ...base, action: 'ping', instruction: out.instruction, reason: out.reason || `${causedBy.length} PR-caused failure(s)` });
        console.log(`  → ping (CI: ${causedBy.map((c) => c.name).join(', ')})`);
      } else {
        decisions.push({ ...base, action: 'skip', reason: 'no actionable CI verdict' });
      }
      continue;
    }

    // (4) Terminal: idle, no open reviewer threads, CI green.
    decisions.push({ ...base, action: 'ready', reason: 'CI green, reviews resolved, agent idle' });
    console.log('  → ready for review');
  } catch (err) {
    const msg = (err.stderr || err.message || String(err)).toString().slice(0, 400);
    console.error(`::warning::#${n}: assess failed: ${msg}`);
    decisions.push({ ...base, action: 'skip', reason: `assess error: ${msg}` });
  }
}

writeFileSync('decisions.json', JSON.stringify(decisions, null, 2));
console.log(`\nWrote decisions.json (${decisions.length} decision(s)).`);
