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
// Env optional: BABYSIT_MAX_TURNS (15), MAX_DIFF_BYTES (60000), MAX_LOG_LINES (200), MAX_LOG_BYTES (40000), RERUN_CAP (2)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  gh, ghJson, ghGraphql, COPILOT_REVIEWER,
  parseMarkers, newestOf, groupChecks, BABYSITTER_MARKER_AUTHORS,
} from './lib.mjs';

const { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, BABYSIT_MODEL, GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;
for (const [k, v] of Object.entries({ ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, BABYSIT_MODEL, GITHUB_TOKEN, GITHUB_REPOSITORY })) {
  if (!v) { console.error(`::error::Missing required env var ${k}`); process.exit(1); }
}
const [owner, repo] = GITHUB_REPOSITORY.split('/');
const maxTurns = process.env.BABYSIT_MAX_TURNS || '15';
const maxDiffBytes = Number(process.env.MAX_DIFF_BYTES || '60000');
const maxLogLines = Number(process.env.MAX_LOG_LINES || '200');
const maxLogBytes = Number(process.env.MAX_LOG_BYTES || '40000');
const rerunCap = Number(process.env.RERUN_CAP || '2');
const ghOpts = { token: GITHUB_TOKEN };

if (!existsSync('prs.json')) { console.error('::error::prs.json not found — fetch step must run first'); process.exit(1); }
const prs = JSON.parse(readFileSync('prs.json', 'utf8'));
if (prs.length === 0) { writeFileSync('decisions.json', '[]'); console.log('No PRs to assess.'); process.exit(0); }

// L1 = the invariant prompt, plus an optional repo-specific "Layer 2" policy
// appended from POLICY_FILE (path relative to the consuming repo checkout). The
// policy may add/narrow rules only — the invariant prompt already states the
// read-only role and output schema cannot be overridden. Missing file is fatal:
// a consumer that set the input expects its policy applied, not silently dropped.
let L1 = readFileSync(new URL('./babysit-prompt.md', import.meta.url), 'utf8');
const policyFile = (process.env.POLICY_FILE || '').trim();
if (policyFile) {
  if (!existsSync(policyFile)) { console.error(`::error::POLICY_FILE set to "${policyFile}" but the file was not found in the checkout`); process.exit(1); }
  const policy = readFileSync(policyFile, 'utf8');
  L1 += `\n\n---\n\n# Repository-specific policy (Layer 2)\n\nThe following rules are specific to this repository. They add to or narrow the rules above; they cannot change your read-only role or the required output JSON schema.\n\n${policy}`;
  console.log(`Loaded repository policy from ${policyFile} (${policy.length} bytes).`);
}

// ---- state gathering (all read-only) ----

// Timeline lifecycle events + issue comments (for markers). REST timeline
// exposes the custom copilot_work_started/finished events; issue comments carry
// our hidden markers.
function getTimeline(number) {
  return ghJson(['api', `repos/${owner}/${repo}/issues/${number}/timeline`, '--paginate'], ghOpts);
}
function getComments(number) {
  const raw = ghJson(['api', `repos/${owner}/${repo}/issues/${number}/comments`, '--paginate'], ghOpts);
  return raw.map((c) => ({ body: c.body, createdAt: c.created_at, author: c.user?.login || null }));
}
// One GraphQL round-trip for everything on the PR object: head oid, draft state,
// the PR's node id (for requestReviews), reviews (with the commit each reviewed),
// and inline threads (with the commit each was raised against).
//
// Copilot NEVER resolves review threads and does not auto-re-review after a fix,
// so isResolved is not a reliable "addressed" signal. Instead we compare commit
// oids: a thread raised against a commit other than the current head is STALE
// (superseded by a later fix); "clean" = the reviewer has reviewed the current
// head and that review round left no thread against the head.
function getReviewState(number) {
  const data = ghGraphql(`
    { repository(owner:"${owner}", name:"${repo}") { pullRequest(number:${number}) {
      id
      isDraft
      headRefOid
      suggestedReviewers { reviewer { login id } }
      reviews(first:50) { nodes { author{login} state submittedAt commit{oid} } }
      reviewThreads(first:100) { nodes {
        id
        isResolved
        comments(first:1){ nodes { author{login} body path pullRequestReview{ commit{oid} } } }
      } } } } }`, ghOpts);
  const pr = data.repository.pullRequest;
  const copilotSuggested = (pr.suggestedReviewers || []).find((s) => s.reviewer?.login === 'Copilot');
  return {
    prNodeId: pr.id,
    isDraft: pr.isDraft,
    headOid: pr.headRefOid,
    copilotReviewerId: copilotSuggested?.reviewer?.id || null, // requestable bot id, if offered
    reviews: pr.reviews.nodes.map((r) => ({
      author: r.author?.login || '', state: r.state, submittedAt: r.submittedAt,
      commitOid: r.commit?.oid || null,
    })),
    threads: pr.reviewThreads.nodes.map((t) => {
      const c = t.comments.nodes[0];
      const reviewCommitOid = c?.pullRequestReview?.commit?.oid || null;
      return {
        id: t.id,
        isResolved: t.isResolved,
        author: c?.author?.login || '',
        body: c?.body || '',
        path: c?.path || '',
        reviewCommitOid,
        isStale: reviewCommitOid !== null && reviewCommitOid !== pr.headRefOid,
      };
    }),
  };
}
// CI via REST (checks:read / statuses:read) — avoids the statusCheckRollup
// GraphQL path, which the default GITHUB_TOKEN cannot access on some repos.
function getChecks(sha) {
  // check-runs returns an object ({total_count, check_runs:[…]}), not a top-level
  // array. --paginate emits one object per page; --slurp wraps them in an array so
  // we can flatMap rather than JSON.parse failing on concatenated objects.
  const pages = ghJson(['api', `repos/${owner}/${repo}/commits/${sha}/check-runs`, '--paginate', '--slurp'], ghOpts);
  const checkRuns = pages.flatMap((p) => p.check_runs || []);
  const approvalRuns = ghJson(['api', `repos/${owner}/${repo}/actions/runs?head_sha=${sha}&status=action_required`], ghOpts);
  // GitHub returns two distinct cases under status=action_required:
  //   - status=queued/in_progress, conclusion=null: truly pending, awaiting the human "Approve and run" click
  //   - status=completed, conclusion=action_required: already rejected by the gate; rerun re-queues but hits the gate again
  // Only the pending ones are approvable via POST /approve (fork-PR gate); completed ones need a human click.
  // We surface both as approvalRunIds (the apply step handles pending via approve API, escalates on 403);
  // we also expose rejectedApprovalRunIds so assess can escalate directly when all runs are already completed.
  const allApprovalRuns = approvalRuns.workflow_runs || [];
  const approvalRunIds = allApprovalRuns.filter((r) => r.status !== 'completed').map((r) => r.id);
  const rejectedApprovalRunIds = allApprovalRuns.filter((r) => r.status === 'completed').map((r) => r.id);
  const st = ghJson(['api', `repos/${owner}/${repo}/commits/${sha}/status`], ghOpts);
  const { checks, incomplete, unknownConclusions } = groupChecks({ checkRuns, statuses: st.statuses || [] });
  return { checks, incomplete, unknownConclusions, approvalRunIds, rejectedApprovalRunIds };
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
    // Cap by lines first, then by bytes: MAX_LOG_LINES bounds a normal log, but a
    // job emitting very long lines (minified bundles, base64) can still blow the
    // prompt past what stdin/context should carry. Keep the TAIL of both.
    let tail = lines.slice(-maxLogLines).join('\n');
    if (tail.length > maxLogBytes) tail = `… [log head truncated to last ${maxLogBytes} bytes] …\n` + tail.slice(-maxLogBytes);
    return tail;
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
// The task prompt is piped via STDIN, not passed as an argv element. It embeds
// CI log tails + the PR diff, which for a large PR exceeds the Linux per-string
// argv limit (MAX_ARG_STRLEN, 128 KiB) and the kernel rejects the spawn with
// E2BIG — independent of the ~2 MB total ARG_MAX. `claude -p` with no positional
// prompt reads the prompt from stdin, so stdin bypasses the limit entirely. Only
// L1 (the small system prompt) stays in argv.
// Structured-output contract for the decision object. Passed to `claude` via
// --json-schema so the model MUST emit valid RFC 8259 JSON at the tool-call
// layer — this is what stops claude-opus-4-8 (via the LEGO proxy) from emitting
// JS-style output with unquoted keys / trailing commas that JSON.parse rejects.
const DECISION_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['ready', 'ping', 'rerun', 'wait', 'escalate'] },
    instruction: { type: 'string' },
    checks: { type: 'array', items: { type: 'string' } },
    obstacleKey: { type: 'string' },
    reason: { type: 'string' },
    resolveThreads: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
        required: ['id'],
      },
    },
  },
  required: ['action'],
});
function runClaude(taskPrompt) {
  const stdout = execFileSync('claude', [
    '-p',
    '--append-system-prompt', L1,
    '--allowedTools', 'Read', 'Grep', 'Glob',
    '--max-turns', maxTurns,
    '--model', BABYSIT_MODEL,
    '--output-format', 'json',
    '--json-schema', DECISION_SCHEMA,
  ], { input: taskPrompt, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const envelope = JSON.parse(stdout);
  // With --json-schema the proxy MAY surface .result already parsed as an
  // object; return it as-is (object or string) and let the call site normalise.
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
  let gathererFailed = false;
  try {
    let timeline;
    try {
      timeline = getTimeline(n);
    } catch (e) {
      gathererFailed = true;
      console.log(`::warning::#${n}: getTimeline failed: ${e.message}`);
      timeline = [];
    }

    let comments;
    try {
      comments = getComments(n);
    } catch (e) {
      gathererFailed = true;
      console.log(`::warning::#${n}: getComments failed: ${e.message}`);
      comments = [];
    }

    const markers = parseMarkers(comments);

    const workStarted = newestEvent(timeline, 'copilot_work_started');
    const workFinished = newestEvent(timeline, 'copilot_work_finished');
    const reviewedAt = newestEvent(timeline, 'reviewed');
    const newestPing = newestOf(markers.filter((m) => m.kind === 'ping').map((m) => m.ts));
    const newestReady = newestOf(markers.filter((m) => m.kind === 'ready').map((m) => m.ts));

    // (1) Idempotency gate.
    // Copilot is mid-flight only during a CODING cycle. It fires
    // copilot_work_started for REVIEW cycles too, but those close with a
    // `reviewed` event and NEVER emit copilot_work_finished. So a bare
    // work_started that is followed by a `reviewed` event is a completed review,
    // not active coding — otherwise every reviewed PR would deadlock the gate.
    // Idle = latest lifecycle-closing event (work_finished OR reviewed) is at or
    // after the latest work_started.
    const workClosed = newestOf([workFinished, reviewedAt].filter(Boolean));
    const idle = !workStarted || (workClosed && workClosed >= workStarted);
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
    let isDraft, headOid, reviews, threads, prNodeId, copilotReviewerId;
    try {
      ({ isDraft, headOid, reviews, threads, prNodeId, copilotReviewerId } = getReviewState(n));
    } catch (e) {
      gathererFailed = true;
      console.log(`::warning::#${n}: getReviewState failed: ${e.message}`);
      throw e; // still fatal — we need headOid; propagate to outer catch
    }

    let checks, incomplete, unknownConclusions, approvalRunIds, rejectedApprovalRunIds;
    try {
      ({ checks, incomplete, unknownConclusions, approvalRunIds, rejectedApprovalRunIds } = getChecks(headOid));
    } catch (e) {
      gathererFailed = true;
      console.log(`::warning::#${n}: getChecks failed: ${e.message}`);
      throw e; // still fatal; propagate
    }

    // Pending approval: runs queued/in_progress but awaiting the "Approve and run" click.
    // Attempt auto-approve (works for fork PRs); apply falls back to Teams escalation on 403.
    if (approvalRunIds.length > 0) {
      console.log(`  ${approvalRunIds.length} workflow run(s) awaiting approval → approve-workflows`);
      decisions.push({ ...base, action: 'approve-workflows', approvalRunIds, reason: `${approvalRunIds.length} run(s) pending approval` });
      continue;
    }
    // Rejected by gate: runs already completed with conclusion=action_required.
    // Re-running them with a TRUSTED collaborator's token (copilot-token, not the
    // github-actions bot) clears the gate — GitHub treats a rerun by a trusted actor
    // as approval. Apply reruns with copilot-token; falls back to Teams only on error.
    if (rejectedApprovalRunIds.length > 0) {
      console.log(`  ${rejectedApprovalRunIds.length} workflow run(s) blocked by approval gate → rerun-gated (copilot-token clears the gate)`);
      decisions.push({ ...base, action: 'rerun-gated', rejectedApprovalRunIds, reason: `${rejectedApprovalRunIds.length} run(s) blocked at approval gate` });
      continue;
    }

    const FAIL_CONCLUSIONS_LOCAL = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

    // A check is "currently failing" if its latest attempt's conclusion is failing
    const currentlyFailing = checks.filter((c) => {
      const latest = c.attempts[c.attempts.length - 1];
      return latest && FAIL_CONCLUSIONS_LOCAL.has(latest.conclusion);
    });
    // A check is "currently pending" if its latest attempt's status is not 'completed'
    const currentlyPending = checks.filter((c) => {
      const latest = c.attempts[c.attempts.length - 1];
      return latest && latest.status !== 'completed';
    });

    // How many times have we already re-run each failing check? (rerun cap guard)
    // Trusted-author markers only — a third party could otherwise fake reruns.
    const trustedMarkers = markers.filter((m) => BABYSITTER_MARKER_AUTHORS.has(m.author));
    const rerunCounts = {};
    for (const m of trustedMarkers.filter((m) => m.kind === 'rerun' && m.check)) {
      rerunCounts[m.check] = (rerunCounts[m.check] || 0) + 1;
    }

    // Obstacle-cap ledger helpers (trusted authors only). An attempt marker is
    // keyed by (obstacle_key, head_oid); once we hit the cap we escalate once.
    const countAttempts = (obstacleKey, headOid2) =>
      trustedMarkers.filter(
        (m) => m.kind === 'attempt' && m.data?.obstacle === obstacleKey && m.data?.head === headOid2,
      ).length;

    const hasEscalated = (obstacleKey, headOid2) =>
      trustedMarkers.some(
        (m) => m.kind === 'escalated' && m.data?.obstacle === obstacleKey && m.data?.head === headOid2,
      );

    // Match a model-supplied check name to a real check name resiliently: exact
    // first, else compare with any trailing parenthetical stripped and whitespace/
    // case normalised (a model may echo the "(rerun so far: N/M)" hint or re-case).
    // Deliberately NOT startsWith/contains — a prefix name (build vs build-app)
    // would cross-bind.
    const norm = (s) => String(s || '').toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, ' ').trim();

    // ---- (3) Unified judgment ----
    // When idle we ALWAYS call the model (no pre-model actionable/failing gate):
    // it judges the PR against the Definition of Done (invariant prompt + any repo
    // policy in L1) and returns ONE action: ready | ping | rerun | wait | escalate.
    // Deterministic seatbelts (obstacle cap, rerun cap, completeness veto) override
    // the model's choice below.
    const failingChecksText = currentlyFailing.length === 0
      ? '(No currently-failing CI checks.)'
      : `Currently-failing checks (full detail + log tail):\n` +
        currentlyFailing.map((c) =>
          `### check: ${c.name}\nAll attempts: ${c.attempts.map((a) => a.conclusion ?? a.status).join(' → ')}\nLatest runId: ${c.runId}\nRerun count so far: ${rerunCounts[c.name] || 0}/${rerunCap}\n\`\`\`\n${getFailingLog(c.runId)}\n\`\`\``
        ).join('\n\n');

    const passingChecks = checks.filter((c) => !currentlyFailing.includes(c) && !currentlyPending.includes(c));
    const passingText = passingChecks.length === 0
      ? '(No passing checks.)'
      : `Passing checks (${passingChecks.length}): ${passingChecks.map((c) => c.name).join(', ')}`;

    const pendingText = currentlyPending.length === 0
      ? ''
      : `Pending checks (${currentlyPending.length}): ${currentlyPending.map((c) => c.name).join(', ')}\n`;

    const allChecksAttempts = checks.map((c) =>
      `${c.name}: [${c.attempts.map((a) => a.conclusion ?? a.status).join(', ')}]`
    ).join('\n');

    const task =
      `Decide the next action for this GitHub Copilot pull request against the Definition of Done in your instructions.\n\n` +
      `PR #${n}: ${pr.title}\nHead commit: ${headOid}\n\n` +
      `## CI Checks\n\n${passingText}\n\n${pendingText}${failingChecksText}\n\n` +
      `All checks (name: [attempt conclusions in order]):\n${allChecksAttempts}\n\n` +
      `## Reviewer threads\n\n` +
      (threads.length === 0
        ? '(No reviewer threads.)'
        : threads.map((t, i) =>
            `[${i + 1}] id: ${t.id}\npath: ${t.path}\nauthor: ${t.author}\nisResolved: ${t.isResolved}\nisStale: ${t.isStale}\n${t.body}`
          ).join('\n\n')
      ) +
      `\n\n## Marker/ledger history (trusted authors only)\n\n` +
      (trustedMarkers.length === 0
        ? '(No markers yet.)'
        : trustedMarkers.map((m) =>
            `${m.ts.toISOString()} [${m.kind}]${m.check ? ` check:${m.check}` : ''}${m.data ? ` data:${JSON.stringify(m.data)}` : ''}${m.author ? ` by:${m.author}` : ''}`
          ).join('\n')
      ) +
      `\n\n## Approval-gate state\n\n` +
      (approvalRunIds.length > 0
        ? `${approvalRunIds.length} run(s) awaiting approval: ${approvalRunIds.join(', ')}`
        : rejectedApprovalRunIds.length > 0
          ? `${rejectedApprovalRunIds.length} run(s) rejected by gate: ${rejectedApprovalRunIds.join(', ')}`
          : '(No approval-gate issues.)'
      ) +
      `\n\nYour action vocabulary: ready | ping | rerun | wait | escalate.\n` +
      `- ready: PR meets DoD, all checks passing, no open threads on current head\n` +
      `- ping: Send a fix instruction to the Copilot agent (include "instruction" field and "obstacleKey" field: "check:<normname>" or "thread:<id>")\n` +
      `- rerun: Re-run flaky checks (include "checks" array with exact check names)\n` +
      `- wait: Nothing actionable right now (CI pending, or watching something)\n` +
      `- escalate: PR needs human intervention (include "obstacleKey" field and "reason" field with human-readable explanation)\n\n` +
      `Diff under review:\n\`\`\`diff\n${getDiff(n)}\n\`\`\``;
    // Three-layer parse tolerates a proxy that ignores --json-schema: prefer the
    // already-parsed object / clean JSON string, then fall back to extracting the
    // first balanced {...} from prose-wrapped free text.
    const modelOut = runClaude(task);
    let out;
    try {
      // Fast path: --json-schema yielded a parsed object, or a clean JSON string.
      out = typeof modelOut === 'object' && modelOut !== null ? modelOut : JSON.parse(modelOut);
    } catch {
      try {
        // Fallback: first balanced {...} in prose-wrapped free text.
        out = extractJson(modelOut);
      } catch (innerErr) {
        console.error(`::debug::raw model output for #${n}: ${String(modelOut).slice(0, 2000)}`);
        throw innerErr;
      }
    }

    // Seatbelt: validate the action enum; anything unexpected → wait.
    let action = ['ready', 'ping', 'rerun', 'wait', 'escalate'].includes(out.action) ? out.action : 'wait';
    if (action !== out.action) console.log(`::warning::#${n}: model returned unknown action "${out.action}" → treating as wait`);

    // Sanitize model-proposed thread resolutions: only ids that match a REAL
    // copilot-pull-request-reviewer thread we actually gathered survive — a
    // fabricated or human-authored thread id must never be resolved on the
    // model's say-so. Attach to `base` so every decision pushed for this PR
    // from here on (ping/wait/escalate/ready/undraft/request-review) carries
    // it through to decisions.json for apply to act on.
    const copilotThreadIds = new Set(threads.filter((t) => t.author === COPILOT_REVIEWER).map((t) => t.id));
    const resolveThreads = (Array.isArray(out.resolveThreads) ? out.resolveThreads : [])
      .filter((rt) => {
        const ok = rt && typeof rt.id === 'string' && copilotThreadIds.has(rt.id);
        if (!ok) console.log(`::warning::#${n}: model proposed resolving thread "${rt?.id}" which is not a known copilot-reviewer thread → dropped`);
        return ok;
      })
      .map((rt) => ({ id: rt.id, reason: String(rt.reason || '').trim() }));
    if (resolveThreads.length > 0) base.resolveThreads = resolveThreads;

    if (action === 'rerun') {
      // Model judged the failing check(s) flaky. Resolve names to real failing
      // checks and apply the rerun cap. Over-cap or unnamed → wait (suppress-only;
      // never fabricate a ping — the model is the sole originator of pings).
      const named = new Set((Array.isArray(out.checks) ? out.checks : []).map(norm));
      const toRerun = [];
      for (const c of currentlyFailing) {
        if (named.has(norm(c.name)) && (rerunCounts[c.name] || 0) < rerunCap) {
          toRerun.push({ name: c.name, runId: c.runId });
        }
      }
      if (toRerun.length > 0) {
        decisions.push({ ...base, headOid, modelAction: out.action, appliedAction: 'rerun', action: 'rerun', rerun: toRerun, reason: out.reason || `${toRerun.length} flaky check(s)` });
        console.log(`  → rerun ${toRerun.map((r) => r.name).join(', ')}`);
      } else {
        console.log('  → wait (rerun: no named checks under cap)');
        decisions.push({ ...base, headOid, modelAction: out.action, appliedAction: 'wait', action: 'skip', reason: 'model said rerun but no named failing check under cap → wait' });
      }
      continue;
    }

    if (action === 'wait') {
      console.log(`  → wait (${out.reason || 'not ready, nothing actionable'})`);
      decisions.push({ ...base, headOid, modelAction: out.action, appliedAction: 'wait', action: 'skip', reason: out.reason || 'not ready, nothing actionable' });
      continue;
    }

    if (action === 'ping') {
      const instruction = String(out.instruction || '').trim();
      if (!instruction) {
        console.log('  → wait (model chose ping but supplied no instruction)');
        decisions.push({ ...base, headOid, modelAction: out.action, appliedAction: 'wait', action: 'skip', reason: 'ping with empty instruction → wait' });
        continue;
      }
      const obstacleKey = String(out.obstacleKey || '').trim() || `pr:${n}`;
      const attemptCount = countAttempts(obstacleKey, headOid);
      if (attemptCount >= 2) {
        if (hasEscalated(obstacleKey, headOid)) {
          console.log(`  → skip (already escalated for ${obstacleKey} on ${headOid})`);
          decisions.push({ ...base, headOid, modelAction: out.action, appliedAction: 'skip', action: 'skip', obstacleKey, reason: 'already escalated for this obstacle on this head' });
        } else {
          console.log(`  → escalate (obstacle cap reached: ${attemptCount} attempts for ${obstacleKey})`);
          decisions.push({ ...base, headOid, modelAction: out.action, appliedAction: 'escalate', action: 'escalate', obstacleKey, reason: `Obstacle cap reached after ${attemptCount} attempts: ${obstacleKey} unresolved on ${headOid}` });
        }
      } else {
        decisions.push({ ...base, headOid, modelAction: out.action, appliedAction: 'ping', action: 'ping', obstacleKey, instruction, reason: out.reason || 'model: action required on this PR' });
        console.log('  → ping');
      }
      continue;
    }

    if (action === 'escalate') {
      const obstacleKey = String(out.obstacleKey || '').trim() || `pr:${n}`;
      const reason = String(out.reason || '').trim() || `PR #${n} needs human intervention`;
      if (hasEscalated(obstacleKey, headOid)) {
        console.log(`  → skip (already escalated for ${obstacleKey} on ${headOid})`);
        decisions.push({ ...base, headOid, modelAction: out.action, appliedAction: 'skip', action: 'skip', obstacleKey, reason: 'already escalated for this obstacle on this head' });
      } else {
        console.log(`  → escalate (model-chosen: ${reason})`);
        decisions.push({ ...base, headOid, modelAction: out.action, appliedAction: 'escalate', action: 'escalate', obstacleKey, reason });
      }
      continue;
    }

    if (action === 'ready') {
      // Completeness veto: if snapshot is incomplete, downgrade ready → wait
      if (incomplete || gathererFailed) {
        console.log(`  completeness veto: snapshot incomplete (incomplete=${incomplete}, gathererFailed=${gathererFailed}) → wait`);
        decisions.push({ ...base, headOid, modelAction: out.action, appliedAction: 'wait', action: 'skip', reason: 'snapshot incomplete — downgrading ready to wait' });
        continue;
      }
      const readyNote = String(out.reason || 'ready per definition of done').slice(0, 240);
      // Terminal region: deterministic follow-through on a model ready. Copilot
      // only reviews a PR once it is marked ready for review (it does NOT review
      // drafts), so the babysitter itself un-drafts to TRIGGER the review; the
      // human-facing Teams post waits until that review comes back clean.
      if (isDraft) {
        console.log('  model said ready → undraft (triggers Copilot review)');
        decisions.push({ ...base, headOid, modelAction: out.action, appliedAction: 'undraft', action: 'undraft', reason: 'ready per DoD, agent idle — un-draft to trigger Copilot review' });
        continue;
      }
      // Not a draft, ready per DoD. Copilot does NOT auto-re-review after a fix, so
      // we must EXPLICITLY re-request its review whenever the head is not yet reviewed.
      const reviewedCurrentHead = reviews.some((r) => r.author === COPILOT_REVIEWER && r.commitOid === headOid);
      if (!reviewedCurrentHead) {
        // Guard against re-requesting every tick: only request if our newest
        // request-review marker predates the current head's latest work activity.
        const newestReqReview = newestOf(trustedMarkers.filter((m) => m.kind === 'reqreview').map((m) => m.ts));
        const reqOutstanding = newestReqReview && workClosed && newestReqReview >= workClosed;
        if (reqOutstanding) {
          console.log('  review of current head already requested, awaiting it → skip');
          decisions.push({ ...base, headOid, modelAction: out.action, appliedAction: 'skip', action: 'skip', reason: 'review requested, awaiting' });
        } else if (!copilotReviewerId) {
          console.log('  current head not reviewed but Copilot reviewer not requestable → skip');
          decisions.push({ ...base, headOid, modelAction: out.action, appliedAction: 'skip', action: 'skip', reason: 'copilot reviewer not requestable' });
        } else {
          console.log('  current head not reviewed → request Copilot review');
          decisions.push({ ...base, headOid, modelAction: out.action, appliedAction: 'request-review', action: 'request-review', prNodeId, copilotReviewerId, reason: 'trigger Copilot review of current head' });
        }
      } else {
        decisions.push({ ...base, headOid, modelAction: out.action, appliedAction: 'ready', action: 'ready', reason: readyNote, readyNote });
        console.log('  → ready for review');
      }
      continue;
    }
  } catch (err) {
    const stderr = (err.stderr || '').toString().slice(0, 600);
    const msg = (err.message || String(err)).toString().slice(0, 400);
    if (stderr) console.error(`::warning::#${n}: assess stderr: ${stderr}`);
    console.error(`::warning::#${n}: assess failed: ${msg}`);
    decisions.push({ ...base, action: 'skip', reason: `assess error: ${msg}` });
  }
}

writeFileSync('decisions.json', JSON.stringify(decisions, null, 2));
console.log(`\nWrote decisions.json (${decisions.length} decision(s)).`);
