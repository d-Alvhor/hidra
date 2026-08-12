# HIDRA — a policy-driven routing layer for AI workload classification

HIDRA is a lightweight routing layer that classifies each AI task and dispatches it
to the cheapest backend allowed by an explicit policy — under a **fail-closed data
sovereignty contract**: a task classified as sensitive may only run on a local model,
and if none is available the router **aborts** rather than falling back to the cloud.

It is a single-file Node CLI (~500 LOC) with a declarative policy (`policy.json`) and a
test suite that pins the security contract. No framework, no daemon, no dependencies.

> Personal, MIT-licensed project, built in my own time. I publish it as evidence of
> architectural judgment — not as a deliverable of any employer.

## Why it exists

Running every task on a frontier model is expensive; running sensitive data on a cloud
model can be forbidden. HIDRA separates two concerns that are usually tangled in prompt
code:

- **The engine** (`hidra.mjs`) — classifies a task into `{intent, complexity, privacy}`
  (by flags or a local zero-cost classifier) and selects a backend.
- **The policy** (`policy.json`) — a declarative, version-controlled file that maps tiers
  to ordered backend candidates. Changing routing never touches code.

This is the same declarative-policy / imperative-engine split that enterprise systems use
for authorization. Here it is applied to model routing.

## The security contract

The core invariant is enforced by code, not by a prompt or a PDF:

| Task privacy | Local model available? | Selected tier | Behaviour |
|---|---|---|---|
| `sensitive` | yes | `local` only | Cloud candidates are filtered out before selection. |
| `sensitive` | **no** | — | **ABORT, exit code 3.** Never falls back to cloud. |
| `normal` | — | `cheap` by default | Never selects the frontier tier unless complexity demands it. |
| `normal` + hard reasoning | — | `frontier` | Escalated deliberately by policy. |

The privacy classification itself is fail-closed: it is the **union (OR)** of a keyword
heuristic and an LLM classifier, and if the classifier fails to parse, privacy defaults to
`sensitive` — the safe direction.

`privacy-invariant.test.mjs` runs the router with the local runtime removed from `PATH`
and asserts `exit === 3`. **That test is the contract. If it breaks, the system leaks.**

## Every decision is auditable

Each routing decision appends one NDJSON line — SIEM-ingestible with no adapter:

```json
{"ts":"2026-08-07T18:22:04.113Z","mode":"route","intent":"code-edit","complexity":"hard","privacy":"sensitive","tier":"local","backend":"ollama","model":"llama3.1:8b","machine":"local","fellBack":false,"exit":0,"why":"sensitive data -> never to cloud"}
```

## 30-second demo (no API keys required)

`--route-only` prints the decision without calling any model or spending a token:

```bash
./demo.sh        # runs the three cases below, ~30s, no keys, no tokens
```

```bash
# 1) trivial mechanical work → FREE local model, zero tokens
node hidra.mjs --route-only --intent format --complexity trivial --privacy normal "reformat a file"
#    → route: tier=local (ollama)

# 2) hard architecture → escalated to frontier BY POLICY, not by the developer
node hidra.mjs --route-only --intent architecture --complexity hard --privacy normal "refactor the billing engine"
#    → route: tier=frontier

# 3) THE CONTRACT: sensitive data + no local model → abort, exit 3, never cloud
env PATH="/usr/bin:/bin" "$(command -v node)" hidra.mjs --privacy sensitive --intent code-edit --complexity hard "analyze a record with personal data"
#    → ABORT (exit 3)
```

## Run the tests

```bash
node --test *.test.mjs
```

## Layout

```
hidra.mjs                    engine: classify → select backend → (execute) → log
policy.json                  declarative tier → backend-candidates map
nim-parse.mjs                safe parser for one backend's responses
router.test.mjs              routing invariants (tier selection per intent/complexity)
demo.sh                     2-minute interview demo (route-only, no keys)
privacy-invariant.test.mjs   THE security contract (fail-closed sovereignty)
```

## License

MIT.
