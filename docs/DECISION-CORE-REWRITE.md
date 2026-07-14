# Decision-core rewrite — model owns judgment, deterministic shell owns I/O + safety

> Status: design agreed, implementation pending. POC, sole consumer (LEGO/octan),
> free to break backward compatibility.

## Product contract (the black box)

Drive a Copilot-authored PR to a state a human reviewer would call **ready to
review**, autonomously. The human never sees the machinery — only the outcome.

Failure modes to design against, in priority order:

1. **False ready** (worst) — declares ready while a real failure or unaddressed
   review comment remains. Erodes trust in the box.
2. **Silent stall** — genuinely not ready, cannot self-heal, but does not surface
   why. The PR rots unseen.
3. **Loop / noise** — thrashes toward ready (the original 28-comment bug).

## Root smell being removed

Judgment leaked into deterministic code on BOTH sides of the model call:

- **Before**: a pre-filter (`actionable.length > 0 || failing.length > 0`)
  decided whether to even consult the model.
- **After**: the model's verdict was re-derived — failing checks were split into
  rerun-able vs "blocked", and the blocked branch **fabricated an @copilot ping
  the model never chose** (and discarded the reruns it did ask for). This was the
  loop: a human-gated advisory check ("Danger") sat permanently in "blocked", so
  every hour the code manufactured the same ping.

## Three responsibilities — the clean cut

| Responsibility | Owner | Why |
| --- | --- | --- |
| **State-gathering** | deterministic | model is read-only, no network — it cannot fetch |
| **Judgment** | model, entirely | is a check a real failure or a superseded/cancelled duplicate; is a thread stale; ping vs rerun vs ready vs wait vs escalate |
| **Exactly-once + data-integrity vetoes** | deterministic, suppress-only | a stateless, fresh-every-hour model cannot guarantee exactly-once or detect its own incomplete snapshot |

Invariant: **the model ORIGINATES actions; deterministic code may only VETO or
downgrade — never originate a side effect.** The single sanctioned exception is
escalation triggered by the obstacle cap (see below), which is a give-up, not a
new mutating side effect on the PR.

## Design

### 1. Single pre-model gate: idle only

As long as Copilot is **not actively working** (lifecycle: newest
`work_started` has no closing `work_finished`/`reviewed` after it), ALWAYS call
the model. Remove the `actionable || failing` pre-filter entirely. The approval-
gate detection (below) still short-circuits deterministically because it has zero
judgment.

### 2. Full (compacted) state to the model

Hand the model everything, but **losslessly compacted** so prompt cost/focus
stays sane — compaction is structural, never judgment:

- **Checks**: every logical check, with ALL its attempt conclusions, so the model
  itself reasons "Danger: one `cancelled` + one `success` → superseded, not a
  real failure." Passing checks collapsed to a count + names; full detail (log
  tails) only for currently-failing ones.
