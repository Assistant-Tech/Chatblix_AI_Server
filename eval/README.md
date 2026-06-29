# AI Pipeline Eval Harness

A small offline harness that runs curated fixtures through the **real** pipeline
stages (triage → generator → validator) against the configured OpenRouter models,
scores each with deterministic assertions, and diffs against a saved baseline so
prompt/code changes can be checked for regressions.

> This exists so the deferred prompt work (analysis docs §3 / Phase 3.1–3.3 and
> the full profile dedup) can be done **safely** — change a prompt, run the eval,
> confirm no regression, update the baseline.

## Why a live harness (not cassettes)

Evaluating a *prompt change* requires fresh model output — a recorded response
keyed to the old prompt tells you nothing about the new one. So the harness calls
the live models and scores their output deterministically. Keep the fixture set
small; it costs real tokens. (Most fixtures are triage-only, which is cheap.)

## Run it

```bash
# Requires a key — the harness calls live models.
export OPENROUTER_API_KEY=sk-...

pnpm eval                          # run all fixtures, diff vs baseline.json
pnpm eval -- --filter price        # only fixtures whose name includes "price"
pnpm eval -- --json results.json   # also dump full results
pnpm eval -- --update-baseline     # save current results as the new baseline
```

Exit code is non-zero if any fixture that previously passed now fails
(regression) — so it can gate a pre-merge check.

## Workflow for a prompt change

1. `pnpm eval -- --update-baseline` on the current prompts (establish baseline).
2. Make the prompt edit.
3. `pnpm eval` — look for `⚠ REGRESSION(S)`.
4. If clean (and any intended changes look right), `pnpm eval -- --update-baseline`.

## Fixtures

One JSON file per case in `fixtures/`. Shape (`eval/types.ts`):

```jsonc
{
  "name": "unique-name",
  "stages": ["triage", "generator", "validator"],   // default ["triage"]
  "input": {
    "message": "customer message",
    "history": [{ "role": "user|assistant", "content": "...", "timestamp": "..." }],
    "customerContext": { "name": "Ram" },
    "priorAssistantLang": "romanized_ne",
    "profilePatch": { "business_type": "food" }       // deep-merged onto the sample profile
  },
  "expect": {
    "triage":    { "fields": { "intent_path": "greeting", "language.detected": "romanized_ne" } },
    "reply":     { "matches": ["hajur"], "notMatches": ["NPR"], "maxWords": 40, "minWords": 2 },
    "validator": { "pass": true, "failsRules": [29], "passesRules": [3] }
  }
}
```

All fixtures share the sample tenant in `sample-profile.ts` (a Kathmandu skincare
shop) unless overridden via `profilePatch`. Generator runs at the pipeline's
normal temperature, so reply assertions should be robust (regex presence/absence,
word bounds) rather than exact-match.

## Layout

- `run.ts` — CLI runner (load → run stages → score → report → baseline diff)
- `factory.ts` — builds the stage services from env (no Nest DI; mirrors the unit specs)
- `sample-profile.ts` — default valid tenant profile + deep-merge for patches
- `assertions.ts` — pure scoring of triage/reply/validator expectations
- `types.ts` — fixture + result types
- `fixtures/*.json` — the cases
- `baseline.json` — last-known-good results (committed; updated deliberately)
