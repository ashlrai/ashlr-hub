# CONTRACT-M62 — hub→pulse OTLP bridge UX

**Pillar:** Let a single engineer's local hub usage flow to the team aggregate
(ashlr-pulse) so a cofounder sees it — without changing the local-first floor.

**Mason's hard rule:** opt-in only; the PAT is never printed/logged (stored via
Phantom, the existing resolver path); metadata-only spans (the OtlpHttpSink floor
is unchanged — no prompts/code/tool-args ever leave). Default OFF; absent
`cfg.telemetry.pulse` ⇒ LocalFileSink, exactly as today.

---

## 1. `ashlr pulse connect` (`src/cli/pulse.ts`)

Reuses the EXISTING `OtlpHttpSink` (telemetry-sink.ts) — only adds UX:
- `connect <endpoint>` — write `cfg.telemetry.pulse` (default
  `https://pulse.ashlr.ai/api/otlp/v1/traces`) via `saveConfig` (preserve all
  other config). `--token <pat>` stores the PAT the way the sink resolves it
  (Phantom secret), never echoed.
- `--status` — endpoint set? PAT available (boolean)? active sink?
- `--test` — fire ONE GenAI test span via OtlpHttpSink; report `{ok, detail}`
  (HTTP status). Honest on failure.
- `--disconnect` — clear the endpoint.

## HARD RULES + verification (`test/m62.*`)

1. **No clobber / opt-in** — `connect` writes only `cfg.telemetry.pulse`;
   absent ⇒ today's LocalFileSink behavior. → `m62.pulse-connect` (tmp HOME).
2. **PAT never leaks** — `--status` reports a boolean, never the value. → test.
3. **Honest --test** — no endpoint ⇒ clean "not configured", never throws;
   real send reports the HTTP result. → test (network mocked).
4. **Metadata-only floor unchanged** — OtlpHttpSink still emits only the
   buildGenAiTrace metadata spans. → unchanged sink + regression.

## Deliverables
- [ ] `src/cli/pulse.ts` `connect` subcommand · `docs/PULSE-BRIDGE.md` · `test/m62.*`.

## Non-goals
Changing the span schema · auto-connecting · storing the PAT in plaintext · the
pulse server side (separate repo).