- **Reviewer threads**: with staleness info (raised-against commit vs head).
- **Lifecycle timeline** + **our own marker/ledger history** (so the model sees
  what we've already tried and how many times).
- **Approval-gate run states**: as context only (the model does not choose the
  approve action).

### 3. Model action vocabulary

`ready | ping | rerun | wait | escalate`

- `escalate` is new and first-class: the model may choose it when a PR is not
  ready and it judges there is nothing the coding agent can do (e.g. a human-gated
  gate, an infra failure outside the PR).

### 4. Deterministic vetoes (suppress-only), applied AFTER the model returns

- **Completeness veto (guards FALSE READY)**: `ready` is only allowed through if
  the state snapshot was complete — all pages fetched, no gather errors, no
  unknown/unparseable check states. If the snapshot is incomplete, downgrade
  `ready` → `wait` (never front a ready built on missing data). This is a
  data-integrity gate, not judgment.
- **Obstacle-keyed durable cap (guards LOOP)**: key = `(obstacle, head_oid)`
  where obstacle = a failing check name or a reviewer-thread id. Ping the SAME
  obstacle at most **2** times for a given head SHA. On the 3rd, suppress the
  ping and **escalate to Teams** instead. This replaces the clock-based
  "since last work_started" idempotency, which resets every time Copilot replies
  to a ping and thus never stopped a persistently-wrong judgment.
- **Empty-instruction veto**: `ping` with no instruction → `wait` (kept).
- **Rerun cap**: unchanged in spirit, but suppress-only — over cap → do not
  rerun; let the obstacle cap escalate.

### 5. Apply-time staleness check (guards a 4th mode: TOCTOU)

Before performing any side effect in the apply step, re-check `head_oid` has not
moved since assessment. If it has, skip the action (a fix may already have landed;
re-assess next tick). Minimal handling — the hourly cadence + existing
`concurrency: cancel-in-progress:false` make the window small. Full precondition
revalidation is out of scope for the POC.

### 6. Escalation channel

**Teams** (existing `notifyTeams` helper + wired webhook). One card:
"PR #N cannot reach ready — <obstacle> unresolved after 2 attempts on <sha>;
needs a human." Keep the PR timeline clean (no `@copilot` noise) for when the
human reviews. Do NOT post a `@copilot` comment for escalation.

## Durable ledger

Store: **hidden marker comments on the PR** (PR-scoped, durable across runs, no
infra). Harden for this use:

- Structured (JSON payload inside the marker), keyed by `obstacle_key` + `head_oid`
  + attempt number — not free text.
- Only trust markers authored by the babysitter's own identity.

Existing marker kinds (`ping`, `ready`, `rerun`, `reqreview`) stay; add the
obstacle-attempt payload to `ping` markers (or a new `attempt` marker) so the cap
can count per obstacle+head rather than per clock window.

## Data shapes and contracts (implementation precision)

This section removes ambiguity for the implementer. Where the current gatherers
lose information the design needs, the change required is stated explicitly.

### Obstacle key

`obstacle_key` is a **string** of the form `<type>:<id>`:

- Check: `check:<normalized check name>` — reuse the existing `norm()` in
  `babysit-assess.mjs:279` for the name. E.g. `check:danger`.
- Thread: `thread:<review-thread node id>`. This requires exposing the thread's
  GraphQL node id (see "Thread object" below) — it is not fetched today.

The count is keyed by `(obstacle_key, head_oid)`. **Resetting on every new commit
is intentional**: a new head means new code, so the coding agent deserves a fresh
2 attempts against the new state. A stuck obstacle on an UNCHANGED head is what we
cap and escalate.

### Ledger: attempt markers

Add a marker kind `attempt` written by the apply step whenever it pings. The
marker carries a machine-readable JSON payload (kept inside the HTML comment, so
it stays invisible in the rendered PR):

```
<!-- babysitter:attempt ts="..." data='{"obstacle":"check:danger","head":"<sha>","n":1}' -->
```

- `parseMarkers()` (`lib.mjs:46`) must be extended to parse the `data` attribute
  as JSON and return it (add a `data` field to each returned marker).
- The cap counts `attempt` markers matching `obstacle` AND `head` == current
  head_oid. Attempts on a prior head are ignored (see reset rule above).
- **Author trust**: markers are only counted if authored by an identity the
  babysitter controls. `getComments()` (`assess.mjs:71`) currently discards the
  author — extend it to also return `author.login`, and count a marker only when
  the author is one of the babysitter's own identities. For the octan POC those
  are the token identities that post markers today: the `github-actions` bot
  (markers posted via `ghRead`) and the Copilot user identity (ping posted via
  `ghCopilot`, `apply.mjs:111`). Define the allow-set as a constant in `lib.mjs`.

### Check object — carry all attempts

The model must see every attempt so it can judge superseded/cancelled duplicates
itself. Change the check pipeline so each **logical check** (grouped by name)
carries its attempt conclusions rather than collapsing to one state:

```
{ name, attempts: [{ conclusion, status, runId, startedAt, completedAt }], runId /* of latest attempt, for rerun */ }
```

- `classifyChecks()` (`lib.mjs:86`) is REPLACED (not extended) by a grouping
  function that returns the above. It must NOT pick a single winning state — that
  judgment moves to the model. It still keeps the legacy-status-vs-check-run
  suppression that exists today (a legacy status is dropped when a check-run of
  the same name exists), because that is de-duping two *representations of the
  same signal*, not two attempts.
- `getChecks()` (`assess.mjs:121`) must surface `started_at`, `completed_at`, and
  `app.id` from the check-runs API (currently only name/status/conclusion/
  details_url are used).
- **Completeness signal**: `classifyChecks`'s replacement must also return a flag
  when it encounters a conclusion it does not recognize (today unknown conclusions
  silently collapse to `pending` at `lib.mjs:91` — that destroys the signal the
  completeness veto needs). Unknown conclusion → mark the snapshot incomplete.

### Thread object — add id and stale flag

`getReviewState()` (`assess.mjs:84-118`) returns threads with
`isResolved/author/body/path/reviewCommitOid` today. Add:

- `id`: the review-thread GraphQL node id (add `id` to the `reviewThreads.nodes`
  selection at `assess.mjs:92`). Needed for the obstacle key.
- `isStale`: boolean, `reviewCommitOid !== headOid` — computed, not fetched. The
  model receives this rather than re-deriving it.

### Snapshot completeness — the veto's concrete inputs

"Snapshot complete" is a deterministic boolean the assess step computes while
gathering, and attaches to the decision. It is `false` if ANY of:

- a gatherer call threw (wrap `getTimeline/getComments/getReviewState/getChecks`
  and record failure rather than letting one PR abort the run),
- `classifyChecks`'s replacement saw an unrecognized conclusion,
- a paginated call did not complete (the `--paginate` calls already fetch all
  pages; if a call is changed to bounded fetching, it must signal truncation).

**Veto rule**: if the model returns `ready` but `snapshotComplete === false`,
downgrade to `wait` with a logged reason. `ready` on incomplete data is never
fronted to the human.

### Decision object schema (`decisions.json`)

Every decision keeps `prNumber`, `title`, `url` and adds:

- `headOid` — the assessed head SHA (for the apply-time staleness check).
- `modelAction` — the raw `out.action` the model returned (before any veto).
- `appliedAction` — the action actually taken after vetoes/downgrades (equals the
  decision's own `action`). When they differ, `reason` states which veto fired.
- `obstacleKey` — set on `ping` and `escalate` decisions.

### Action vocabulary — model vs deterministic

The MODEL chooses from: `ready | ping | rerun | wait | escalate`.

The following remain **deterministic, non-model** actions emitted by assess
BEFORE the model call (unchanged from today; they have zero judgment) and are
still valid entries in `decisions.json`: `approve-workflows`, `rerun-gated`,
`undraft`, `request-review`, `skip`. Removing the pre-model *failure* filter does
NOT remove the terminal region — see next.

### Terminal region after filter removal

Today the terminal region (`undraft` / `request-review` / `ready`, `assess.mjs:
373-409`) runs only when the model was NOT called. After this rewrite the model
is called whenever idle, so reconcile as follows:

- The model owns the **readiness judgment** and returns `ready` when the DoD is
  met. A `ready` from the model (passing the completeness veto) then flows into
  the SAME terminal mechanics that exist today: if the PR is a draft → `undraft`
  (to trigger Copilot review); else if the current head is not yet
  Copilot-reviewed → `request-review`; else → post the ready card. These three
  are deterministic *follow-through on a model `ready`*, not independent judgment,
  so they stay in code. In effect: model says `ready` → deterministic code
  decides whether "ready" means undraft, request-review, or post-the-card, based
  on draft/review state.
- This means `undraft`/`request-review` are reached via a model `ready`, not via
  a separate no-model path. The old "nothing to judge → terminal" path is gone
  because there is always a model call when idle.

### Escalate — precedence and no double-fire

Two triggers, one outcome, mutually reconciled:

- **Cap-triggered**: apply-time, when a `ping` decision's `(obstacle, head)`
  already has 2 `attempt` markers → the ping is SUPPRESSED and converted to a
  Teams escalation.
- **Model-chosen**: the model returns `action: "escalate"` directly (its judgment
  that no coding-agent action can help).

Precedence rule to prevent double-escalation: **escalate for a given
`(obstacle, head)` fires at most once.** Write an `escalated` marker (same JSON
payload shape) when a Teams escalation is posted; before escalating (either
trigger), skip if an `escalated` marker already exists for that
`(obstacle, head)`. A model `escalate` and a cap escalation for the same obstacle
therefore collapse to a single card.

Model-chosen `escalate` decisions must carry `obstacleKey` and a human-readable
`reason` (used as the Teams card body). If the model chooses `escalate` without a
resolvable obstacle, use `obstacleKey = "pr:<number>"`.

### Apply-time staleness check

Before each side effect in `babysit-apply.mjs`, fetch the PR's current head SHA
once and compare to `decision.headOid`. If they differ, skip the side effect with
a log line (`stale: head moved <assessed>→<current>, re-assess next tick`). One
fetch per PR, not per action.

## Out of scope for the POC

- Full apply-time precondition revalidation beyond the head_oid check.
- A separate `exempt_checks` config / policy-frontmatter schema — dropped. The
  model reasons about advisory/human-gated checks from the prose policy + the
  full attempt data; if it proves to mis-judge them in practice, revisit with
  evidence.
- Same-name check-run auto-dedup in `classifyChecks` — dropped; the model sees
  all attempts and judges superseded duplicates itself.

## Test plan (against LEGO/octan#58486)

1. Land on `main`; first validation run is `workflow_dispatch` with
   `dry-run:true` — assess + upload `decisions.json` artifact, zero side effects.
2. Inspect `decisions.json`: for #58486 confirm no fabricated Danger ping; the
   model's raw action + the applied action are both recorded; the genuinely-
   failing `integration-tests-graphql` checks get a real decision.
3. Then `dry-run:false`.
4. Move the `v1` tag last (sole consumer pins `@v1`; dry-run gates the first run).

Caveat: #58486 exercises the loop-fix and model-judgment paths, but not the
escalation-after-2-attempts path (needs an obstacle that survives 2 pinged
attempts) — verify that path by inspecting ledger/decision logic, not this PR.
