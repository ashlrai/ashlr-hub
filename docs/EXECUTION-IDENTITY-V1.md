# Execution Identity V1

Execution Identity V1 is the default-off, shadow-only contract for representing
more than one execution account or runtime behind one Ashlr engine. It separates
the mechanism that performs work (`codex`, `claude`, or `local-coder`) from the
private identity that supplies one account's authentication and capacity.

This source slice does not switch accounts, launch an agent, contact a provider,
write or modify run/proposal state, change routing, grant merge authority, or
start the daemon.
Its only projection is an internal, values-free status object for tests and
future integration. It is not wired into Fleet status, any operator UI, or an
API. Live dispatch must not consume an Execution Identity V1 assignment.

## Configuration and default behavior

The policy configuration lives under `foundry.executionIdentityV1`:

```json
{
  "foundry": {
    "executionIdentityV1": {
      "enabled": true,
      "shadowOnly": true,
      "identities": [
        {
          "ref": "eid_11111111111111111111111111111111",
          "engine": "codex",
          "privateRuntimeLocatorRef": "erl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "plan": {
            "kind": "subscription",
            "class": "codex-max",
            "maxConcurrent": 1
          }
        }
      ]
    }
  }
}
```

When the block is absent, `enabled` is not exactly `true`, or `shadowOnly` is
not exactly `true`, the feature has no execution, resource, assignment, or
provenance effect. V1 has no non-shadow mode.

Every identity must use a minted opaque reference matching
`eid_[0-9a-f]{32}`. Human labels, account names, and email addresses are not
valid identity references. Its `privateRuntimeLocatorRef` must independently
match `erl_[0-9a-f]{32}`. The whole configured roster is refused when any row
is malformed, duplicated, mismatched with its engine, or lacks an explicit
plan. Partial acceptance would make capacity and isolation claims ambiguous.

Claude and Codex policies are explicit. V1 never infers a plan or quota from a
transcript. A Codex identity must declare `codex-max` or `codex-custom`.
`claude-agent-sdk-credit` is a distinct executable capacity class from
`claude-max`. Under the policy taking effect on 2026-06-15, and because Hub's
current autonomous Claude engine invokes
`claude -p`, a `claude-max` identity is `interactive-reserved` with zero shadow
slots and cannot be assigned. Only an explicit `claude-agent-sdk-credit` policy
can describe autonomous Claude capacity. Unknown, missing, malformed, or stale
capacity always produces zero trusted shadow slots.

## Private locator boundary

Vendor-home locators and Phantom secret names never appear in `AshlrConfig`.
They live in a separate internal private store at
`~/.ashlr/private/execution-identities-v1.json`. On POSIX, the file must be a
real, current-user-owned `0600` file beneath a real `0700` private directory;
symlinks, detected snapshot inconsistencies, oversized input, malformed rows,
and unsafe modes fail closed. The reader rechecks the opened file and named path after reading,
including inode, owner, mode, link count, size, timestamps, and parent-directory
properties. `loadConfig()` and every package/public config type contain only the
opaque locator reference.

Windows private-store loading is intentionally unsupported in V1. An enabled
configuration hard-refuses with `platform-private-store-unsupported`, publishes
no identities or assignments, and remains visibly degraded. POSIX mode and owner
checks are never treated as Windows ACL validation. A future Windows implementation
requires a separately reviewed exact-DACL and replacement-resistance contract.

Resolution is available only from the internal
`core/fabric/execution-identity` module and is not exported from `@ashlr/hub`,
`@ashlr/hub/core`, `@ashlr/hub/types`, the plugin host, MCP, or the web API.

Before returning a runtime locator, the resolver requires an absolute canonical
directory, rejects symlinks and filesystem roots, verifies current-user
ownership when the platform exposes user IDs, and rejects group/world-accessible
directories on POSIX. These checks narrow replacement races but do not claim
perfect TOCTOU resistance or pin a locator for a later process launch. Any
future live executor must hold or revalidate the relevant file descriptor,
device/inode, ownership, mode, and canonical locator immediately at spawn.

The engine matrix is exact and is derived from the resolved engine spec:

- Codex and Claude accept only `vendor-home`, with `CODEX_HOME` and
  `CLAUDE_CONFIG_DIR` respectively, plus their explicit plan classes above.
- An `api-model` whose resolved `envKey` is empty is credential-free and accepts
  only `local-runtime` with a `local/local-runtime` plan. This covers
  `local-coder`.
- An `api-model` whose resolved `envKey` is nonempty accepts only `phantom-env`
  naming exactly that key, with a `metered/api-metered` plan. This covers Grok
  and the cloud API models.
- Other resolved `builtin` and `cli-agent` engines are intentionally supported
  only through `local-runtime` with a `local/local-runtime` plan.

Consequently, Grok with `local-runtime` and local-coder with `phantom-env` both
fail closed.

The resolver returns one exact environment override. It does not return or
inherit other configured identities, expand `HOME`, read token values, invoke
Phantom, inspect prompts, or contact a provider. Future live dispatch must bind
only this resolved directory into confinement and must not re-allow every vendor
home from the parent process.

Local runtimes bind the opaque locator reference to a private-store
`local-runtime` row and have no credential locator. API identities may declare
only Phantom secret *names* in that private store. V1 never resolves their
values; any future consumer must reuse the existing ephemeral Phantom injection
boundary.

## Resource and shadow-assignment contract

Capacity observations and backoff are keyed by the private opaque identity
reference, never by engine alone. A backoff for one Codex identity cannot reduce
another Codex identity's capacity. Observations are bounded metadata only:
state, available slots, optional used percentage, and observation time.

The internal, currently unwired projection contains only:

- a domain-separated SHA-256 identity digest;
- engine, resource state, bounded capacity, freshness, and reason codes;
- domain-separated work-item digests for shadow assignments; and
- explicit `shadowOnly: true`, `executionAuthority: false`,
  `proposalAuthority: false`, and `routingMutation: false` markers.

It never contains identity references, labels, emails, filesystem paths,
environment-variable names, Phantom secret names or values, token values,
prompts, diffs, or raw provider errors. Validation errors become closed reason
codes rather than interpolated private input.

V1 has no run-state, proposal, inbox, telemetry, or other persistence
integration. Identity digests exist only inside the ephemeral internal shadow
projection. A later signed provenance version would need a separate reviewed
contract before any identity evidence could participate in persistence or an
authority decision.

## Acceptance requirements

V1 is acceptable only when focused adversarial tests prove:

1. two identities for one Codex engine keep distinct private locators and slots;
2. one identity's backoff does not poison another identity;
3. unknown or stale capacity yields zero trusted slots;
4. the internal status/assignment projection and public config JSON contain no
   private locator or account metadata;
5. Claude plan policy is explicit and engine-compatible;
6. disabled configuration is behaviorally inert; and
7. the existing proposal-only, provenance, merge, deployment, and daemon
   authority paths remain unchanged.
