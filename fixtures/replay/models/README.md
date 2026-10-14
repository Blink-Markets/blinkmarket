# REPLAY model fixtures

`WORKER_MODEL_FIXTURES` points the worker at a JSON file of canned model answers. The worker then answers every model call from the file: no network, no provider, no cost beyond the fixture rates that the budget ledger still reserves and settles. `gm-replay.json` is the file the end-to-end REPLAY run uses. It is REPLAY only and fictional (`fixture-company-not-real`, the company of `../market-spec.json`).

## Format

```json
{
  "rates": {
    "<model>": {
      "inputUsdMicrosPerMillionTokens": "3000000",
      "outputUsdMicrosPerMillionTokens": "15000000",
      "perRequestUsdMicros": "1000"
    }
  },
  "defaults": { "<model>": "<answer>" },
  "outputs": [
    { "model": "<model>", "promptHash": "0x<64 hex>", "inputHash": "0x<64 hex>", "output": "<answer>" }
  ]
}
```

- `rates` (required) prices each model in USD micros, as decimal strings. A model with no rate cannot be called: the budget ledger refuses to reserve for it (`MODEL_RATE_UNKNOWN`).
- `outputs` (optional) are exact answers. A call matches an entry when the model, `promptHash` (keccak256 of the UTF-8 prompt template, the `prompt_hash` registered for a platform agent) and `inputHash` (keccak256 of the UTF-8 per-call input) are all equal.
- `defaults` (optional) give one answer per model when no exact entry matches.
- An answer is a string, or any JSON value, which is written out as JSON text. A call with no match is never sent (`NOT_SENT`): the reservation is released and the job fails.
- Inside an answer, the array element `"$EVIDENCE_IDS"` expands to the evidence ids the prompt showed (lines of the form `EVIDENCE_ID: <uuid>`). Evidence ids are runtime uuids, so a static file cannot name them, and a forecast must cite only evidence it was shown.

## What `gm-replay.json` assumes

| Model | Used for | Answer |
| --- | --- | --- |
| `gm-replay-discovery` | `discovery.scan` (`WORKER_DISCOVERY_MODEL`) | candidate for `fixture-company-not-real`, `FY2025Q1`, 7000 bps |
| `gm-replay-forecaster-a` | platform agent `FORECASTER_A` | probability 0.62 |
| `gm-replay-forecaster-b` | platform agent `FORECASTER_B` | probability 0.58 |
| `gm-replay-baseline` | platform agent `BASELINE` | probability 0.5 |

The REPLAY harness must register the platform agents with those model names and the hash of each real prompt template (`FORECAST_PROMPT_A_V1`, `FORECAST_PROMPT_B_V1`, `BASELINE_PROMPT_V1` in `packages/domain/src/prompts.ts`), and the evidence source's entity must be `fixture-company-not-real`: the API refuses a candidate whose entity differs from the source it cites.
