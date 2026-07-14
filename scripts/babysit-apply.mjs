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
import { gh, ghJson, buildMarker, parseMarkers, BABYSITTER_MARKER_AUTHORS, jiraKeyFromTitle } from './lib.mjs';

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
let pinged = 0, reran = 0, ready = 0, undrafted = 0, reviewReqd = 0, approved = 0, skipped = 0, escalated = 0;

// Per-invocation cache of each PR's CURRENT head SHA, so the apply-time staleness
// check (below) hits the API at most once per PR even when a PR carries several
// decisions.
const currentHeadCache = new Map(); // prNumber → current head SHA

for (const d of decisions) {
  const tag = `#${d.prNumber}`;
  try {
    if (d.action === 'skip') { skipped++; console.log(`  ${tag}: skip — ${d.reason}`); continue; }

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
      postComment(d.prNumber, buildMarker('attempt', { data: { obstacle: d.obstacleKey, head: d.headOid, n } }), ghRead);
      console.log(`  ${tag}: wrote attempt marker n=${n} for obstacle ${d.obstacleKey}`);
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

    } else if (d.action === 'ready') {
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

const summary = `${pinged} pinged, ${reran} re-run(s), ${undrafted} un-drafted, ${reviewReqd} review-requested, ${approved} workflow(s) approved, ${ready} ready, ${escalated} escalated, ${skipped} skipped, ${errors.length} error(s)`;
console.log(`\nDone: ${summary}${dryRun ? ' (DRY RUN — no mutations)' : ''}`);
if (errors.length > 0 && !dryRun) {
  await notifyTeams('⚠️ PR babysitter completed with errors', errors.map((e) => ({ title: 'error', value: e })), null).catch(() => {});
}
