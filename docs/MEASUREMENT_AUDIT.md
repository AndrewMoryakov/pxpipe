# Measurement and calibration audit

`Input reduction` is a cache-aware counterfactual, not an invoice.  A Claude
row enters the measured numerator only when pxpipe has both the upstream
`usage` block and successful pre-transform `count_tokens` probes.  A failed
probe receives zero credited saving.  Responses/GPT rows use local tokenizer
and vision-token math and are disclosed separately as estimates.

## Cache tiers

For actual Anthropic usage pxpipe honours the server's reported cache-create
split: 5-minute writes are `1.25x`, one-hour writes are `2.0x`, and reads are
`0.1x`.  Older responses may omit that split.  They remain readable and use the
legacy 5-minute assumption, but the dashboard reports those tokens as
`cache_create_tier_unknown_tokens`; they are not evidence of a 5-minute TTL.
It also shows a **TTL sensitivity** number that reprices those unknown actual
creates at the 1-hour rate.  That is a downside scenario for one assumption,
not a statistical confidence interval and not a complete lower bound.

The hypothetical text path's cache state cannot be observed.  Its warm/cold
state follows the actual request's reported cache read and is therefore a
modelled counterfactual, even when its text token count is measured.

## Dollar display

The dollar tile prices each measured Claude row by model family using the
official first-party list price checked **2026-07-13**: Fable 5 `$10/M`, Opus
4.5–4.8 `$5/M`, Sonnet 4.5/4.6 `$3/M`, Haiku 4.5 `$1/M`; Sonnet 5 is `$2/M`
through **2026-08-31** and is scheduled to become `$3/M` on 2026-09-01.
The lookup applies that UTC date boundary automatically; it does not leave the
introductory rate active indefinitely.  An exact model override still takes
precedence.
Configure a private gateway or nonstandard model explicitly before treating it
as money:

```powershell
$env:PXPIPE_MODEL_INPUT_USD_PER_MTOK = '{"claude-opus-4-8":5,"claude-fable-5":10}'
```

The value is an input-side list-price conversion, not a provider billing
export, subscription credit, or tax-inclusive invoice.  Unknown models are
excluded from the dollar total and counted in the audit drawer.

## Manual calibration only

pxpipe never samples requests or silently routes traffic around compression.
To collect an observed baseline, explicitly use **Disable compression** in the
dashboard and confirm the dialog.  Send comparable normal-text requests, then
enable compression and send comparable imaged requests.  The toggle records
only the completed usage-bearing requests in those two in-memory phases.

The first eligible baseline row locks the comparison to one Claude model and
one `first_user_sha8` session. Rows from other models/sessions and OpenAI/Codex
rows are ignored and counted as out of scope. The result remains sequential and
observational: context size, cache warmth and user workload can still differ
between phases. Treat it as a calibration check, not a paired billing
experiment. Restarting pxpipe clears the calibration note.

## OpenAI cache diagnostics

When an OpenAI-compatible upstream reports `cache_write_tokens` under
`input_tokens_details` or `prompt_tokens_details`, pxpipe persists it on the
event as a diagnostic subset of `input_tokens`. It is never added to the input
total a second time. Cache hits (`cached_tokens`), writes, output, and reasoning
remain separately auditable.

## Codex rollout coverage

Codex provider usage is read incrementally from retained local rollout files
whose `model_provider` is `pxpipe`. The index reads only appended bytes, keeps
partial JSONL rows until completion, and rebuilds a file after truncate or
replacement. Provider-reported token records are ground truth for those
retained records; they are not proof of complete billing history when rollout
files have been deleted or are unavailable.
