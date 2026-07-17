#!/usr/bin/env node
// babysit-apply.mjs
// Deterministic side-effects step. Reads decisions.json and, per PR:
//   ping   → post an @copilot comment with the synthesised instruction, carrying
//            a hidden ping-marker (also the race guard). Uses COPILOT_TOKEN so
//            the mention authoritatively wakes the coding agent.
//   rerun  → `gh run rerun <id> --failed` for each flaky check, and write one
//            hidden rerun-marker per check (feeds the per-check cap next run).
//   ready  → post the "ready for review" Teams card, then a hidden ready-marker
//            comment LAST (the re-arm anchor).
//   skip   → nothing.
//
// Two tokens (see README): GITHUB_TOKEN for reads/re-runs/comments; COPILOT_TOKEN
// (OAuth user-to-server, Copilot-licensed) to author the @copilot mention that
// actually triggers the agent. Re-runs and markers use GITHUB_TOKEN.
//
// Env required: GITHUB_TOKEN, COPILOT_TOKEN, GITHUB_REPOSITORY, DRY_RUN
// Env optional: TEAMS_WEBHOOK_URL (else ready is logged only)

import { readFileSync, existsSync } from 'node:fs';
import { gh, ghJson, ghGraphql, buildMarker, parseMarkers, BABYSITTER_MARKER_AUTHORS, jiraKeyFromTitle, COPILOT_REVIEWER } from './lib.mjs';

const { GITHUB_TOKEN, COPILOT_TOKEN, GITHUB_REPOSITORY, TEAMS_WEBHOOK_URL, DRY_RUN } = process.env;
const dryRun = DRY_RUN !== 'false'; // default-safe: only explicit "false" mutates
for (const [k, v] of Object.entries({ GITHUB_REPOSITORY })) {
  if (!v) { console.error(`::error::Missing required env var ${k}`); process.exit(1); }
}
const [owner, repo] = GITHUB_REPOSITORY.split('/');
const ghRead = { token: GITHUB_TOKEN };       // reads, re-runs, marker comments
const ghCopilot = { token: COPILOT_TOKEN };   // the @copilot mention (needs to wake the agent)

// -------- side-effect helpers --------

// Post a PR/issue comment. `as` selects which token authors it. Body is passed
// as an argv element (execFileSync, no shell) so markers/newlines are safe.
function postComment(number, body, as) {
  return gh(['pr', 'comment', String(number), '--repo', `${owner}/${repo}`, '--body', body], as);
}
function rerunFailed(runId, as) {
  return gh(['run', 'rerun', String(runId), '--repo', `${owner}/${repo}`, '--failed'], as);
}
function markReady(number, as) {
  return gh(['pr', 'ready', String(number), '--repo', `${owner}/${repo}`], as);
}
// Trigger the Copilot automated review of the current head. The REST
// reviewers-by-login path rejects the bot; the GraphQL requestReviews mutation
// with the bot node id (from suggestedReviewers) is the working trigger.
function requestReview(prNodeId, botId, as) {
  const q = `mutation { requestReviews(input:{pullRequestId:"${prNodeId}", botIds:["${botId}"], union:true}){ pullRequest{ id } } }`;
  const out = JSON.parse(gh(['api', 'graphql', '-f', `query=${q}`], as));
  if (out.errors) throw new Error(`requestReviews: ${JSON.stringify(out.errors).slice(0, 200)}`);
  return out;
}
// Resolve a review thread the model judged wrong/unnecessary (see EDIT 1's
// resolveThreads field). This is the ONLY place threads get resolved — assess
// is read-only.
function resolveReviewThread(threadId, as) {
  const q = `mutation { resolveReviewThread(input:{threadId:"${threadId}"}){ thread{ isResolved } } }`;
  const out = JSON.parse(gh(['api', 'graphql', '-f', `query=${q}`], as));
  if (out.errors) throw new Error(`resolveReviewThread: ${JSON.stringify(out.errors).slice(0, 200)}`);
  return out;
}
// Re-fetch the CURRENT review-thread state for the ready gate (postcondition
// check just before posting the ready card). assess.mjs never vetoes ready on
// threads — this is the sole enforcement point, and it must see the freshest
// state (including any thread just resolved above in this same apply run).
// "Live" = raised by the Copilot reviewer, not yet resolved, and not stale
// (i.e. raised against the CURRENT head, not a since-superseded commit).
function getLiveCopilotThreads(number) {
  const data = ghGraphql(`
    { repository(owner:"${owner}", name:"${repo}") { pullRequest(number:${number}) {
      headRefOid
      reviewThreads(first:100) { nodes {
        id
        isResolved
        comments(first:1){ nodes { author{login} pullRequestReview{ commit{oid} } } }
      } } } } }`, ghRead);
  const pr = data.repository.pullRequest;
  return pr.reviewThreads.nodes
    .map((t) => {
      const c = t.comments.nodes[0];
      const reviewCommitOid = c?.pullRequestReview?.commit?.oid || null;
      return {
        id: t.id,
        isResolved: t.isResolved,
        author: c?.author?.login || '',
        isStale: reviewCommitOid !== null && reviewCommitOid !== pr.headRefOid,
      };
    })
    .filter((t) => t.author === COPILOT_REVIEWER && !t.isResolved && !t.isStale);
}
// Current title/body for the update-pr optimistic-concurrency check. The model
// decided against the assess-time snapshot; if a human edited the description in
// the meantime we must NOT clobber their change — apply re-fetches here and
// compares before writing.
function getPrTitleBody(number) {
  const data = ghGraphql(`
    { repository(owner:"${owner}", name:"${repo}") { pullRequest(number:${number}) {
      title
      body
    } } }`, ghRead);
  const pr = data.repository.pullRequest;
  return { title: pr.title || '', body: pr.body || '' };
}
// Edit the PR title and/or body. Uses GITHUB_TOKEN (the coding agent cannot do
// this — no PR-metadata API access in its environment — which is why this action
// exists). Only the fields provided are changed.
function editPr(number, { title, body }, as) {
  const args = ['pr', 'edit', String(number), '--repo', `${owner}/${repo}`];
  if (title) args.push('--title', title);
  if (body) args.push('--body', body);
  return gh(args, as);
}

