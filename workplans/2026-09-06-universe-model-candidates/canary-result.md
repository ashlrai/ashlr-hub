# Real local-model canary: date formatting

Observed 2026-09-06 at 22:12:33 UTC. One local request, one generation, one trial.
The model produced a valid replacement, but the independent evaluator rejected
it. No candidate was admitted and no production source changed.

## Source and evaluator identity

- Parent repository: `/Users/masonwyatt/.codex/worktrees/ashlr-hub/ashlr-universe-kernel`
- Parent HEAD: `c3741b6979925c11d35f288841af48e8ba95bab0`
- Source: `src/web-ui/components/charts/format.ts`
- Source SHA-256 before and after: `e9165b5da144756eb745742e38d6c9718c5c5232fc692ecf7c902c9eadbdca22`
- Private two-file seed: `/Users/masonwyatt/.ashlr/universe/demo-seeds/format-date-SN3iZW`
- Seed commit: `fb5fcb96002a82c7696ac767b382fa66ba6fc0b0`
- Fixed evaluator SHA-256: `8a6d7e31397c0da18afbeedf220411b71a147662267cb3365b3d9d8978752b74`

The seed contains only the real `format.ts` copy and `evaluator.mjs`. The model
received only the declared utility file and experiment context. The evaluator
holds expected results and scoring in its own process, invokes candidate exports
in a bounded child, and treats returned values as data. Its 5,194 deterministic
calendar cases cover all months and days 0–32 across 13 years, including 0000,
0099, 1900, 2000, and 2024, plus invalid months and malformed input. Forty cases
check the other exports; two source digests require all text outside the target
date function to remain unchanged. Passing requires every check, not a score
increase alone.

## Results

| Observation | Original utility | Model candidate |
| --- | ---: | ---: |
| Total passing checks | 5,147 / 5,236 | 4,986 / 5,236 |
| Calendar checks | 5,105 / 5,194 | 4,944 / 5,194 |
| Other-export checks | 40 / 40 | 40 / 40 |
| Unchanged-source guards | 2 / 2 | 2 / 2 |
| Evaluation duration | 163.89 ms | 262.14 ms |
| Accepted by fixed evaluator | No | No |

The original failed 89 date checks. The candidate failed 250 and regressed the
score by 161. Source inspection shows it split the input into numeric components
and called `setUTCFullYear`, without enforcing exact `YYYY-MM-DD` syntax or
rejecting calendar rollover. This explains why the evaluator withheld admission;
the replacement is retained as failure evidence, not a useful production fix.

## Resource receipt and durable evidence

- Universe: `canary-format-date-sn3izw`
- Run: `1e24b9e9-2a87-4c9e-9c2d-50965cd6bc75` (completed)
- Trial: `fe05204a-0591-4879-b2f5-238c9d39eaa9` (failed; not selected)
- Configured model: `qwen2.5-coder:7b`
- Endpoint: `http://127.0.0.1:11434/v1`
- Generation status: succeeded; request started; `format.ts` changed in the isolated candidate only
- Provider-reported input/output: 1,092 / 920 tokens; 2,012 total
- Usage coverage: 1 / 1 started requests; scope is model generation only
- Generation duration: 12,574.43 ms; full run: 13,495.89 ms
- Dollar cost: unavailable (`null`), not zero or an API-equivalent estimate
- Durable source state after replay: healthy
- Artifact: `/Users/masonwyatt/.ashlr/universe/universes/canary-format-date-sn3izw/artifacts/1e24b9e9-2a87-4c9e-9c2d-50965cd6bc75/fe05204a-0591-4879-b2f5-238c9d39eaa9`
- Artifact SHA-256: `0aa36b5af36101bfdecdb8a669a204709310415d17569bb27a878451f314eb05`
- Prompt digest: `8ccf1abc9791b4d872421f639789a16a6ea1e0d86838c2268a1edf7adf4baa9b`
- Response digest: `6ef468315907d44cbcd87dda407dc4d91de5e268740fbccf1df049ea6022dd70`

The script exited 1 because the candidate failed acceptance, even though the run
completed. No server was started, model downloaded, paid provider called, or
account changed. The configured model identity and transport counters are not
independent model attestation or billing evidence.

## Inspect or repeat

Read the existing records with
`node bin/ashlr universe status canary-format-date-sn3izw --json` after building
the corresponding source. The default-store console can also display this
experiment. The script is
`workplans/2026-09-06-universe-model-candidates/local-model-canary.mjs`.

Running that script again creates a new private seed and makes another model
request; it is not a read-only replay. The fixed bounds are one trial, 4,096
output tokens, 150 seconds per trial, 180 seconds per generation, and 10 seconds
for evaluation. No repeat request was made in this canary.

## One stronger challenger on the same fixed experiment

Observed 2026-09-06 at 22:15:08 UTC. A separately authorized single challenger
used the already installed `qwen3-coder:30b`, with the same pinned original seed,
objective, hypothesis, declared `format.ts`, 4,096-token output limit, and fixed
evaluator. Only the experiment ID/name, model, and time budget changed: 180 seconds
per trial and 210 seconds per generation. The original and challenger comparator
digests both equal
`f1fe7a69d4525d2f8deefe8ca81e04149a64a2cd327546a22892b3b5f27f2799`.
Their prompt digests also match. No tests or acceptance criteria were weakened.

