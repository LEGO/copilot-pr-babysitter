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
import { gh, buildMarker, jiraKeyFromTitle } from './lib.mjs';

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
let pinged = 0, reran = 0, ready = 0, skipped = 0;

for (const d of decisions) {
  const tag = `#${d.prNumber}`;
  try {
    if (d.action === 'skip') { skipped++; console.log(`  ${tag}: skip — ${d.reason}`); continue; }

    if (d.action === 'ping') {
      const body = `${buildMarker('ping')}\n@copilot ${d.instruction}\n\nWhen done, please re-request review.`;
      if (dryRun) { console.log(`  [dry-run] ${tag}: would @copilot ping + ping-marker\n      instruction: ${String(d.instruction).slice(0, 160)}`); pinged++; continue; }
      postComment(d.prNumber, body, ghCopilot);
      console.log(`  ${tag}: pinged @copilot`);
      pinged++;

    } else if (d.action === 'rerun') {
      if (dryRun) { console.log(`  [dry-run] ${tag}: would rerun ${d.rerun.map((r) => r.name).join(', ')} + rerun-marker(s)`); reran += d.rerun.length; continue; }
      for (const r of d.rerun) {
        if (!r.runId) { console.log(`    ${tag}: no runId for ${r.name}, cannot rerun`); continue; }
        rerunFailed(r.runId, ghRead);
        // One marker per check so next run can count against the cap.
        postComment(d.prNumber, `${buildMarker('rerun', { check: r.name })}\n♻️ Re-ran flaky check \`${r.name}\`.`, ghRead);
        console.log(`  ${tag}: re-ran ${r.name}`);
        reran++;
      }

    } else if (d.action === 'ready') {
      const key = jiraKeyFromTitle(d.title);
      const facts = [
        { title: 'PR', value: `#${d.prNumber}` },
        { title: 'Title', value: d.title },
        ...(key ? [{ title: 'Jira', value: key }] : []),
        { title: 'Status', value: 'CI green · automated reviews resolved · agent idle' },
      ];
      if (dryRun) { console.log(`  [dry-run] ${tag}: would post Teams "ready for review" + ready-marker`); ready++; continue; }
      await notifyTeams(`✅ PR ready for review — ${key || d.title}`, facts, d.url);
      postComment(d.prNumber, `${buildMarker('ready')}\n✅ This PR passed automated CI and Copilot review and was flagged ready for human review.`, ghRead); // LAST
      console.log(`  ${tag}: posted ready-for-review`);
      ready++;
    }
  } catch (err) {
    console.error(`::error::${tag}: ${err.message}`);
    errors.push(`${tag}: ${err.message}`);
  }
}

const summary = `${pinged} pinged, ${reran} re-run(s), ${ready} ready, ${skipped} skipped, ${errors.length} error(s)`;
console.log(`\nDone: ${summary}${dryRun ? ' (DRY RUN — no mutations)' : ''}`);
if (errors.length > 0 && !dryRun) {
  await notifyTeams('⚠️ PR babysitter completed with errors', errors.map((e) => ({ title: 'error', value: e })), null).catch(() => {});
}
