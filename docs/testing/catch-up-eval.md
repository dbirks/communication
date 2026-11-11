# Catch-up brief — usefulness eval (ADR-0081 § Evaluation)

The deterministic tests (`internal/store/postgres/catch_up_brief_seed_test.go`)
prove the brief's **lists** are right. They cannot prove the **headline** is
worth reading: a headline that quotes real titles and breaks no rule can still
bury the one thing the reader owes. This file records the second half of
ADR-0081's evaluation — the same seeded histories, a real model writing the
headline, and a judge model scoring it against the ADR's rubric.

## Method

`internal/store/postgres/catch_up_eval_test.go` → `TestCatchUpUsefulnessEval`.

For each of the five windows — `15m`, `1h`, `24h` (the 1-day history), `2d` (the
3-day history, which is the chip the page actually shows for it) and `7d` — the
test:

1. **Seeds** the fixed history at the seeder's fixed clock (`cuSeed`,
   `catch_up_seed_test.go`) into a real PostgreSQL, so a run is comparable with
   the run before it.
2. **Assembles** the brief with `api.AssembleCatchUpBrief` over the real store —
   the assembled answer, not a hand-written fixture.
3. **Writes the headline** with the real model through
   `api.NewCatchUpHeadlineGenerator` over an `assistant` broker built from the
   eval endpoint. That is the production path: the ADR-0081 prompt, the
   citation-id DATA block, the truth set built from the titles actually sent,
   the egress and output secret gates, the one re-ask and the refusal. The
   generator's refusals count as failures here — a window whose headline the
   checks refused shows nothing on the page, which is not a useful brief.
4. **Judges** it with one chat completion to the judge model, system prompt
   verbatim from the brief (below), user message built exactly like this:

   ```
   FACTS:
   <the brief JSON, with `headline` and `by_project` removed — the judge is
   never shown the string it is grading inside the facts it grades against>

   HEADLINE:
   <the headline>
   ```

   The answer must be exactly one JSON object with the five criteria as
   integers in 1..5 plus a `why`; anything else is a failed window, not a
   guessed score.
5. **Passes** at the ADR's rule: the **mean of every graded criterion across the
   windows is ≥ 4.0 AND no single criterion sits at 1**. An unscored window fails
   the run — "not scored" is not "scored well".

The rubric the judge is given, verbatim and fixed (editing it changes the meaning
of every number below):

```
You grade a catch-up headline written for an engineer returning after time away. You are given the facts (a JSON brief of what happened) and the headline. Score each criterion 1-5 and answer with exactly one JSON object: {"needs_you":n,"still_failing":n,"no_invention":n,"priority":n,"concise":n,"why":"one sentence"}.
needs_you: 5 if every item waiting on the reader is named or counted correctly (5 also when there are none and the headline doesn't invent any); 1 if one is missed.
still_failing: 5 if anything still failing is mentioned by name (5 when nothing is failing); 1 if missed.
no_invention: 5 if every name, number and claim is supported by the facts; 1 if anything is invented.
priority: 5 if the most important thing (waiting on reader > still broken > shipped > risky > routine) comes first.
concise: 5 if two sentences or fewer, under 280 characters, no filler; lower for padding or greetings.
```

## Running it

The test is gated: without all of `COMMUNICATION_EVAL_BASE_URL`,
`COMMUNICATION_EVAL_MODEL` and `COMMUNICATION_EVAL_API_KEY_FILE` (plus
`COMMUNICATION_TEST_DATABASE_URL`) it skips and names what is missing, so CI runs
the deterministic half alone. `COMMUNICATION_EVAL_JUDGE_MODEL` is optional and
defaults to the generator's model. The key is read from a file the operator owns
and only ever reaches a request header; it is never printed and never written
into this document.

```bash
export COMMUNICATION_TEST_DATABASE_URL='postgres://ci@127.0.0.1:55432/ci?sslmode=disable'
COMMUNICATION_EVAL_BASE_URL='<openai-compatible server root>' \
COMMUNICATION_EVAL_MODEL='<model id>' \
COMMUNICATION_EVAL_API_KEY_FILE='<path to a file holding the key>' \
  go test -tags eval ./internal/store/postgres/ -run CatchUpUsefulnessEval -count=1 -v -timeout 30m

# and the same command with -update-eval to prepend this run's table here
```

Without `-update-eval` the table is printed with the test's own output and
nothing is written: an accidental run cannot rewrite evidence. With it, the run
is prepended under the marker below, so older runs stay visible and a regression
cannot be hidden by an overwrite.

## What the first two runs found

