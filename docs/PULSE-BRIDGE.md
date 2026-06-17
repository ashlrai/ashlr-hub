# ashlr pulse connect — Hub→Pulse OTLP Bridge (M62)

`ashlr pulse connect` wires your local hub usage (GenAI spans: tokens, cost,
model, provider, tier) to pulse.ashlr.ai so your cofounder/team can see the
same activity in the shared fleet view.

The underlying transport already existed (OtlpHttpSink in
`src/core/observability/telemetry-sink.ts`); this command provides the UX to
configure and verify it.

---

## Quick start

```bash
# 1. Set the endpoint (defaults to pulse.ashlr.ai)
ashlr pulse connect https://pulse.ashlr.ai/api/otlp/v1/traces

# 2. Store your Pulse PAT (never printed, never in config.json)
ashlr pulse connect --token <your-pulse-pat>

# 3. Verify
ashlr pulse connect --status
ashlr pulse connect --test
```

---

## Commands

### `ashlr pulse connect <endpoint>`

Writes the OTLP endpoint into `cfg.telemetry.pulse` in `~/.ashlr/config.json`.
Preserves all other config fields (budgetUsd, budgetWindow, etc.).

```bash
ashlr pulse connect https://pulse.ashlr.ai/api/otlp/v1/traces
```

The default endpoint when you run `ashlr pulse connect` with no URL is:
`https://pulse.ashlr.ai/api/otlp/v1/traces`

### `ashlr pulse connect --token <pat>`

Stores the Pulse PAT. The token is **never** printed, logged, or written to
`config.json`.

**PAT storage (in priority order):**

1. **Phantom vault** (preferred) — stored as secret `ASHLR_PULSE_TOKEN` via
   `phantom add ASHLR_PULSE_TOKEN <value>`. Requires `phantom.enabled: true` in
   your config and the `phantom` CLI on PATH.

2. **Environment variable fallback** — if Phantom is unavailable, the command
   prints instructions to set:
   ```bash
   export ASHLR_PULSE_TOKEN=<your-token>
   ```
   Add to `~/.zshrc` or `~/.bashrc` for persistence.

OtlpHttpSink reads the PAT at emit time from Phantom (via async `phantom exec`)
or from `ASHLR_PULSE_TOKEN` — the same resolution order, the same secret name.

### `ashlr pulse connect --status`

Reports the current bridge state:

```
  ashlr pulse — bridge status

  Endpoint     configured  https://pulse.ashlr.ai/api/otlp/v1/traces
  PAT          available
  Active sink  OtlpHttpSink
```

- **Endpoint**: whether `cfg.telemetry.pulse` is set.
- **PAT**: boolean only — `available` or `not found`. The value is never shown.
- **Active sink**: `OtlpHttpSink` (bridge active) or `LocalFileSink` (local only).

### `ashlr pulse connect --test`

Builds a minimal metadata-only GenAI span and calls `OtlpHttpSink.emit` once.
Reports the returned `{ok, detail}` (e.g., `HTTP 200`). Honest on failure.

```bash
ashlr pulse connect --test
# ok     sink=otlp  detail=HTTP 200
# OR
# fail   sink=otlp  detail=PAT unavailable
```

This is the real end-to-end verification. **Requires your actual Pulse PAT.**
Without it, the result will be `fail  detail=PAT unavailable`.

### `ashlr pulse connect --disconnect`

Clears `cfg.telemetry.pulse` from config. Telemetry reverts to `LocalFileSink`
(local JSONL under `~/.ashlr/telemetry/`). Other config fields are unchanged.

```bash
ashlr pulse connect --disconnect
# ✓ Endpoint cleared (was: https://pulse.ashlr.ai/api/otlp/v1/traces)
#   Telemetry will now use LocalFileSink (~/.ashlr/telemetry/).
```

---

## What is sent

Only **metadata** — never content. Each GenAI span carries:

| Field | OTLP attribute |
|-------|---------------|
| model id | `gen_ai.request.model` |
| provider | `gen_ai.system` |
| input tokens | `gen_ai.usage.input_tokens` |
| output tokens | `gen_ai.usage.output_tokens` |
| estimated cost USD | `gen_ai.usage.cost_usd` |
| run id | `ashlr.run.id` |
| tier | `ashlr.tier` |
| status | `ashlr.status` |

**Never sent**: prompt text, response text, tool arguments, file contents,
project paths, or secrets.

---

## PAT security

- The PAT is stored in Phantom (`ASHLR_PULSE_TOKEN`) or as an env var.
- It is placed **only** in the `Authorization: Bearer <token>` HTTP header at
  emit time.
- It is never written to `config.json`, never logged, never in `TelemetryEmitResult.detail`.
- `patAvailable()` returns a boolean only — it never reads or returns the value.

---

## Live end-to-end test

The `--test` flag sends one real span to the configured endpoint. You need:

1. A configured endpoint (`ashlr pulse connect <url>`)
2. A valid Pulse PAT stored via `--token` or `ASHLR_PULSE_TOKEN`

Without a real PAT, the test will report `detail=PAT unavailable`. This is
expected and not a bug — the OtlpHttpSink degrades gracefully when no PAT is
found.

---

## Config storage

The endpoint is stored in `~/.ashlr/config.json` under `telemetry.pulse`:

```json
{
  "telemetry": {
    "pulse": "https://pulse.ashlr.ai/api/otlp/v1/traces",
    "budgetUsd": 50
  }
}
```

`saveConfig` uses a deep-merge pattern, so existing keys (`budgetUsd`,
`budgetWindow`, `govAction`, etc.) are always preserved.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `detail=PAT unavailable` | No PAT found | `ashlr pulse connect --token <pat>` |
| `detail=no endpoint configured` | `telemetry.pulse` not set | `ashlr pulse connect <url>` |
| `detail=HTTP 401` | Wrong or expired PAT | Re-run `--token` with a fresh PAT |
| `detail=request timed out` | Network/endpoint unreachable | Check connectivity; try `--test` again |
| Phantom not used | `phantom.enabled` not set | Set in config or use env var fallback |

---

## Implementation files

| File | Role |
|------|------|
| `src/cli/pulse.ts` | `cmdPulseConnect` — the M62 subcommand |
| `src/core/observability/telemetry-sink.ts` | `OtlpHttpSink` — the OTLP emitter |
| `src/core/observability/otlp.ts` | `buildGenAiTrace` — span→OTLP shape |
| `src/core/config.ts` | `loadConfig` / `saveConfig` |
| `test/m62.pulse-connect.test.ts` | Hermetic tests (no network, no real ~/.ashlr) |
