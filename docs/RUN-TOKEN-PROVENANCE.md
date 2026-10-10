# Understand run token totals

Phantom shows **accounted tokens** alongside their provenance. Accounted totals
can include held exposure after an uncertain request. They remain the conservative
numbers used by existing budget checks; they are not a provider invoice or a
decoder benchmark.

Each new model-request observation can describe paired input and output as:

- **Reported**: both counters came from the existing explicit usage-reporting boundary.
- **Estimated**: both counters came from an explicitly identified local estimator.
- **Reserved**: the existing request claim remains held because accounting is uncertain.
- **Unknown**: numeric totals exist without enough evidence to classify their source.

A verified refusal before contact is recorded separately. Its zero counters do
not mean the model generated zero tokens. Reported zero requires an actual paired
usage report. Missing legacy fields do not become reported zero, and partial
counter reports do not certify the missing counter.

## Read a partial total

A run with 15 reported tokens and a later held claim of 4,196 tokens shows an
exact accounted total of 4,211. UI counts use two significant figures, so the
label reads **Partial reported 15 · Reserved 4,200** while stored amounts remain
exact. Finishing a claim replaces that claim once; a retry adds its own
observation. The original
step timestamp is retained. No old run is rewritten just to add provenance.

Runs, the live transcript, Usage and Pulse retain these distinctions. Rollups
preserve missing days and do not guess how many requests produced legacy totals.
Reset-aware token forecasting uses only completed, fully reported evidence.
The conservative preflight estimator still uses accounted exposure. Recorded
duration can inform duration forecasts when token provenance is unknown.

OTLP emits `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` only for
fully reported paired observations. `phantom.accounted.*` preserves conservative
totals; provenance buckets and `phantom.token_provenance` explain their scope.
Rollups retain existing model labels; provenance does not establish a new exact
serving-model or account identity. These are recorded-request counters, not native CLI internal activity, subscription
consumption, cache-inclusive context totals or measured decoder tokens per second.

## Reader compatibility

New agent-action and dispatch-production rows carrying valid token evidence use
event envelope version 2. Their nested diagnostic uses version 1 and requires
bucket sums to match the unchanged accounted amounts. Existing version 1 rows
remain readable and are not migrated.

Older event readers reject the entire version 2 row and preserve its raw bytes.
This is a downgrade hold, not selective compatibility with new diagnostic fields.
New readers reject malformed, unsupported or mismatched event evidence rather than
silently stripping it. Reader quality reports identify withheld rows.

Raw saved runs retain their existing persistence format. Older run/Usage readers
may display the conservative numeric totals but cannot interpret this optional
provenance. Do not treat an older display as evidence of measured consumption.
Neither the diagnostic nor its event version changes account, billing, funding,
Stop, permission or paid-credit rules.
