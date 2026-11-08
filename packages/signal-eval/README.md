# @cred/signal-eval

Roster Signal's **eval harness** — the quality bar that keeps the
ranker honest. Given a pinned set of past requisitions with
expected top picks, it runs `rankJobCandidates` and reports
precision@K per req plus an aggregate mean.

## v0 labels are PLACEHOLDER — consultant labels gate M10

**The v0 fixture at `fixtures/known-reqs-v0.json` carries
engineering-judgment PLACEHOLDER labels.** They are good enough for
day-to-day dev iteration (does a refactor to the ranker shift the
ordering?) but they are NOT the quality floor the pilot promises.

Before M10 prod promotion, a domain consultant reviews every req in
the fixture, overwrites `placeholderTopPicks` and `rationale` with
their own judgment, and flips `label_source` to
`consultant-labels-v1`. The CLI's `--require-consultant-labels` flag
refuses to run against any fixture that still says
`placeholder-engineering-judgment`, which is how we gate M10 on
real labels and not on this file.

A placeholder-labeled run logs a WARN banner on every invocation so
nobody forgets this.

## CLI

```sh
pnpm --filter @cred/signal-eval eval \
  --workspace <uuid> \
  --fixture packages/signal-eval/fixtures/known-reqs-v0.json \
  --k 3 \
  --threshold 0.70 \
  --baseline packages/signal-eval/fixtures/baseline.json \
  --pretty
```

Exit codes:
- `0` — all gates pass.
- `1` — a gate failed (absolute threshold OR regression tolerance).
- `2` — invalid arguments.

### Flags

| Flag | Default | Description |
| --- | --- | --- |
| `--workspace`, `-w` | (required) | Workspace UUID to run against. |
| `--fixture`, `-f` | (required) | Path to the fixture JSON. |
| `--k`, `-k` | `3` | Top-K cutoff for precision computation. |
| `--threshold`, `-t` | `0.70` | Absolute floor on `meanPrecisionAtK`. |
| `--baseline`, `-b` | (none) | Baseline JSON. When present, CI also checks that current ≥ baseline − toleranceDrop. |
| `--require-consultant-labels` | off | Refuse to run against `label_source: placeholder-engineering-judgment`. Use this in the M10 promotion workflow. |
| `--pretty` | off | Also print a human-readable summary to stderr. |

## Baseline update workflow

Regular `signal-eval` runs NEVER write to `fixtures/baseline.json`.
That keeps a merge from silently moving its own regression floor.

To record a new baseline (because the ranker legitimately improved):

```sh
pnpm --filter @cred/signal-eval update-baseline \
  --workspace <uuid> \
  --fixture packages/signal-eval/fixtures/known-reqs-v0.json \
  --baseline packages/signal-eval/fixtures/baseline.json \
  --recorded-by "<github-username>"
```

Commit the updated `baseline.json` alongside the change that caused
the improvement.

## Cross-tenant leak probe

`runLeakProbe` (also exercised in CI) proves the ranker's tenant
isolation. It seeds tenant A, ranks, seeds tenant B with the SAME
fixture plus signals that would shift A's ranking IF leaked, then
re-ranks A and asserts the result is byte-identical. See
`src/leak-probe.ts`.

## Ops-friendly trigger

`POST /v1/signal/eval/runs` enqueues an eval run as a
`signal_conversations.channel = "eval"` row (audit trail), runs the
harness synchronously against the committed v0 fixture, writes
results to `signal_eval_runs`, and returns the run id + mean
precision. The ops surface keeps running the SAME fixture the CI
job uses; divergence is caught by baseline drift, not by two
different "the eval".

## What the harness tests

The eval is intentionally focused on the ranker's **ordering**, not
the cred-bridge's edge cases. Every seeded provider carries an
active instance of every required credential, so the hard-filter
stays open and precision@K depends on `scoreCandidate`'s soft facets
(sub-specialty, region, pay band).

Edge cases of the projection live in
`@cred/signal-cred-bridge`'s own test suite.

## Vitest coverage

- `test/precision.test.ts` — pure precision@K math.
- `test/runEval.test.ts` — harness end-to-end on real Postgres.
- `test/leak-probe.test.ts` — cross-tenant isolation.
- `test/baseline.test.ts` — threshold + regression gate.
- `test/cli.test.ts` — placeholder-label refusal.
