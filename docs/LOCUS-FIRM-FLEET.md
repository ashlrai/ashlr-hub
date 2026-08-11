# Locus firm profile — production fleet checklist

How to turn on **always-on identity gates** for production fleets without
flipping the monorepo default.

**Default remains off.** Fresh installs, local monorepos, and CI without a pin
stay green until you opt in. Agents and tests must not assume firm is enabled.

Related code: `src/core/integrations/locus.ts` (`resolveLocusEnforceMode`),
`src/cli/locus-firm-offer.ts` (onboard/first-enroll soft-offer), README
§ *Locus firm profile*.

---

## Why firm exists

Hub mutate paths (`spawnEngine`, swarm, API-model sandbox, …) call
`applyLocusPreMutateGate` / `runWithLocusSessionIfConfigured` so the fleet
only acts under a sealed Locus pin when enforcement is on.

Without firm (or env/config enforce), those gates are **off** — correct for
developer monorepos. Production fleets with enrolled client repos should opt
into firm so a missing pin **fails closed**.

---

## Mode resolution (never always-on)

First match wins:

| Priority | Source | Result |
|----------|--------|--------|
| 1 | Env `LOCUS_ENFORCE` **set** (including empty / `off`) | That token → mode |
| 2 | `~/.ashlr/config.json` → `locus.enforce` | Explicit mode |
| 3 | `locus.firm === true` | `enforce` |
| 4 | (unset) | `off` |

| Token | Mode | Behavior |
|-------|------|----------|
| unset / `0` / `false` / `no` / `off` / `""` | `off` | Allow without CLI probe |
| `warn` / `log` | `warn` | Probe; log blockers; still allow |
| `1` / `true` / `yes` / `enforce` / `block` | `enforce` | Probe; **deny** when blocked |
| any other non-empty value | `enforce` | Fail closed (typo ≠ soft-allow) |

Env always beats config (including `LOCUS_ENFORCE=off` over firm). Explicit
`locus.enforce` beats `locus.firm`.

---

## Production fleet checklist

Use this when you operate enrolled production repos (agency / client fleet).
Skip for a solo monorepo that only needs occasional local autonomy.

### 1. Install Locus (identity plane)

```bash
# Prefer package manager when available
brew install ashlrai/tap/locus
# or
cargo install --git https://github.com/ashlrai/locus --package locus-cli --locked

locus --version
locus init --with-samples   # or your firm binding pack
```

### 2. Enable firm profile (hub config)

```bash
# Recommended: durable profile → enforce when LOCUS_ENFORCE is unset
ashlr config set locus.firm true

# Soft roll-out first (optional)
ashlr config set locus.enforce warn

# Explicit mode without firm flag (also fine)
ashlr config set locus.enforce enforce
```

Equivalent JSON in `~/.ashlr/config.json`:

```json
{
  "locus": { "firm": true }
}
```

**Do not** set `firm: true` in shared monorepo defaults or CI fixture configs
unless that job intentionally tests enforce.

### 3. First activation soft-offer (optional)

When `locus` is on PATH, interactive onboard / first enroll may recommend firm
(default **N**). Non-interactive never enables firm unless you ask:

```bash
ashlr onboard --yes --locus-firm
# or
ASHLR_LOCUS_FIRM=1 ashlr enroll add ~/code/client-repo --yes
```

### 4. CI / job isolation (`LOCUS_CI_BINDING`)

For fleet jobs that must not share ambient `~/.locus` pin:

```bash
export LOCUS_CI_BINDING=acme-ci    # preferred over LOCUS_BINDING
# optional explicit override of firm for a single job:
# export LOCUS_ENFORCE=enforce
```

| Env | Role |
|-----|------|
| `LOCUS_CI_BINDING` | Prefer this for CI; mints ephemeral pin via `locus ci mint` |
| `LOCUS_BINDING` | Fallback binding name when CI binding unset |
| `LOCUS_ENFORCE` | Per-process mode override (wins over firm/config) |
| `LOCUS_HOME` | Optional isolated store root for the job |
| `LOCUS_SESSION_ID` | Set by mint handle for children — do not invent |

Under **enforce** (including firm), a job without `LOCUS_CI_BINDING` /
`LOCUS_BINDING` **refuses** session run (no ambient pin fallthrough).

### 5. Pin / verify before mutate

```bash
locus enter <alias>              # human pins the tenant
locus whoami
locus agent setup --apply --client all

ashlr doctor                     # locus + locus-firm checks
ashlr preflight                  # readiness (same firm soft-warn)
```

### 6. Doctor / readiness soft warn

When **all** of the following hold, doctor and readiness emit a **non-blocking**
warning (id `locus-firm`):

- at least one repo enrolled
- `locus` CLI available on PATH
- `config.locus.firm` is not `true`

Message intent: *consider `locus.firm` for production*. Fresh empty installs and
monorepos with firm off stay quiet. Enabling firm clears the warn; missing
locus is reported by the separate `locus` check, not this one.

```bash
ashlr config set locus.firm true
# or keep monorepo default and ignore the soft warn
```

### 7. Local override without editing config

```bash
# Temporarily disable firm/enforce for a single command
LOCUS_ENFORCE=off ashlr run …
```

### 8. Roll-back / leave firm

```bash
ashlr config set locus.firm false
# or
ashlr config set locus.enforce off
```

---

## Quick matrix

| Environment | `locus.firm` | `LOCUS_ENFORCE` | `LOCUS_CI_BINDING` | Expected |
|-------------|--------------|-----------------|--------------------|----------|
| Solo monorepo / unit tests | absent / false | unset | unset | off — no pin required |
| Production fleet host | `true` | unset | n/a (interactive pin) | enforce via firm |
| Soft roll-out | any | `warn` | optional | warn mode (env wins) |
| CI job under firm | `true` | unset or `enforce` | **required** | mint isolated session |
| Emergency local debug | any | `off` | — | gates disabled for that process |

---

## What firm does *not* do

- Does **not** auto-enroll repos or auto-apply inbox proposals
- Does **not** put secrets in MCP results or config (CredentialRefs only)
- Does **not** let agents re-pin; humans run `locus enter` / `locus pin`
- Does **not** change monorepo CI unless that job sets firm / env enforce

---

## See also

- README — *Locus firm profile (opt-in identity gates)*
- `src/core/integrations/locus.ts` — gate + session helpers
- Locus product docs (sibling repo): firm-mode, hub-integration, agency-starter