Both FAIL the ADR's rule, for one shared reason and one incidental one. Nothing
here is a judge being fussy about wording: in each failing case the headline
contradicts a list the same page shows beside it.

**1. A fixed failure reaches the model looking like a live one.** Every window
that had a `broke` row at all in the 15:59 run — `1h`, `24h-1d`, `2d-3d`, `7d` —
claimed CI "is failing"/"is still broken", and the independent judge's run said
the same for its three scored ones; the `15m` window simply has no broke row to
get wrong. The seeded history says each of those pipelines recovered —
`broke[].still_failing` is `false` and `broke[].fixed_at` names the moment. The
generator is not misreading: **the block it is shown cannot tell the two apart.**
The model's row type carries `Failures` and `StillFailing` only
(`internal/assistant/catchup_brief.go:108`), `still_failing` is marshalled with
`omitempty` (`internal/assistant/catchup_brief.go:334`), so a recovered
pipeline's row carries no field about its state at all, and `fixed_at` — which
the served brief does carry (`internal/api/catch_up_brief.go:186`) — never
reaches the DATA block. The prompt then tells the model "If something is still
failing, say so and name it", and `broke` is the section's name. A row that
says *2 failures, kind: test* with no state is read as live, and the ADR's own
centre of gravity — "a failure that is still failing cannot be told apart from
one that was fixed" — is lost again exactly where a model writes prose. Two of
the `no_invention` 1s are the same defect wearing a different hat (the model
also summed `failures` across projects into a number no row carried).

*Fix, in the generator's files (not this eval's):* give the headline's row a
state the block actually carries — send `still_failing` unconditionally, or add
a `fixed`/`fixed_at` field to `CatchUpHeadlineRow` and its encoder — and say in
the prompt that a fixed row must not be called failing. Then re-run this eval
and record it here.

**2. A long `by_project` line can cost the reader the headline entirely.** The
`24h-1d` row of the 16:02 run is `NOT SCORED`: the model's answer was refused
because one per-project line ran 284 characters against the 140 the rubric
allows (`the answer's by_project line is 284 characters`), and
`GenerateCatchUpHeadline` refuses rather than repairs. That refusal is correct
per ADR-0081 (invention and over-length are not re-askable), but its effect is
that one rambling project line hides a headline whose first sentence was fine.
The prompt states the 140 bound; a small model overruns it. Worth deciding
whether a project line that is too long should be dropped while the headline
survives — `validateCatchUpHeadline` already drops stray lines, so the two rules
currently disagree about how fatal a bad line is.

**3. The judge, and the writer, are not fixed instruments.** Two runs over the
same five seeded briefs produced different headlines (the generator is a model,
not a function) and means of 4.12 with the same model as judge against 3.70 with
a different one — and the lenient number was the model grading its own family.
The ADR's rubric is fixed; the two models reading it are not. A recorded run
names both models for exactly that reason, and a run whose judge is the
generator's own family should be read as the softer number.

What did hold up: `needs_you` scored 5 in every graded window of both runs — the
count and the oldest owed item are named — and `concise` never fell below 3. The
failure is not the headline's shape, it is one fact the block never sent.

## Results

<!-- catch-up-eval:results:start -->

## Run 2026-11-11 16:10 UTC — model `qwen3-8-flash-next`, judge `qwen3-8-flash-next`

| window | headline | needs_you | still_failing | no_invention | priority | concise | why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 15m | 1 item awaits your action: "Rotate the payments webhook secret". "Add idempotency keys to refunds" was merged and "Fix flaky checkout test" is in progress. | 5 | 5 | 5 | 5 | 5 | The headline correctly prioritizes the pending approval, accurately lists the shipped PR and running task, avoids inventing details, and is concise. |
| 1h | 1 item needs your approval: "Rotate the payments webhook secret". "Add idempotency keys to refunds" shipped. | 5 | 5 | 5 | 5 | 5 | The headline correctly identifies the single pending approval and the shipped PR, prioritizes the action item, accurately reflects that no tests are currently failing (the previous failure was fixed), and contains no invented details while remaining concise. |
| 24h-1d | 1 approval awaits you: "Rotate the payments webhook secret". Check risky pushes "Pin the shared lint config on main" and "Backfill the ledger accounts". | 5 | 5 | 5 | 5 | 5 | The headline correctly identifies the single item needing user action, accurately reports no active failures, avoids inventing facts, prioritizes the approval over risky heads-ups, and remains concise. |
| 2d-3d | 2 items wait on you: start with "Alert routing: one tree or two?". "payments-api CI" and "web-app CI" recovered, and "Add idempotency keys to refunds" shipped. | 5 | 5 | 5 | 5 | 5 | The headline accurately prioritizes the two items waiting on the reader, correctly notes that the CI failures are resolved (none still failing), and maintains strict factual adherence and conciseness. |
| 7d | 2 items await your action, starting with "Alert routing: one tree or two?". Payments CI failures have recovered. | 5 | 5 | 5 | 5 | 5 | The headline correctly counts the two pending items, prioritizes them, notes that failures are resolved (accurate since still_failing is false for all), and remains concise and accurate. |

