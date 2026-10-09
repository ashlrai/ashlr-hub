# CONTRACT-M65 — in-process provider credentials

In-process API clients use an existing operator-supplied environment key through
`src/core/integrations/secrets.ts`. Resolution is private, on demand and uncached;
values never enter diagnostic output. Missing, blank and `phm_` placeholders are
unavailable. The original valid environment value is returned unchanged.

## Public compatibility

- `resolveProviderKey(envKey, cfg)` keeps its signature and never probes or reads
  a vault. Enabling Secrets does not change this existing environment route.
- `revealSecret(name)` is deprecated and returns `null` without a subprocess.
  Public Secrets 0.7.9 rejects automatic `reveal --yes`; trusted-terminal reveal
  is an owner interaction, not an unattended credential adapter.
- `explainProviderKey(envKey, cfg)` returns a closed value-free reason:
  `environment-supported`, `environment-missing`, `placeholder-unusable` or
  `vault-transport-not-supported`. Configuration is not execution readiness.

## Supported execution boundaries

Eligible child CLI invocations can use the existing `phantom exec` proxy where
its project, route and launcher requirements qualify. Native self-authenticated
CLI paths remain separate. Parent-process API fetches cannot inherit that child
proxy; vault-backed API requests require a separately qualified request transport.
This contract supplies no such transport or new spending authority.

TypeSafe/Jev retains its existing private 0600 secrets-file fallback. Existing
provider admission, local-only policy, exact account binding and promotional-credit
reservation/settlement remain unchanged.

## Verification

`test/m65.secrets.test.ts` proves original environment parity, rotation without
caching, empty/placeholder refusal, closed diagnostics and zero extraction/probe
subprocesses even with Secrets configured. Affected provider, TypeSafe, local-only
and Anthropic admission tests retain their current execution boundaries. Fixtures
use synthetic credentials; qualification does not contact a real provider.
