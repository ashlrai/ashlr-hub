# Evidence notes

## Known baseline

Resource console PR #365 merged; a private foreground queue, independent read and
control capabilities, explicit worker bindings and receipt-based capacity exist.
No real operator pool enrollment was established by the prior filename-only check.
The current task extends this baseline; it does not relabel it as a resident fleet.

## Research ledger

Official Codex app-server and authentication documentation opened September 7,
2026. Source reconciliation and implementation choices follow agent exploration.

## Implementation map

- Existing native account bindings and shared capacity keys remain the routing
  authority. Codex `--profile` alone is not an account-isolation mechanism.
- Reuse resource task reservation/replay/cancellation and private CLI output
  reservation for a fixed review calibration suite. Do not weaken Universe's
  stricter artifact/evaluator comparison contract or import legacy self-scoring.
- Receipt measurement is adapter execution, not provider latency. Per-worker
  tables separate status cohorts, report sample coverage and retain legacy nulls.
- Browser MCP previously only navigated/captured but claimed instruction
  execution. Return observation-only failure rather than applied acceptance;
  preserve useful observation detail and terminal no-replay behavior.

## Real local calibration

M5 Max, 128 GiB RAM, Ollama 0.33.3, Node 24.18.0. One task at a time,
120-second task timeout and 512 output-token request cap. No model downloads,
remote model calls or permanent runtime settings changed. Existing Ollama server
temporarily loaded the two selected models using its normal cache expiration.

| Run | Model | Cases passed | Checks passed | Total elapsed | Execution p50 |
| --- | --- | --- | --- | --- | --- |
| Baseline | qwen3-coder:30b Q4_K_M | 2/6 | 18/24 | 7.360 s | 401.3 ms |
| Diagnostic repeat | same model | 2/6 | 15/24 | 2.619 s | 386.5 ms |
| Challenger | qwen2.5-coder:32b Q4_K_M | 2/6 | 19/24 | 18.421 s | 1722.1 ms |

The suite and workload digests match across all three runs. This is a tiny
calibration, not a statistically controlled comparison: warm/cold state and
runtime context differ. Qwen3 used 262,144 allocated context and about 45.92 GB
GPU memory; Qwen2.5 used 32,768 context and about 28.45 GB. Request token totals
were 854/244, 854/238 and 980/213 input/output respectively. Original baseline
had no failed-check names; diagnostic reporting was added without changing any
prompt, expected value or suite digest.

The measured errors include original-code zero and page-boundary outcomes;
one diagnostic response also violated the strict JSON contract. These results
do not warrant autonomous acceptance or a general "best model" claim. Preserve
the baseline and test larger repository tasks before selecting a default.

Suite digest: `cface499c951f7231a6ae5db493a8125d21accf4d2a4221f9da62ad653d0e576`.
Workload digest: `26dd7059c1c491dac3fec1b153979ee48b28d75ff6f3140476d78cb79caef689`.
