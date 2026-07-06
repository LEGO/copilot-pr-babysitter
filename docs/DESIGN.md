# Design & build notes — Copilot PR Babysitter

This document records **what** this action does, **why** it is shaped the way it
is, and the empirical findings that drove the design. It is the companion to the
[README](../README.md) (which is the usage reference).

## The problem

GitHub Copilot's coding agent opens PRs, but getting one to a state a human
should actually review is a multi-step chore: the PR starts as a draft, Copilot
reviews it, leaves comments, someone has to ask Copilot to address them, CI has
to go green, flaky jobs need re-running, and review has to be re-requested after
each fix. This action automates that shepherding so a human is only pulled in
**once a PR is genuinely ready** — CI green, automated review clean.

It is the second half of a pair:

- [`jira-claude-triage`](https://github.com/LEGO/jira-claude-triage) turns Jira
  backlog tickets into Copilot PRs.
- **This action** drives those PRs to review-ready.

## The state machine

Each run, for every open Copilot-authored PR matching the title identifier, the
assess step (`scripts/babysit-assess.mjs`) computes exactly one action:

```
                    ┌─────────────────────────── idempotency gate ───────────────────────────┐
 PR ──▶ mid-flight? ─yes─▶ skip                                                                │
        │no                                                                                    │
        ▼                                                                                       │
   ping outstanding? ─yes─▶ skip   (we already pinged; Copilot hasn't started — race guard)     │
        │no                                                                                    │
        ▼                                                                                       │
   already posted ready + no new work? ─yes─▶ skip                                             │
        └──────────────────────────────────────────────────────────────────────────────────┘
        ▼
   actionable reviewer thread on current head? ─yes─▶ ping   (Claude synthesises the fix)
        │no
        ▼
   CI pending? ─yes─▶ skip (wait)
        ▼
   CI failing? ─yes─▶ Claude attributes each check:
                        flaky  → rerun  (capped at rerunCap)
                        real   → ping
        ▼ (CI green)
   still a draft? ─yes─▶ undraft   (triggers the first Copilot review)
        │no
        ▼
   Copilot reviewed the current head? ─no─▶ request-review   (re-trigger; Copilot won't auto-re-review)
        │yes
        ▼
      ready   → Teams "ready for review" card
```

The apply step (`scripts/babysit-apply.mjs`) performs the mutation for each
decision. Assess is **read-only**; all writes live in apply, gated by `dry-run`.

## Three Copilot identities

Copilot appears as **three distinct actors**, and conflating them was the first
mistake we had to unlearn:

| Identity | Role | Used for |
|---|---|---|
| `copilot-swe-agent` | coding agent (authors & fixes the PR) | fetch filter; drives `copilot_work_started` / `copilot_work_finished` |
| `copilot-pull-request-reviewer` | review bot | its inline threads are the review gate |
| `Copilot` | requestable reviewer (a Bot node) | the `requestReviews` target that re-triggers a review |

## Findings that shaped the design (learned by running it live)

Each of these was discovered against real Copilot PRs, not assumed:

1. **Review cycles emit `copilot_work_started` but never `copilot_work_finished`.**
   They close with a `reviewed` event instead. Treating "work_started is latest"
   as "mid-flight" therefore deadlocked every reviewed PR. The gate's `idle`
   definition counts a `reviewed` event as a work-closing event.

2. **Copilot never resolves its own review threads**, and never marks them
   `isOutdated` — not after fixing, not after re-review. So `isResolved` is
   useless as an "addressed" signal. Instead we compare **commit oids**: a thread
   is actionable only if it was raised against the current `headRefOid`; a thread
   against an older commit was superseded by a later fix.

3. **Copilot does not review drafts**, and does not auto-re-review after a fix.
   So the action must *explicitly* (a) un-draft to trigger the first review and
   (b) re-request review (via the `requestReviews` GraphQL mutation with the bot
   node id — the REST reviewers-by-login path rejects the bot) after each fix.

4. **`markPullRequestReadyForReview` is not accessible to the Actions
   `GITHUB_TOKEN`** ("Resource not accessible by integration"). Un-drafting and
   review-requesting therefore use the user-to-server `copilot-token`, the same
   token that authors the `@copilot` mention.

## Idempotency

The whole system polls all eligible PRs each run, so "don't repeat an action
already in flight" is the central invariant. State lives in **hidden HTML marker
comments** (`<!-- babysitter:KIND ts="…" -->`) on the PR — `ping`, `ready`,
`reqreview`, `rerun` — so prior actions are machine-detectable across runs.
Pinging `@copilot` produces a `copilot_work_started` only after a lag (~90s
observed); the ping-marker closes that race by recording our own action the
instant we take it.

## Known limitations & follow-ups

Surfaced by an adversarial review (see `docs/REVIEW.md`) — tracked, not yet all
fixed:

- The idle gate's `reviewed` check is not filtered to the Copilot reviewer, so a
  human review posted mid-coding can open the gate early.
- `request-review` and CI-caused `ping` have no attempt cap (only flaky `rerun`
  does), so a PR that can never converge can loop.
- `reviewThreads`/`reviews` GraphQL connections are not paginated (first:100 /
  first:50).
- Marker comments are trusted without an author check.

For the POC these are bounded by scale (small PR counts, controlled repos); the
follow-ups above make it production-hard.
