# Copilot PR Babysitter

A composite GitHub Action that keeps a human **out of the loop until a Copilot PR is genuinely ready to review**.

It's the second half of an autonomous flow: [`jira-claude-triage`](https://github.com/LEGO/jira-claude-triage) turns backlog tickets into Copilot PRs; this action shepherds each PR — driving Copilot through review comments and CI failures — and only pings a human (via Teams) once CI is green and every automated review is resolved.

On each run (you own the cron), for every open Copilot PR matching your title identifier:

1. **Idempotency gate** — is Copilot mid-flight, or have we already pinged and it hasn't started yet? If so, hands off.
2. **Review comments first** — reviewer threads raised against the **current head** → a fresh **read-only Claude session** synthesises a concrete fix instruction → **`@copilot` ping**.
3. **CI next** (only when the comment queue is empty) — Claude attributes each failing check: **flaky** → re-run the job (capped); **caused by the PR** → `@copilot` ping to fix.
4. **Un-draft to trigger review** — Copilot opens PRs as drafts and **only reviews once a PR is marked ready for review**. So when a draft is idle with green CI, the babysitter marks it ready (`gh pr ready`) to trigger the Copilot review. This is programmatic — the draft is not a manual gate.
5. **Re-request review** — Copilot does **not** auto-re-review after a fix commit. So when the current head hasn't been reviewed yet, the babysitter explicitly re-requests the Copilot review (`requestReviews` GraphQL mutation).
6. **Ready for a human** — the Copilot reviewer has reviewed the **current head**, that review left no thread against the head, and CI is green → post a **Teams "ready for review"** card and stop.

```
cron / manual dispatch (in YOUR workflow)
  → fetch open Copilot PRs matching <title-pattern>
  → per PR:  idempotency gate → threads-on-head? → CI? → draft? → head reviewed?
       ping       : @copilot <instruction>       (+ hidden ping-marker = race guard)
       rerun      : gh run rerun --failed         (+ hidden rerun-marker, capped)
       undraft    : gh pr ready  (triggers the first Copilot review)
       req-review : requestReviews  (re-triggers review of the current head)
       ready      : Teams "ready for review" card (+ hidden ready-marker = re-arm anchor)
```

### Why commit oids, not `isResolved`

Copilot **never resolves its own review threads** and does not mark them outdated, even after it fixes the comment and even after a fresh re-review. So `isResolved` is not a usable "addressed" signal. Instead the babysitter compares **commit oids**: every review and every thread records the commit it was made against. A thread raised against a commit older than the current head was superseded by a later fix and is ignored; a PR is "clean" when the reviewer has reviewed the exact current head and that review round raised no thread against it.

## The three Copilot identities

Copilot shows up as **three** distinct actors, and the action treats them differently:

| Identity | Role | Used for |
|---|---|---|
| `copilot-swe-agent` | the **coding agent** (authors & fixes the PR) | fetch filter (PR author); drives `copilot_work_started` / `copilot_work_finished` lifecycle events |
| `copilot-pull-request-reviewer` | the **review bot** | its unresolved inline threads are the review gate |
| `Copilot` | timeline actor | lifecycle event bookkeeping |

Human review threads (any other author) are **ignored** by the gate — the babysitter hands off to humans, it doesn't babysit the human round.

## Idempotency — how double-pings are prevented

Pinging `@copilot` triggers a `copilot_work_started` event, but with a lag (~1–2 min observed). Gating on the lifecycle event alone would double-ping during that lag. Instead the action posts its `@copilot` comment carrying a hidden marker, and gates on **its own marker**:

> Ping only if the newest `copilot_work_started` is **newer** than our newest ping-marker.

So once we've pinged, we never ping again until we can see Copilot actually started. State lives in hidden HTML comments on the PR (`<!-- babysitter:KIND ts="…" -->`), making prior actions machine-detectable regardless of author or prose.

> **POC scope:** if a ping never produces a `copilot_work_started` (Copilot dropped it), the PR simply stalls — there is no re-ping / timeout escalation yet. That's a known rollout gap.

## Re-arm after "ready"

Once a PR is posted as ready, a human may still ping Copilot for nits. That produces a fresh `copilot_work_started` **after** our ready-marker, which re-arms the PR: the babysitter picks it up again, drives it clean, and re-posts. A ready PR with no new Copilot work since the ready-marker is left alone.