| Observation | Original utility | qwen2.5-coder:7b | qwen3-coder:30b |
| --- | ---: | ---: | ---: |
| Total passing checks | 5,147 / 5,236 | 4,986 / 5,236 | 3,043 / 5,236 |
| Calendar checks | 5,105 / 5,194 | 4,944 / 5,194 | 3,001 / 5,194 |
| Other-export checks | 40 / 40 | 40 / 40 | 40 / 40 |
| Unchanged-source guards | 2 / 2 | 2 / 2 | 2 / 2 |
| Selected into archive | No | No | No |

Source inspection identifies a different failure: the 30B candidate validates
shape and compares reconstructed calendar components, but reconstructs the year
as an unpadded number. Valid years below 1000 therefore fail its equality check
and return the original date string instead of the required month/day label.
It is not an accepted fix despite addressing part of the original defect.

- Universe: `canary-format-date-30b-43b92164`
- Run: `0687d548-1a1c-482d-8a5a-5bcc77163cdc` (completed)
- Trial: `791f8a2f-058b-44ff-84cc-23f751b9c772` (failed; not selected)
- Endpoint: `http://127.0.0.1:11434/v1`
- Configured model: `qwen3-coder:30b`
- Generation status: succeeded; request started; isolated `format.ts` changed
- Provider-reported input/output: 1,092 / 1,003 tokens; 2,095 total
- Usage coverage: 1 / 1 started requests; model-generation scope only
- Generation duration: 26,608.30 ms; full run: 27,305.93 ms
- Evaluation duration: 141.30 ms
- Dollar cost: unavailable (`null`)
- Artifact: `/Users/masonwyatt/.ashlr/universe/universes/canary-format-date-30b-43b92164/artifacts/0687d548-1a1c-482d-8a5a-5bcc77163cdc/791f8a2f-058b-44ff-84cc-23f751b9c772`
- Artifact SHA-256: `3b32c3df2659be8ffbc42b64f1d783aa4f508c8a25190ad80ecda0e3eb40c399`
- Response digest: `ebafbb6fd1c4e8ec829f121d60c154d15b8cac62542d374a5df6c5a1df49f5d1`
- Durable source state after replay: healthy
- Production source SHA-256 after completion: unchanged at `e9165b5da144756eb745742e38d6c9718c5c5232fc692ecf7c902c9eadbdca22`

The challenger invocation exited 1 because acceptance failed. Across both
experiments there were exactly two local requests and 4,107 provider-reported
generation tokens, with zero accepted production changes. This is one task and
one attempt per configured model, not a general model-quality ranking. No
further retry was made and neither rejected artifact was applied to production.

## Final evidence-guided attempt

Observed 2026-09-06 at 22:17:11 UTC. One final, separately authorized attempt used
`qwen3-coder:30b` and the same original seed, objective, evaluator, file allowlist,
4,096-token output limit, and 180-second trial / 210-second generation bounds.
The hypothesis appended explicit critique of numeric date rollover and unpadded
years, with guidance to validate exact shape and compare parsed UTC components
against the original numeric components. This changed the prompt, not the tests
or pass condition. The comparator remained
`f1fe7a69d4525d2f8deefe8ca81e04149a64a2cd327546a22892b3b5f27f2799`.

The model produced a valid replacement JSON response, but the replacement
declared `const day` inside `formatDayLabel(day: string)`. An independent
syntax-only check of the TypeScript-stripped module confirmed
`SyntaxError: Identifier 'day' has already been declared`. The candidate child
could not load the module. The evaluator recorded zero passing function
observations and two passing unchanged-source guards: 2 / 5,236 total. It did not
mistake source preservation or completed generation for usable software.

- Universe: `canary-format-date-feedback-f272750a`
- Run: `907c603a-273d-44ef-b5ec-e3873ae53ae9` (completed)
- Trial: `a4cec375-8b87-4b21-9c57-2896426c38e4` (failed; not selected)
- Endpoint: `http://127.0.0.1:11434/v1`
- Configured model: `qwen3-coder:30b`
- Generation status: succeeded; request started; isolated `format.ts` changed
- Score: 2 / 5,236; date cases: 0 / 5,194; other-export cases: 0 / 40
- Provider-reported input/output: 1,185 / 1,060 tokens; 2,245 total
- Usage coverage: 1 / 1 started requests; model-generation scope only
- Generation duration: 9,439.89 ms; full run: 9,988.02 ms
- Evaluation duration: 46.54 ms
- Dollar cost: unavailable (`null`)
- Artifact: `/Users/masonwyatt/.ashlr/universe/universes/canary-format-date-feedback-f272750a/artifacts/907c603a-273d-44ef-b5ec-e3873ae53ae9/a4cec375-8b87-4b21-9c57-2896426c38e4`
- Artifact SHA-256: `f0b4e230f3757e4423e575355d2cc633d9b9090b147e01ee1146d1a5d095ae83`
- New prompt digest: `3a233afde23fbbfa5276f9ed583431e54b1017355b8bbeb5b415bb226470a22e`
- Response digest: `8ae68675f67cdd6480a48cefe7210c8caa4291479453fd592cf5c0dc2fca9c99`
- Durable source state after replay: healthy
- Production source SHA-256 after completion: unchanged at `e9165b5da144756eb745742e38d6c9718c5c5232fc692ecf7c902c9eadbdca22`

Final totals: exactly **three local model requests**, **6,352 provider-reported
generation tokens**, **zero passing candidates**, and **zero accepted production
changes**. Dollar cost remains unavailable. All model calls stopped after this
attempt. No failed artifact was edited by hand or promoted to obtain a pass.
The experiment demonstrates functioning rejection, critique inputs, isolated
evaluation, and truthful resource records; it does not establish successful
autonomous repair or general model capability.