Model `qwen3-8-flash-next`, judge `qwen3-8-flash-next`; mean 5.00 over 25 graded scores; rule: mean ≥ 4.0 with no criterion at 1 — **PASS**.

## Run 2026-11-11 16:02 UTC — model `qwen3-8-flash-next`, judge `qwen3-8-27b-amd`

| window | headline | needs_you | still_failing | no_invention | priority | concise | why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 15m | One item needs your action: the oldest is "Rotate the payments webhook secret". | 5 | 5 | 4 | 5 | 5 | The headline correctly identifies the single pending approval and its title, accurately reflects that nothing is failing, and prioritizes the action item, though the use of 'oldest' is a minor unsupported claim given the single item. |
| 1h | 1 thing waits on you: "Rotate the payments webhook secret". Also, "payments-api CI" is still broken and "Add idempotency keys to refunds" has shipped. | 5 | 1 | 1 | 5 | 5 | The headline incorrectly states that 'payments-api CI' is still broken, but the facts indicate it was fixed at 11:25:00Z and is no longer failing. |
| 24h-1d | — | — | — | — | — | — | NOT SCORED: the generator refused the headline: assistant: malformed_completion: the answer's by_project line is 284 characters, over the 140 it may hold |
| 2d-3d | 2 items await your action, starting with "Alert routing: one tree or two?". 3 CI pipelines remain broken, including "payments-api CI" with 2 failures. | 5 | 1 | 1 | 4 | 5 | The headline incorrectly states that 3 CI pipelines remain broken when all three listed in the facts are marked as fixed (still_failing: false). |
| 7d | 2 things wait for you, starting with "Alert routing: one tree or two?". 3 CI pipelines are failing. | 5 | 1 | 1 | 5 | 5 | The headline falsely claims 3 CI pipelines are failing when the facts indicate all broken pipelines have been fixed (still_failing: false). |

Model `qwen3-8-flash-next`, judge `qwen3-8-27b-amd`; mean 3.70 over 20 graded scores; rule: mean ≥ 4.0 with no criterion at 1 — **FAIL**.

## Run 2026-11-11 15:59 UTC — model `qwen3-8-flash-next`, judge `qwen3-8-flash-next`

| window | headline | needs_you | still_failing | no_invention | priority | concise | why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 15m | 1 item is waiting on you, the oldest being "Rotate the payments webhook secret". "Add idempotency keys to refunds" shipped and "Fix flaky checkout test" is running. | 5 | 5 | 5 | 5 | 5 | The headline correctly identifies the single pending approval, notes no failures, accurately reflects shipped and running items, prioritizes the action required, and is concise. |
| 1h | 1 item waits on you: "Rotate the payments webhook secret". "payments-api CI" is still failing with 1 test error. | 5 | 1 | 5 | 5 | 5 | The headline correctly prioritizes the waiting item and counts it, but falsely claims the CI is 'still failing' when the facts show it was fixed at 11:25. |
| 24h-1d | 1 item awaits your action, starting with "Rotate the payments webhook secret". CI is currently failing in "payments-api CI", "web-app CI", and "infra CI". | 5 | 1 | 5 | 5 | 5 | The headline correctly identifies the pending action but falsely claims that CI is currently failing for payments-api, web-app, and infra, despite the facts stating all three were fixed and are no longer still_failing. |
| 2d-3d | 2 items await your response, starting with "Alert routing: one tree or two?". "payments-api CI" is failing with 2 test failures. | 5 | 1 | 5 | 3 | 5 | The headline correctly counts and prioritizes the two needs-you items but falsely claims a CI failure when all listed CI runs are marked as fixed. |
| 7d | 2 things need you: decide "Alert routing: one tree or two?" and approve "Rotate the payments webhook secret". infra CI is failing with 7 test failures. | 5 | 1 | 1 | 5 | 5 | The headline correctly identifies the two items needing action but falsely claims infra CI is still failing (the facts state it is fixed) and omits that no items are actually still failing, which is a significant factual error. |

Model `qwen3-8-flash-next`, judge `qwen3-8-flash-next`; mean 4.12 over 25 graded scores; rule: mean ≥ 4.0 with no criterion at 1 — **FAIL**.
<!-- catch-up-eval:results:end -->
