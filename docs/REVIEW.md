# Adversarial review — reconciled findings

Two independent reviews (Claude in-session + GitHub Copilot CLI on `gpt-5.5`)
were run against the state machine, then adjudicated against the real code. This
is the reconciled result. Severities: **Blocking** = wrong/unsafe as written;
**Non-blocking** = real gap, bounded at POC scale; **Nit** = polish.

All findings are latent — the pipeline ran end-to-end correctly in testing.
They bite at scale, on adversarial input, or in specific race windows.

## Blocking

**B1 — The idle gate's `reviewed` event is not filtered to the Copilot reviewer.**
`scripts/babysit-assess.mjs:174,186-191`
`reviewedAt = newestEvent(timeline, 'reviewed')` counts a review from *any*
actor. A **human** review submitted while the coding agent is mid-flight (a bare
`copilot_work_started` with no matching `copilot_work_finished`) has a timestamp
≥ `workStarted`, so `workClosed >= workStarted` → `idle` flips true and the gate
opens while Copilot is still coding — the exact invariant the gate exists to
protect. *Both reviewers flagged this independently.*
**Fix:** only count a `reviewed` event as work-closing when its actor is
`copilot-pull-request-reviewer`.

## Non-blocking

**N1 — `request-review` has no attempt cap and shares B1's unfiltered `workClosed`.**
`scripts/babysit-assess.mjs:284-300`
The re-request guard is `reqOutstanding = newestReqReview && workClosed &&
newestReqReview >= workClosed`. Any `reviewed` event (incl. human, per B1)
advances `workClosed` past the marker, clearing the guard while
`reviewedCurrentHead` is still false → fires `request-review` again. Unlike
flaky `rerun` (bounded by `rerunCap`), there is no cap, so a PR whose current
head never gets a matching Copilot review can re-request indefinitely.
**Fix:** filter `workClosed` to the reviewer (shared with B1) and add a
per-head request-review cap.

**N2 — CI-caused `ping` has no cap; only flaky `rerun` is bounded.**
`scripts/babysit-assess.mjs:214-225,260-261`
A check that keeps failing for a reason Copilot can't fix (or the unknown-verdict
default at line 247 forcing `caused-by-pr`) pings → Copilot works → still fails →
pings again, every idle cycle. Review-thread pings partly self-limit (a new
commit stales the thread via the commit-oid check), but CI pings don't.
**Fix:** per-PR/per-check ping cap analogous to `rerunCap`, then escalate to
Teams instead of re-pinging. *(This is exactly the "hard ceiling" a reviewer
asked about on the octan PR.)*

**N3 — GraphQL connections are unpaginated.**
`scripts/babysit-assess.mjs:78-79`
`reviewThreads(first:100)` — a PR with >100 threads can hide an unresolved
reviewer thread beyond the page, so `actionable.length === 0` is a false negative
→ premature `ready`. `reviews(first:50)` — the current-head review can fall off
the page, so `reviewedCurrentHead` stays false → stuck re-requesting. No
`pageInfo { hasNextPage }` is checked.
**Fix:** page through both, or detect truncation and fail safe (skip) rather than
concluding `ready`.

**N4 — Marker comments are trusted without an author check.**
`scripts/babysit-assess.mjs:58-61` (`getComments` captures only `body` +
`createdAt`), parsed in `lib.mjs:46-62`.
Any user who posts a comment containing the hidden `<!-- babysitter:KIND … -->`
string has their "state" accepted — a spoofed `ready` marker could suppress
real pings, a spoofed `rerun` could exhaust the cap. Low likelihood on a private
repo, but it's unauthenticated state. *Copilot-only finding; confirmed.*
**Fix:** capture the comment author and only honour markers written by the
babysitter's own token identity.

## Nits

**Nit-1 — Ping race guard compares runner-local time to GitHub server time.**
`lib.mjs:38` vs `scripts/babysit-assess.mjs:190`. Clock skew could defeat
`pingOutstanding`; NTP + the ~90s lag make it very low risk. A small tolerance
would harden it.

**Nit-2 — Marker attribute values are only quote-stripped, not `>`/`-->` safe.**
`lib.mjs:39,47`. A `check` name containing `>` could corrupt marker parsing and
the rerun-cap count. Check names are controlled, so low risk.

## Ruled clean (checked, not issues)

- **No shell injection** — all `gh` calls use `execFileSync` argv arrays, no shell.
- **No GraphQL injection** — interpolated values are trusted (`GITHUB_REPOSITORY`,
  integer PR numbers, opaque GitHub node ids).
- **No secret leakage** — error slices don't echo tokens; comment bodies pass as argv.
- **Error handling fails safe** — the assess `catch` (lines 305-309) degrades to
  `skip`; `DRY_RUN` defaults safe (only explicit `"false"` mutates).
- **SSM fetch (octan workflows)** — `set -euo pipefail` makes a missing param a
  hard failure (no silent empty secret); values are `::add-mask::`ed before the
  heredoc `$GITHUB_OUTPUT` emit.

## Net

Shippable as a POC — it works, and the read-only/dry-run/fail-safe posture keeps
mistakes cheap. **B1 is the one worth fixing before wider rollout** (it can act
on a PR mid-coding). N1–N4 are the "make it production-hard" list.