## Usage

The action bundles the logic. **You** provide a workflow that owns the schedule and the runner — an action cannot own its own `cron`. Copy [`examples/babysit.yml`](examples/babysit.yml) into your repo at `.github/workflows/babysit.yml` and **edit the `cron:` line to set how often it runs**.

```yaml
jobs:
  babysit:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      actions: write         # re-run failed jobs
      pull-requests: write   # marker comments
      checks: read           # read CI check-runs
      statuses: read         # read legacy commit statuses
    steps:
      - uses: actions/checkout@v7.0.0
      - uses: LEGO/copilot-pr-babysitter@v1
        with:
          title-pattern: 'PMO-'
          copilot-token: ${{ secrets.COPILOT_TOKEN }}
          anthropic-base-url: ${{ secrets.ANTHROPIC_BASE_URL }}
          anthropic-auth-token: ${{ secrets.ANTHROPIC_AUTH_TOKEN }}
          model: your-proxy-model-id
          teams-webhook-url: ${{ secrets.TEAMS_WEBHOOK_URL }}
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `title-pattern` | ⬜ | `''` | Identifier that must appear anywhere in the PR title (e.g. `PMO-`). Regex if it has metacharacters, else substring. Empty = all Copilot PRs. |
| `github-token` | ⬜ | `${{ github.token }}` | Reads, job re-runs, marker comments. Needs `contents:read` + `actions:write` + `pull-requests:write` + `checks:read` + `statuses:read`. |
| `copilot-token` | ✅ | — | OAuth **user-to-server** token from a Copilot-licensed account; authors the `@copilot` mention. |
| `anthropic-base-url` | ✅ | — | Base URL for the Anthropic-compatible model endpoint. |
| `anthropic-auth-token` | ✅ | — | Bearer token for the model endpoint. Pass from a secret. |
| `model` | ✅ | — | Model name/id for the CLI `--model` flag (your proxy's identifier). |
| `teams-webhook-url` | ⬜ | `''` | Teams incoming webhook. If empty, "ready" is logged only. |
| `max-prs` | ⬜ | `20` | Cap on PRs processed per run. |
| `rerun-cap` | ⬜ | `2` | Max auto re-runs per flaky check per PR before escalating it as real. |
| `max-turns` | ⬜ | `15` | Per-PR Claude session turn cap. |
| `max-diff-bytes` | ⬜ | `60000` | Cap on diff bytes fed into the prompt. |
| `max-log-lines` | ⬜ | `200` | Tail lines of each failing job log fed into the prompt. |
| `dry-run` | ⬜ | `false` | `true` = assess + artifact only, no side effects. |
| `node-version` | ⬜ | `24` | Node.js version used to run the scripts. |

## Two tokens — why

- **`github-token`** (default `GITHUB_TOKEN`) reads PRs/timeline/checks, re-runs failed jobs, and posts marker comments. It **cannot** wake the Copilot coding agent, and it **cannot mark a PR ready for review** (`markPullRequestReadyForReview` returns "Resource not accessible by integration" for the Actions token).
- **`copilot-token`** authors the `@copilot` mention that triggers the agent **and** un-drafts PRs (mark-ready) — an OAuth **user-to-server** token from a **Copilot-licensed** account. For a POC you can bottle a personal `gh auth token`; **for production use a dedicated GitHub OAuth App + a Copilot-licensed service account** (a personal token is disposable and expires).

## Cost

Claude fires **only** on PRs that are past the gate **and** have unresolved reviewer threads or failing CI. Idle-and-clean or mid-flight PRs cost **zero** model calls — just cheap `gh` reads. A quiet repo of idle Copilot PRs spends nothing per tick.

## The read-only Claude contract

Claude runs headless with `--allowedTools Read Grep Glob` — no writes, no shell, no network. It reasons over text the Node scripts gather (diff, log tails, review threads) and returns a single JSON decision. **All mutations are performed by the deterministic apply step**, never by the model. Same architecture as `jira-claude-triage`.

## Setup

- **GitHub**: the job needs `contents:read`, `actions:write`, `pull-requests:write`, `checks:read`, `statuses:read`.
- **Copilot**: a Copilot-licensed account and its OAuth user-to-server token.
- **Teams** (optional): a Power Automate / incoming webhook URL.
- **Model**: an Anthropic-compatible endpoint reachable from GitHub-hosted runners.
