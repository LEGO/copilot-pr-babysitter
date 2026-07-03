#!/usr/bin/env node
// babysit-fetch.mjs
// Fetches the open PRs this run should babysit: PRs authored by the Copilot
// coding agent whose title matches an optional identifier pattern. Writes
// prs.json for the assessment step.
//
// Env required:
//   GITHUB_TOKEN        token with repo read (search + PR read)
//   GITHUB_REPOSITORY   owner/repo (provided by Actions)
// Env optional:
//   TITLE_PATTERN       identifier that must appear ANYWHERE in the PR title
//                       (e.g. "PMO-"). Treated as a regex if it contains regex
//                       metacharacters, else a plain case-sensitive substring.
//                       Empty/unset = no title filter (match all Copilot PRs).
//   MAX_PRS             cap on PRs returned this run (default 20)
//
// Output: ./prs.json — array of { number, title, url, headRefName, isDraft }
//
// Why author = app/copilot-swe-agent: that is the Copilot CODING agent (the PR
// author / fixer). It is distinct from copilot-pull-request-reviewer (which
// leaves review threads) and from the "Copilot" timeline actor (lifecycle
// events). Only the coding agent authors PRs, so it is the right fetch filter.

import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const { GITHUB_REPOSITORY } = process.env;
if (!process.env.GITHUB_TOKEN) { console.error('::error::Missing required env var GITHUB_TOKEN'); process.exit(1); }
if (!GITHUB_REPOSITORY) { console.error('::error::Missing required env var GITHUB_REPOSITORY'); process.exit(1); }

const [owner, repo] = GITHUB_REPOSITORY.split('/');
const titlePattern = process.env.TITLE_PATTERN || '';
const maxPrs = Number(process.env.MAX_PRS || '20');

// gh authenticates from GH_TOKEN; mirror GITHUB_TOKEN into it for the child.
const ghEnv = { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN };

// The Copilot coding agent authors PRs as the bot app/copilot-swe-agent.
const AUTHOR = 'app/copilot-swe-agent';

// Pull open Copilot-authored PRs for THIS repo. `gh pr list` filters by author
// and returns exactly the repo scope we want (search API can lag on indexing).
const raw = execFileSync('gh', [
  'pr', 'list',
  '--repo', `${owner}/${repo}`,
  '--author', AUTHOR,
  '--state', 'open',
  '--limit', String(Math.max(maxPrs * 2, 50)), // over-fetch; title filter prunes below
  '--json', 'number,title,url,headRefName,isDraft',
], { encoding: 'utf8', env: ghEnv, maxBuffer: 20 * 1024 * 1024 });

let prs = JSON.parse(raw);

// Optional identifier filter. Substring by default; regex if metacharacters present.
if (titlePattern) {
  const hasMeta = /[.*+?^${}()|[\]\\]/.test(titlePattern);
  const test = hasMeta
    ? (t) => new RegExp(titlePattern).test(t)
    : (t) => t.includes(titlePattern);
  const before = prs.length;
  prs = prs.filter((p) => test(p.title));
  console.log(`Title filter "${titlePattern}" (${hasMeta ? 'regex' : 'substring'}): ${before} → ${prs.length} PR(s).`);
} else {
  console.log('No TITLE_PATTERN set — babysitting all open Copilot-authored PRs.');
}

if (prs.length > maxPrs) {
  console.log(`::warning::${prs.length} PRs matched; capping to MAX_PRS=${maxPrs}. ${prs.length - maxPrs} deferred to a later run.`);
  prs = prs.slice(0, maxPrs);
}

writeFileSync('prs.json', JSON.stringify(prs, null, 2));
console.log(`Fetched ${prs.length} PR(s) to babysit in ${owner}/${repo}:`);
for (const p of prs) console.log(`  #${p.number}  ${p.title}`);