// Apply any resolveThreads the model attached to this decision (EDIT 1c/2b/2c).
// Runs for ANY action — a decision can carry pushback on a thread even while
// pinging or waiting on something unrelated. Each entry is independent: one
// failing (comment or resolve mutation) must not abort the others or the rest
// of apply — log a warning and move on.
function applyResolveThreads(d, tag) {
  if (!Array.isArray(d.resolveThreads) || d.resolveThreads.length === 0) return;
  for (const rt of d.resolveThreads) {
    const reasonText = String(rt.reason || '').trim() || 'judged unnecessary/incorrect by the babysitter';
    if (dryRun) { console.log(`  [dry-run] ${tag}: would resolve thread ${rt.id}: ${reasonText}`); continue; }
    try {
      postComment(d.prNumber, `🤖 Babysitter resolved this thread: ${reasonText}`, ghRead);
      resolveReviewThread(rt.id, ghRead);
      console.log(`  ${tag}: resolved review thread ${rt.id} (${reasonText})`);
    } catch (e) {
      console.log(`::warning::${tag}: could not resolve thread ${rt.id} (${String(e.message || e).slice(0, 160)})`);
    }
  }
}

async function notifyTeams(title, facts, link) {
  if (!TEAMS_WEBHOOK_URL) { console.log('::warning::TEAMS_WEBHOOK_URL unset, skipping Teams'); return; }
  const card = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard', version: '1.4',
        body: [
          { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: title, wrap: true },
          { type: 'FactSet', facts },
        ],
        actions: link ? [{ type: 'Action.OpenUrl', title: 'Open PR', url: link }] : [],
      },
    }],
  };
  const res = await fetch(TEAMS_WEBHOOK_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(card),
  });
  if (!res.ok) throw new Error(`teams → ${res.status} ${await res.text()}`);
}

// -------- main --------

if (!existsSync('decisions.json')) { console.error('::error::decisions.json not found — assess step must run first'); process.exit(1); }
const decisions = JSON.parse(readFileSync('decisions.json', 'utf8'));

if (!dryRun && decisions.some((d) => d.action === 'ping')) {
  if (!COPILOT_TOKEN) console.error('::error::COPILOT_TOKEN not set — @copilot pings will not wake the agent');
  else if (/^ghp_|^github_pat_/.test(COPILOT_TOKEN)) console.log('::warning::COPILOT_TOKEN looks like a PAT; the coding agent may not respond. Use an OAuth user-to-server token from a Copilot-licensed account.');
}

