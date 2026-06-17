# CONTRACT-M52 — OS-level confinement (closes v4's read-residual)

**Pillar:** Ashlr v5 Open Fleet — raise the containment floor. v4 confined an
external CLI to a git worktree + contained env + push-sever + diff-only, but
documented a residual: the CLI can still READ outside the worktree and make
network calls. M52 adds an OS-level read-jail + network-egress gate around the
contained spawn, with an append-only audit, on the OSes that support it natively.

**Mason's hard rule:** flag-off byte-identical — absent `cfg.foundry.confinement`,
behavior is EXACTLY v4 (env-only). The existing pre-push hook + credential strip
are preserved verbatim. Where a required OS jail cannot launch, that is TERMINAL
(never a silent downgrade to un-jailed). Zero new runtime deps — use the OS's own
`sandbox-exec` (macOS) / `bwrap`/seccomp (Linux) binaries via spawn.

---

## 1. Config (`types.ts`)

```ts
// inside cfg.foundry:
confinement?: Partial<Record<EngineId, {
  /** 'off' (v4 env-only, default) | 'os' (wrap spawn in an OS jail) */
  mode?: 'off' | 'os';
  /** Extra absolute paths the agent may READ beyond the worktree + vendor homes. */
  readAllowed?: string[];
  /** Allow outbound network from the contained process (default false). */
  networkEgress?: boolean;
  /** When mode 'os' but the platform has no jail: 'fallback' (env-only, audited)
   *  | 'fail' (terminal). Default 'fallback'. */
  onUnsupported?: 'fallback' | 'fail';
}>>;
```
A default (`*`) key may set the fleet-wide profile; a per-engine key overrides it.

## 2. The launcher (`src/core/sandbox/confine.ts`, new)

- `buildSandboxLauncher(profile, ctx): { bin, prefixArgs } | null` — PURE. Returns
  the wrapper command to PREFIX the engine spawn with, or `null` for env-only.
  - **macOS** (`process.platform === 'darwin'`): emit a `sandbox-exec -p '<profile>'`
    SBPL profile string: `(deny default)` is too aggressive for a real agent, so
    use `(allow default)(deny file-read*)` then `(allow file-read* (subpath
    "<worktree>") (subpath "<vendor home>") (subpath "<readAllowed…>"))`, and
    `(deny network*)` unless `networkEgress`. Allow `file-write*` only under the
    worktree + TMPDIR. Keep the profile minimal + correct; document each clause.
  - **Linux**: prefer `bwrap` (bubblewrap) when on PATH (`--ro-bind / /`,
    `--bind <worktree> <worktree>`, `--unshare-net` unless egress); else null.
  - **Unsupported / jail binary absent**: honor `onUnsupported` (fallback→null +
    audit; fail→throw a terminal error the caller surfaces as a failed run).
- `confinementProfileFor(engine, cfg, ctx)` — resolve the effective profile from
  `cfg.foundry.confinement` (per-engine over `*` over built-in default 'off').

## 3. Wiring the spawn (`engines.ts` + `sandboxed-engine.ts`)

- `spawnEngine` gains an optional `opts.launcher?: { bin, prefixArgs }`. When
  present, it spawns `launcher.bin` with `[...launcher.prefixArgs, cmd.bin,
  ...cmd.args]` (the existing phantomWrap composes BEFORE the launcher — jail wraps
  the whole thing). Env, timeout, cwd unchanged. When absent ⇒ exactly today's call.
- `runEngineSandboxed` computes the launcher via `confinementProfileFor(engine,
  cfg, { worktree: sb.worktreePath, … })` and passes it to `spawnEngine`. The
  pre-push hook + buildContainedEnv are unchanged and still applied.

## 4. Audit (`src/core/sandbox/audit.ts`)

- Record a `confinement` audit event per contained run: `{ engine, mode,
  networkEgress, readAllowed, platform, launched: boolean, fallback?: boolean }`.
  Append-only, never throws. (Syscall-level read/deny logging is best-effort: on
  macOS, capture sandbox-exec's stderr violations into the run result when present
  — do not depend on it for the invariant.)

## HARD RULES + verification (`test/m52.*`)

1. **Flag-off byte-identical** — no `confinement` cfg ⇒ `buildSandboxLauncher`
   returns null and `spawnEngine` is called identically to v4. → `m52.confine`
   parity + whole-suite regression.
2. **Read-jail works (macOS-gated)** — under the generated `sandbox-exec` profile,
   `cat <file outside worktree>` EXITS NONZERO while `cat <file in worktree>`
   succeeds. Skip on non-darwin with an explicit `it.skip`/guard (never silently
   pass). → `m52.confine` (spawns real `sandbox-exec` on a tmp file).
3. **Egress gate (macOS-gated)** — with `networkEgress:false`, an outbound
   connection attempt from inside the jail fails. (Best-effort; gate behind a
   network-available check.) → `m52.confine`.
4. **Profile is well-formed + injection-safe** — the SBPL profile escapes the
   worktree/readAllowed paths; a path containing `"` or `)` cannot break out of the
   profile. → `m52.profile` (pure string assertions, no spawn).
5. **onUnsupported honored** — fallback ⇒ null + audit; fail ⇒ throws terminal. →
   `m52.confine` (simulate by forcing platform/binary-absent).
6. **Push still blocked** — the existing pre-push containment is unaffected. →
   reuse/extend the m45 proof.

## Deliverables checklist

- [ ] `types.ts`: `cfg.foundry.confinement`.
- [ ] `src/core/sandbox/confine.ts`: `buildSandboxLauncher`, `confinementProfileFor`.
- [ ] `engines.ts`: `spawnEngine` launcher option (default-off parity).
- [ ] `sandboxed-engine.ts`: compute + pass launcher; preserve pre-push + env.
- [ ] `sandbox/audit.ts`: confinement event.
- [ ] Tests: `m52.confine`, `m52.profile`.

## Non-goals

Full VM/container jailing · Windows OS-jail (env-only there) · depending on
syscall-violation logs for the invariant (the jail's exit-code is the proof).