const errors = [];
let pinged = 0, reran = 0, ready = 0, undrafted = 0, reviewReqd = 0, approved = 0, skipped = 0, escalated = 0, updatedPr = 0;

// Per-invocation cache of each PR's CURRENT head SHA, so the apply-time staleness
// check (below) hits the API at most once per PR even when a PR carries several
// decisions.
const currentHeadCache = new Map(); // prNumber → current head SHA

for (const d of decisions) {
  const tag = `#${d.prNumber}`;
  try {
    // Apply-time staleness guard. The decision was computed against d.headOid; if
    // the branch has moved since assess ran, every side effect below would target
    // a stale head (a ping instruction, marker, or Teams card for code that no
    // longer exists). Skip and let the next tick re-assess the new head. Only
    // decisions that pin a head (d.headOid present) are guarded — skip-style
    // decisions carry none and must not be blocked.
    if (d.headOid) {
      if (!currentHeadCache.has(d.prNumber)) {
        currentHeadCache.set(d.prNumber, ghJson(['api', `repos/${owner}/${repo}/pulls/${d.prNumber}`], ghRead).head.sha);
      }
      const currentHead = currentHeadCache.get(d.prNumber);
      if (currentHead !== d.headOid) {
        console.log(`  stale: ${tag} head moved ${d.headOid}->${currentHead}, re-assess next tick`);
        skipped++;
        continue;
      }
    }

    // Resolve any model-vetted threads BEFORE the action switch, so this
    // happens even on ping/wait decisions (wait is applied as action:'skip' —
    // see assess.mjs) — a decision can push back on a thread while also
    // asking for unrelated fixes, or while otherwise idle.
    applyResolveThreads(d, tag);

    if (d.action === 'skip') { skipped++; console.log(`  ${tag}: skip — ${d.reason}`); continue; }

    if (d.action === 'ping') {
      // Hard guard: never post a ping with no instruction. A content-less
      // "@copilot" mention tells the agent nothing and just adds noise (seen when
      // a flaky verdict — which carries an empty instruction — reached the ping
      // path). Assess should always supply text; if it somehow didn't, skip.
      if (!String(d.instruction || '').trim()) {
        console.log(`::warning::${tag}: ping decision had an empty instruction — skipping (nothing to tell @copilot)`);
        skipped++;
        continue;
      }
      // Pin the work to THIS PR's branch. Left to itself, Copilot sometimes opens
      // a NEW pull request to carry the change (observed: a ping on one PR spawned
      // a separate stacked PR) instead of committing to the branch under review.
      // That fragments the work and breaks the babysitter's per-PR state machine,
      // so every ping explicitly forbids it.
      const body = `${buildMarker('ping')}\n@copilot ${d.instruction}\n\nMake these changes by committing directly to this pull request's existing branch — do NOT open a new pull request.`;
      if (dryRun) { console.log(`  [dry-run] ${tag}: would @copilot ping + ping-marker\n      instruction: ${String(d.instruction).slice(0, 160)}`); pinged++; continue; }
      postComment(d.prNumber, body, ghCopilot);
      console.log(`  ${tag}: pinged @copilot`);
      pinged++;
      // Record this attempt as a marker so assess can count how many times we've
      // pinged for THIS obstacle on THIS head (the attempt number n feeds the
      // escalate-after-N-attempts policy). n is derived by counting prior trusted
      // attempt markers matching the same obstacle+head, +1 for this ping.
      const pingComments = ghJson(['api', '--paginate', `repos/${owner}/${repo}/issues/${d.prNumber}/comments`], ghRead)
        .map((c) => ({ body: c.body, createdAt: c.created_at, author: c.user?.login ?? null }));
      const priorAttempts = parseMarkers(pingComments).filter((m) =>
        m.kind === 'attempt'
        && m.data?.obstacle === d.obstacleKey
        && m.data?.head === d.headOid
        && BABYSITTER_MARKER_AUTHORS.has(m.author));
      const n = priorAttempts.length + 1;
      // Render a human-friendly obstacle description from the key PREFIX — the raw
      // obstacleKey is an opaque identifier and would be noise in the timeline.
      const obstacleDesc = d.obstacleKey.startsWith('thread:')
        ? 'a review-thread comment'
        : d.obstacleKey.startsWith('check:')
          ? `a failing check (${d.obstacleKey.slice('check:'.length)})`
          : 'this pull request';
      // Marker MUST come first (parseMarkers requires no leading text), then the
      // visible line so the comment reads as something rather than rendering blank.
      const attemptBody = `${buildMarker('attempt', { data: { obstacle: d.obstacleKey, head: d.headOid, n } })}\n`
        + `🔁 Babysitter: attempt ${n}/2 addressing ${obstacleDesc} on this commit. If it is still unresolved after 2 attempts, the babysitter escalates to a human via Teams instead of pinging again.`;
      // Post via gh api (not postComment) so we get the created comment's node_id —
      // `gh pr comment` only returns the URL. Authored by ghRead (github-actions) so
      // assess's trusted-marker count still includes it.
      const created = JSON.parse(gh(['api', '--method', 'POST', `repos/${owner}/${repo}/issues/${d.prNumber}/comments`, '-f', `body=${attemptBody}`], ghRead));
      const nodeId = created.node_id;
      // Minimize as OUTDATED so this ledger comment collapses by default and does
      // not clutter the PR timeline — it stays github-actions-authored so the
      // escalate-after-N cap still counts it. Guarded: a minimize failure must not
      // abort the ping flow or register as an error; the comment simply stays open.
      try {
        gh(['api', 'graphql', '-f', `query=mutation{ minimizeComment(input:{subjectId:\"${nodeId}\", classifier:OUTDATED}){ minimizedComment{ isMinimized } } }`], ghRead);
      } catch (minErr) {
        console.log(`::warning::${tag}: could not minimize attempt marker (${String(minErr.message || minErr).slice(0, 80)}) — it will show but is harmless`);
      }
      console.log(`  ${tag}: recorded attempt n=${n}/2 for obstacle ${d.obstacleKey} (minimized)`);
    } else if (d.action === 'rerun') {
      if (dryRun) { console.log(`  [dry-run] ${tag}: would rerun ${d.rerun.map((r) => r.name).join(', ')} + rerun-marker(s)`); reran += d.rerun.length; continue; }
      // Several failing checks can be SHARDS of the same workflow run (e.g.
      // "tests - 3" and "tests - 4" share one runId). `gh run rerun --failed`
      // re-runs every failed job in the run at once, so we invoke it once per
      // UNIQUE runId — a second call for the same run is rejected with "already
      // running". We still write one marker PER CHECK, because the per-check
      // rerun cap in assess counts markers by check name.
      const rerunOutcome = new Map(); // runId → 'ok' | 'skip' (skip = too old / not retriggerable)
      for (const r of d.rerun) {
        if (!r.runId) { console.log(`    ${tag}: no runId for ${r.name}, cannot rerun`); continue; }
        if (!rerunOutcome.has(r.runId)) {
          try {
            rerunFailed(r.runId, ghRead);
            rerunOutcome.set(r.runId, 'ok');
          } catch (rerunErr) {
            const msg = String(rerunErr.message || rerunErr.stderr || '');
            // GitHub rejects reruns older than 30 days. Non-retryable → skip with a
            // warning rather than surfacing as an error every cycle.
            if (msg.includes('created over a month ago')) {
              console.log(`  ${tag}: run ${r.runId} too old to rerun (>30 days), skipping`);
              rerunOutcome.set(r.runId, 'skip');
            } else if (/already running/i.test(msg)) {
              // The run is already re-running (we just triggered it for a sibling
              // shard, or another actor did). Benign — the CI we wanted is underway.
              console.log(`  ${tag}: run ${r.runId} already running, treating as re-run`);
              rerunOutcome.set(r.runId, 'ok');
            } else {
              throw rerunErr;
            }
          }
        }
        if (rerunOutcome.get(r.runId) !== 'ok') continue; // too old → no marker, matches prior behaviour
        // One marker per check so next run can count against the cap.
        postComment(d.prNumber, `${buildMarker('rerun', { check: r.name })}\n♻️ Re-ran flaky check \`${r.name}\`.`, ghRead);
        console.log(`  ${tag}: re-ran ${r.name}`);
        reran++;
      }

    } else if (d.action === 'undraft') {
      // Mark ready for review — this triggers the Copilot automated review
      // (Copilot does not review drafts). No marker needed: isDraft flips to
      // false, so this branch is naturally not re-entered.
      // Uses COPILOT_TOKEN: the default GITHUB_TOKEN cannot call
      // markPullRequestReadyForReview ("Resource not accessible by integration"),
      // so un-drafting needs the user-to-server token (same as the @copilot ping).
      if (dryRun) { console.log(`  [dry-run] ${tag}: would mark ready for review (triggers Copilot review)`); undrafted++; continue; }
      markReady(d.prNumber, ghCopilot);
      console.log(`  ${tag}: marked ready for review (Copilot review will follow)`);
      undrafted++;

    } else if (d.action === 'rerun-gated') {
      // Workflow runs were blocked by the "Approve workflows to run" gate
      // (conclusion=action_required). Re-running with the copilot-token — a trusted
      // collaborator identity — clears the gate (GitHub treats a rerun by a trusted
      // actor as approval). The github-actions bot token would NOT clear it.
      if (dryRun) { console.log(`  [dry-run] ${tag}: would rerun ${d.rejectedApprovalRunIds.length} gated run(s) with copilot-token`); continue; }
      let rerunThisPr = 0;
      const failedRuns = [];
      for (const runId of d.rejectedApprovalRunIds) {
        try {
          gh(['api', '--method', 'POST', `repos/${owner}/${repo}/actions/runs/${runId}/rerun`], ghCopilot);
          rerunThisPr++;
          reran++;
        } catch (rerunErr) {
          failedRuns.push(`${runId}: ${String(rerunErr.message || '').slice(0, 60)}`);
        }
      }
      if (rerunThisPr > 0) console.log(`  ${tag}: re-ran ${rerunThisPr}/${d.rejectedApprovalRunIds.length} gated run(s) with copilot-token — gate cleared, CI will run`);
      // Only escalate if we could not clear the gate ourselves.
      if (failedRuns.length > 0) {
        console.log(`  ${tag}: ${failedRuns.length} gated rerun(s) failed → escalating to Teams`);
        await notifyTeams(
          `⚠️ PR #${d.prNumber} — workflow approval needed`,
          [
            { title: 'PR', value: `#${d.prNumber}` },
            { title: 'Title', value: d.title },
            { title: 'Reason', value: `CI blocked by the "Approve workflows to run" gate; ${failedRuns.length} run(s) could not be auto-cleared` },
            { title: 'Action', value: 'Click "Approve and run" on the PR Actions tab' },
          ],
          d.url,
        ).catch(() => {});
      }

    } else if (d.action === 'approve-workflows') {
      // Workflow runs are queued but awaiting manual approval (first-time contributor
      // gate). Attempt to auto-approve each run; fall back to a Teams escalation if
      // the token lacks the required permission.
      if (dryRun) { console.log(`  [dry-run] ${tag}: would approve ${d.approvalRunIds.length} pending workflow run(s)`); continue; }
      let approvedThisPr = 0;
      for (const runId of d.approvalRunIds) {
        try {
          gh(['api', '--method', 'POST', `repos/${owner}/${repo}/actions/runs/${runId}/approve`], ghCopilot);
          console.log(`  ${tag}: approved workflow run ${runId}`);
          approvedThisPr++;
          approved++;
        } catch (approveErr) {
          console.log(`  ${tag}: could not auto-approve run ${runId} (${String(approveErr.message || '').slice(0, 80)}) — escalating to Teams`);
          await notifyTeams(
            `⚠️ PR #${d.prNumber} — workflow approval needed`,
            [
              { title: 'PR', value: `#${d.prNumber}` },
              { title: 'Title', value: d.title },
              { title: 'Reason', value: 'CI has not run — workflow runs are pending manual approval' },
              { title: 'Action', value: 'Click "Approve and run" on the PR Actions tab' },
            ],
            d.url,
          ).catch(() => {});
        }
      }
      if (approvedThisPr > 0) console.log(`  ${tag}: approved ${approvedThisPr}/${d.approvalRunIds.length} workflow run(s) — CI will now run`);

    } else if (d.action === 'request-review') {
      // Re-trigger the Copilot review of the current head (Copilot does not
      // auto-re-review after a fix). Uses copilot-token; leaves a reqreview
      // marker so we don't re-request every tick while awaiting the review.
      if (dryRun) { console.log(`  [dry-run] ${tag}: would request Copilot review of current head`); reviewReqd++; continue; }
      requestReview(d.prNodeId, d.copilotReviewerId, ghCopilot);
      postComment(d.prNumber, `${buildMarker('reqreview')}\n🔁 Requested a fresh Copilot review of the latest changes.`, ghRead);
      console.log(`  ${tag}: requested Copilot review`);
      reviewReqd++;

    } else if (d.action === 'update-pr') {
      // Correct the PR title/description the model judged inaccurate. The coding
      // agent cannot edit PR metadata (no GitHub API in its sandbox), so the
      // babysitter does it — the model produced the exact text, we apply it
      // verbatim (same trust model as resolveThreads: model owns content, code
      // executes).
      //
      // Optimistic concurrency: the model decided against the assess-time
      // snapshot (d.currentTitle/d.currentBody). Re-fetch now; if a human edited
      // the title/body in between, skip rather than overwrite their change — the
      // next tick re-assesses the new state.
      const live = getPrTitleBody(d.prNumber);
      const titleChanged = d.newTitle && d.newTitle !== live.title;
      const bodyChanged = d.newBody && d.newBody !== live.body;
      if (!titleChanged && !bodyChanged) {
        console.log(`  ${tag}: update-pr no-op (title/body already match desired) → skip`);
        skipped++;
        continue;
      }
      // Per-field staleness: only guard a field we are actually about to write.
      // A human editing the title must not block a body-only correction (the two
      // are independent, and we never touch a field we aren't changing).
      if (titleChanged && d.currentTitle !== undefined && d.currentTitle !== live.title) {
        console.log(`  ${tag}: update-pr stale — title changed since assess, re-assess next tick → skip`);
        skipped++;
        continue;
      }
      if (bodyChanged && d.currentBody !== undefined && d.currentBody !== live.body) {
        console.log(`  ${tag}: update-pr stale — description changed since assess (human edit?), re-assess next tick → skip`);
        skipped++;
        continue;
      }
      const fields = {};
      if (titleChanged) fields.title = d.newTitle;
      if (bodyChanged) fields.body = d.newBody;
      const changed = Object.keys(fields).join(' + ');
      if (dryRun) {
        console.log(`  [dry-run] ${tag}: would edit PR ${changed}${d.obstacleKey?.startsWith('thread:') ? ' + resolve driving thread' : ''}`);
        updatedPr++;
        continue;
      }
      editPr(d.prNumber, fields, ghRead);
      console.log(`  ${tag}: updated PR ${changed}`);
      updatedPr++;
      // Record this as an attempt against the obstacle+head ledger — the SAME
      // mechanism the ping branch uses (above) so assess's countAttempts can reach
      // the cap and escalate. Without this the update-pr cap is dead code and a
      // model that emits marginally different body text each tick re-edits forever
      // (the byte-identical no-op guard above only stops exact repeats). Written
      // BEFORE the thread-resolve so a resolve failure still counts as an attempt.
      try {
        const upComments = ghJson(['api', '--paginate', `repos/${owner}/${repo}/issues/${d.prNumber}/comments`], ghRead)
          .map((c) => ({ body: c.body, createdAt: c.created_at, author: c.user?.login ?? null }));
        const priorAttempts = parseMarkers(upComments).filter((m) =>
          m.kind === 'attempt'
          && m.data?.obstacle === d.obstacleKey
          && m.data?.head === d.headOid
          && BABYSITTER_MARKER_AUTHORS.has(m.author));
        const n = priorAttempts.length + 1;
        const attemptBody = `${buildMarker('attempt', { data: { obstacle: d.obstacleKey, head: d.headOid, n } })}\n`
          + `📝 Babysitter: attempt ${n}/2 correcting the PR ${changed} on this commit. If it is still unresolved after 2 attempts, the babysitter escalates to a human via Teams instead of editing again.`;
        const created = JSON.parse(gh(['api', '--method', 'POST', `repos/${owner}/${repo}/issues/${d.prNumber}/comments`, '-f', `body=${attemptBody}`], ghRead));
        try {
          gh(['api', 'graphql', '-f', `query=mutation{ minimizeComment(input:{subjectId:\"${created.node_id}\", classifier:OUTDATED}){ minimizedComment{ isMinimized } } }`], ghRead);
        } catch (minErr) {
          console.log(`::warning::${tag}: could not minimize update-pr attempt marker (${String(minErr.message || minErr).slice(0, 80)}) — it will show but is harmless`);
        }
        console.log(`  ${tag}: recorded update-pr attempt n=${n}/2 for obstacle ${d.obstacleKey} (minimized)`);
      } catch (markerErr) {
        console.log(`::warning::${tag}: could not record update-pr attempt marker (${String(markerErr.message || markerErr).slice(0, 120)}) — cap may not advance this tick`);
      }
      // Break the re-edit loop: if a reviewer thread drove this, resolve it now
      // that the description is corrected. Without this the thread stays open, the
      // next tick sees the same obstacle, and we'd edit (or ping) forever. Resolve
      // via GITHUB_TOKEN with a note; guarded so a resolve failure doesn't abort.
      if (d.obstacleKey?.startsWith('thread:')) {
        const threadId = d.obstacleKey.slice('thread:'.length);
        try {
          postComment(d.prNumber, `🤖 Babysitter updated the PR ${changed} to address this: ${String(d.reason || '').slice(0, 200)}`, ghRead);
          resolveReviewThread(threadId, ghRead);
          console.log(`  ${tag}: resolved driving thread ${threadId} after update-pr`);
        } catch (e) {
          console.log(`::warning::${tag}: could not resolve driving thread ${threadId} after update-pr (${String(e.message || e).slice(0, 140)})`);
        }
      }

    } else if (d.action === 'ready') {
      // POSTCONDITION READY GATE: the resolveThreads above may have just
      // cleared threads the model judged wrong, but this is the sole,
      // deterministic enforcement point — assess never vetoes ready on
      // threads. Re-fetch FRESH state (not the assess-time snapshot) because
      // a new Copilot reviewer thread can land between assess and apply, and
      // because a resolve just above may have changed the picture. Never post
      // the ready card while any live (unresolved, non-stale) Copilot
      // reviewer thread remains.
      const liveThreads = getLiveCopilotThreads(d.prNumber);
      if (liveThreads.length > 0) {
        const obstacleKey = `ready-block:${d.prNumber}`;
        const blockComments = ghJson(['api', '--paginate', `repos/${owner}/${repo}/issues/${d.prNumber}/comments`], ghRead)
          .map((c) => ({ body: c.body, createdAt: c.created_at, author: c.user?.login ?? null }));
        const blockMarkers = parseMarkers(blockComments);
        const priorAttempts = blockMarkers.filter((m) =>
          m.kind === 'attempt' && m.data?.obstacle === obstacleKey && m.data?.head === d.headOid && BABYSITTER_MARKER_AUTHORS.has(m.author));
        const n = priorAttempts.length + 1;
        console.log(`  ${tag}: ready blocked — ${liveThreads.length} unresolved Copilot reviewer thread(s) remain on head ${d.headOid} (attempt ${n}/2)`);
        if (dryRun) { console.log(`  [dry-run] ${tag}: would record ready-block attempt ${n}/2`); skipped++; continue; }
        // Same attempt-marker/minimize pattern as the ping obstacle ledger
        // (above): a hidden ledger entry so the next tick can count attempts
        // toward the escalate-after-N cap without cluttering the timeline.
        const attemptBody = `${buildMarker('attempt', { data: { obstacle: obstacleKey, head: d.headOid, n } })}\n`
          + `⏳ Babysitter: ready is blocked by ${liveThreads.length} unresolved Copilot reviewer thread(s) (attempt ${n}/2).`;
        try {
          const created = JSON.parse(gh(['api', '--method', 'POST', `repos/${owner}/${repo}/issues/${d.prNumber}/comments`, '-f', `body=${attemptBody}`], ghRead));
          gh(['api', 'graphql', '-f', `query=mutation{ minimizeComment(input:{subjectId:\"${created.node_id}\", classifier:OUTDATED}){ minimizedComment{ isMinimized } } }`], ghRead);
        } catch (markerErr) {
          console.log(`::warning::${tag}: could not post/minimize ready-block attempt marker (${String(markerErr.message || markerErr).slice(0, 120)})`);
        }
        if (n >= 2) {
          const alreadyEscalated = blockMarkers.some((m) =>
            m.kind === 'escalated' && m.data?.obstacle === obstacleKey && m.data?.head === d.headOid && BABYSITTER_MARKER_AUTHORS.has(m.author));
          if (!alreadyEscalated) {
            await notifyTeams(
              `🚨 PR #${d.prNumber} ready blocked by unresolved reviewer threads`,
              [
                { title: 'PR', value: `#${d.prNumber}` },
                { title: 'Title', value: d.title },
                { title: 'Unresolved threads', value: String(liveThreads.length) },
                { title: 'Head', value: d.headOid || 'unknown' },
              ],
              d.url,
            ).catch(() => {});
            postComment(d.prNumber, buildMarker('escalated', { data: { obstacle: obstacleKey, head: d.headOid } }), ghRead);
            escalated++;
          } else {
            console.log(`  ${tag}: already escalated ready-block for ${obstacleKey} on ${d.headOid}`);
          }
        }
        skipped++;
        continue;
      }

      const key = jiraKeyFromTitle(d.title);
      // readyNote is the assessor's rationale for readiness. It must be truthful:
      // when a check is failing-but-exempt-by-policy, readiness does NOT mean
      // "CI green", so we render the note rather than a hardcoded green claim.
      const status = d.readyNote || 'Automated checks satisfied · Copilot review resolved · agent idle';
      const facts = [
        { title: 'PR', value: `#${d.prNumber}` },
        { title: 'Title', value: d.title },
        ...(key ? [{ title: 'Jira', value: key }] : []),
        { title: 'Status', value: status },
      ];
      if (dryRun) { console.log(`  [dry-run] ${tag}: would post Teams "ready for review" + ready-marker (${status})`); ready++; continue; }
      await notifyTeams(`✅ PR ready for review — ${key || d.title}`, facts, d.url);
      postComment(d.prNumber, `${buildMarker('ready')}\n✅ This PR met the definition of ready for human review: ${status}.`, ghRead); // LAST
      console.log(`  ${tag}: posted ready-for-review`);
      ready++;

    } else if (d.action === 'escalate') {
      // The obstacle has resisted repeated pings on this head (assess decided we've
      // exhausted automated attempts). Escalate to a human via Teams, then write an
      // escalated-marker so we do NOT re-fire the card every tick while the head is
      // unchanged.
      const escComments = ghJson(['api', '--paginate', `repos/${owner}/${repo}/issues/${d.prNumber}/comments`], ghRead)
        .map((c) => ({ body: c.body, createdAt: c.created_at, author: c.user?.login ?? null }));
      const alreadyEscalated = parseMarkers(escComments).some((m) =>
        m.kind === 'escalated'
        && m.data?.obstacle === d.obstacleKey
        && m.data?.head === d.headOid
        && BABYSITTER_MARKER_AUTHORS.has(m.author));
      if (alreadyEscalated) { console.log(`  ${tag}: already escalated for obstacle ${d.obstacleKey} on ${d.headOid} — skipping`); skipped++; continue; }
      if (dryRun) { console.log(`  [dry-run] ${tag}: would post Teams escalation for obstacle ${d.obstacleKey} (${d.reason || 'no reason given'}) + escalated marker`); escalated++; continue; }
      await notifyTeams(
        `🚨 PR #${d.prNumber} cannot reach ready — needs a human`,
        [
          { title: 'PR', value: `#${d.prNumber}` },
          { title: 'Title', value: d.title },
          { title: 'Obstacle', value: d.obstacleKey || 'unknown' },
          { title: 'Head', value: d.headOid || 'unknown' },
          { title: 'Reason', value: d.reason || 'no reason given' },
        ],
        d.url,
      );
      postComment(d.prNumber, buildMarker('escalated', { data: { obstacle: d.obstacleKey, head: d.headOid } }), ghRead);
      console.log(`  ${tag}: escalated to Teams for obstacle ${d.obstacleKey}`);
      escalated++;

    } else {
      // warn so a contract drift between assess and apply is visible in the run.
      console.log(`::warning::${tag}: unrecognised action "${d.action}" → skipping`);
      skipped++;
    }
  } catch (err) {
    console.error(`::error::${tag}: ${err.message}`);
    errors.push(`${tag}: ${err.message}`);
  }
}

const summary = `${pinged} pinged, ${reran} re-run(s), ${updatedPr} pr-updated, ${undrafted} un-drafted, ${reviewReqd} review-requested, ${approved} workflow(s) approved, ${ready} ready, ${escalated} escalated, ${skipped} skipped, ${errors.length} error(s)`;
console.log(`\nDone: ${summary}${dryRun ? ' (DRY RUN — no mutations)' : ''}`);
if (errors.length > 0 && !dryRun) {
  await notifyTeams('⚠️ PR babysitter completed with errors', errors.map((e) => ({ title: 'error', value: e })), null).catch(() => {});
}
