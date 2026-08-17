# Milestone Index

**Purpose:** a single authoritative lookup from a milestone ID (`Mxxx`) to what
it actually is, whether it shipped, and where the evidence lives. This exists
because milestone IDs in this repo are **not guaranteed unique** — several
numbers were spec'd for one feature and later silently reused by unrelated
shipped work when nobody checked the spec docs before assigning the next ID.
Planning from a spec doc's milestone number alone, without checking this
index, will re-propose work that already shipped under that number for a
different purpose, or worse, believe unbuilt work is done because the number
"exists" in `test/`.

**Ground truth order:** code and tests > this index > `CHANGELOG.md` >
`docs/contracts/CONTRACT-Mxx.md` > spec docs (`docs/SPEC-*.md`). Spec docs
describe *design intent at the time they were written*; they are frequently
stale. If this index and a spec doc disagree, trust this index's cited
`file:line`, or re-verify against the code yourself.

**How this index was built:** every `test/mNNN.*.test.ts` file in the repo
was enumerated (425 distinct milestone numbers as of 2026-08-16, up from 415
the pass before), cross-referenced against `docs/contracts/` for existing
binding contracts and against `docs/SPEC-*.md` for milestone numbers
documented as planned. The M464–M503 range, the M504–M519 range, and every
collision row below were hand-verified against source (see file:line
citations); the full appendix (§4) is otherwise machine-generated from test
filenames — treat its "subject" column as a filename-derived hint, not a
hand-verified description, unless the ID also appears in §2 or §3.

---

## 1. What "M83–M88" numbering gap means

`docs/ROADMAP-NEXT.md` (now retired, see that file) planned M83–M88 as the
*next* work in June 2026. M84, M85, M86, M87, M88 all have `test/mNN.*`
evidence in the appendix below. **M83 (Windows CI lane) has no dedicated test
file** — it shipped as CI configuration only: `windows-latest` appears in the
job matrix at `.github/workflows/ci.yml:42,59,75,87`. This is a legitimate
"shipped, no test/mNN.*.ts" case, not a gap in the appendix's methodology.

---

## 2. Confirmed ID collisions

An ID collision means: a spec doc under `docs/SPEC-*.md` assigned this
milestone number to one feature, and a *different* feature later shipped
under the same number (visible as `test/mNNN.<unrelated-slug>.test.ts`),
without anyone renumbering the spec. In every case below, the spec'd feature
was never built under that number — check the "Unbuilt feature currently sits
where?" column before assuming it shipped somewhere else under a different
number; usually it just never shipped at all.

A prior audit flagged 11 of these (M258, M260–M264, M270, M271, M273–M275).
Re-verification confirmed 10 of the 11 as genuine collisions, found that
**M264 is a collision between two competing spec docs** rather than a
spec-vs-shipped mismatch, and surfaced **one additional collision the prior
audit missed: M259**.

**A thirteenth collision, of a new kind, was introduced on 2026-08-16
itself:** M470 was already assigned (see §4) to "proposal capture candidate
identity," shipped weeks earlier. Work landed today reused the same number
for an unrelated feature — the daemon activation-authority rework — without
checking this index first, which is exactly the failure mode this document
exists to prevent. Unlike the M258–M275 rows below (spec'd-but-never-built vs
shipped), this is **shipped vs. shipped**: both features are real and both
are in `src/`.

| ID | First subject | First evidence | Second subject (added 2026-08-16) | Second evidence |
|----|----------------|-----------------|-------------------------------------|-------------------|
| **M470** | Proposal capture candidate identity (durable proposal records from sandboxed execution) | `test/m470.proposal-capture-candidate-identity.test.ts` | Daemon activation authority (operator-owned trust roots, Ed25519 standing grants, replaces five hard-coded denials) | `test/m470.activation-authority.test.ts`, `src/core/daemon/activation-permit.ts:121-131` |

| ID | Spec'd subject | Spec location | Shipped subject | Shipped evidence | Unbuilt feature currently sits where? |
|----|----------------|---------------|------------------|-------------------|----------------------------------------|
| **M258** | Two competing spec claims: (a) "Director Acts" — director-initiated goal mutation | `docs/SPEC-ELON-DIRECTOR.md:520` | Ephemeral-path sandbox goal guard + dedupe | `test/m258.sandbox-goal-guard.test.ts` | Neither spec'd M258 feature shipped under this number |
| | (b) Token-based weekly Claude usage cap | `docs/SPEC-RESOURCE-CONTROL-PLANE.md:440,467` | (same as above) | (same as above) | Not built |
| **M259** *(newly found — not in the prior audit's 11)* | Director → gateway "Backend Hint Integration" | `docs/SPEC-ELON-DIRECTOR.md:531-537` | Automerge drain-backlog config (`judgePerPass`/dedup/queue-drain) — see `src/core/fleet/automerge-pass.ts` comment "M259: resolve drain config from foundry", `src/core/types.ts:1075` "M259: max frontier-judge calls..." | `test/m259.diff-dedup-producer-credit.test.ts`, `test/m259.queue-drain.test.ts` | Not built |
| **M260** | Director Dashboard Panel (Mission Control "Director" section) | `docs/SPEC-ELON-DIRECTOR.md:539-546` | Frontier model alias resolution fix (`:default` tag) | `test/m260.resolve-concrete-model.test.ts` | Not built |
| **M261** | Director Memory (inter-cycle continuity via `'directed'` ledger entries) | `docs/SPEC-ELON-DIRECTOR.md:550-556` | TWO unrelated shipped features under the same number: verify-result persistence, and proposal-mutation locking | `test/m261.verify-result-persistence.test.ts`, `test/m261.proposal-mutation-lock.test.ts` | **Not built — confirmed still absent.** `directorMemory` does not appear anywhere in `src/`. |
| **M262** | `rate-limit-store.ts` + response-header capture (MVP data-acquisition step 1) | `docs/SPEC-DATA-ACQUISITION.md:599-612` | Visibility panel data (`resourceGrid`, `fleetActivity`, `costSavings`, `director` fields) | `test/m262.visibility.test.ts` | Not built (no `rate-limit-store.ts` in `src/`) |
| **M263** | ResourceMonitor reads live NIM/OpenAI-compat snapshots | `docs/SPEC-DATA-ACQUISITION.md:614-623` | Judge-drain starvation fix (oldest-first ordering) | `test/m263.drain-starvation.test.ts` | Not built |
| **M264** | *Cross-spec collision, not spec-vs-shipped:* two docs both claim M264. `SPEC-DATA-ACQUISITION.md:625-634` claims it for "post-dispatch probe for the claude cli-agent path" (unbuilt). `SPEC-ELITE-ENGINE-UTILIZATION.md:295,553,598` claims it for "Elite Context Injection for local-coder" — and that one **did** ship. | both docs above | Elite Context Injection (`local-context.ts`) | `test/m264.local-context.test.ts` | The `SPEC-DATA-ACQUISITION.md` post-dispatch-probe half of M264 never shipped under this number |
| **M270** | Anthropic historical usage via Admin API | `docs/SPEC-DATA-ACQUISITION.md:671-675` | "Frontier Ambition" — Kimi frontier-promotion config path | `test/m270.frontier-ambition.test.ts` | Not built |
| **M271** | OpenAI historical usage via org-level key | `docs/SPEC-DATA-ACQUISITION.md:677-679` | Drain-stall fix — cheap archive path for non-ship pendings | `test/m271.drain-stall.test.ts` | Not built |
| **M273** | Predictive cache pre-warming | `docs/SPEC-DATA-ACQUISITION.md:686-689` | Fleet-drain dead-zone fix (null judge client handling) | `test/m273.fleet-drain-dead-zone.test.ts` | Not built |
| **M274** | `p50LatencyMs` wired from `history.jsonl` | `docs/SPEC-DATA-ACQUISITION.md:693-696` | Frontier judge reachability fix (`resolveJudgeClient`) | `test/m274.judge-reachable.test.ts` | Not built |
| **M275** | NIM credit-depletion alert | `docs/SPEC-DATA-ACQUISITION.md:698-701` | Execution completeness gate (typecheck/test validation before merge) | `test/m275.completeness-gate.test.ts` | Not built |

**Not a collision (despite being adjacent in the same spec section):** M272
("agent context enrichment", `getFabricContext()`) and M276 ("SharedStore
cross-machine rate-limit sync") have no shipped `test/m272.*`/`test/m276.*`
files at all — the numbers are simply unused so far, spec-only, no collision.

---

## 3. Documented as planned or delivered, but not built

Beyond the collision rows above (where the spec'd feature is confirmed
absent), these ranges are documented elsewhere as spec'd or "delivered" and
are **not** in `src/`:

- **M34–M40 — Team Command Center** (`docs/SPEC-V3-TEAM.md`). No
  `test/m34.*`…`test/m40.*` files exist at all (verified: the milestone
  sequence in `test/` jumps `M33` → `M41` with a real gap, not a renumbering).
  `hub/v1` (the entire declared team API surface,
  `docs/SPEC-V3-TEAM.md:124-128`), `ASHLR_API_URL`, and team/remote kill (M39)
  do not appear anywhere in `src/`. What exists instead is the M30 local-only
  seam layer, deliberately gated to throw:
  `src/core/seams/identity.ts:45` (`CloudIdentityProvider` throws
  `cloudGatedError`) and `src/core/seams/daemon-coordinator.ts:79`
  (`CloudDaemonCoordinator` — comment: "GATED cloud stub — every method
  THROWS first"). See the corrected status note in `docs/SPEC-V3-TEAM.md` and
  `docs/ROADMAP.md`.
- **M265–M269, M272, M276 — Data Acquisition Phases 2–4**
  (`docs/SPEC-DATA-ACQUISITION.md` §6.2–6.4): `DataLayerSnapshot`,
  `queryDataLayer()`, `history.ts`/`appendDataPoint()`, `cap-forecast.ts`,
  cost-to-green routing, `anomaly.ts`, `getFabricContext()` — all absent from
  `src/` and `test/`. The spec self-documents this at
  `docs/SPEC-DATA-ACQUISITION.md:775`: `p50LatencyMs` stays `null` in
  `BackendResourceState` "until M266 ships" — it hasn't.
- **M259, M260, M261 (as spec'd) — Director backend-hint integration,
  dashboard panel, and memory** (`docs/SPEC-ELON-DIRECTOR.md:531-556`): none
  of the three shipped under their spec'd numbers (see §2). M257 itself (the
  core director reasoning cycle) **did** ship — see the status correction in
  `docs/SPEC-ELON-DIRECTOR.md`.
- **SIMBA prompt optimization** and **DBOS durable suspend/resume**
  (`docs/SPEC-V6-VERIFICATION.md:66,77`, listed under "The horizon", no
  milestone number assigned): neither exists in `src/`. GEPA shipped instead
  (`src/core/fleet/prompt-optimizer.ts`, M150) — SIMBA was never pursued.

---

## 4. Full milestone appendix (M2–M519)

Machine-generated from `test/mNNN.*.test.ts` filenames, one row per number
that has at least one test file. "Shipped" here means "a test file with this
number exists" — for anything flagged **collision**, see §2 before trusting
the subject column; for anything in §3, the *spec'd* feature under that
number is unbuilt even though the number itself may show up here as shipped
for a different, unrelated feature (M258–M275 range).

Contracts exist (`docs/contracts/CONTRACT-Mxx.md`) for a subset of these —
mostly M3–M33 (v1/v2), M50–M70 (v5), and the M334/M444–M463/M464+ single-
purpose milestones from the "contracts-first" era. Not every shipped
milestone has a standalone contract; many M75–M340 entries were delivered as
part of a batched CHANGELOG entry instead (see `docs/ARCHITECTURE.md`'s
"Milestone → module mapping" table for the batched-series groupings, and
`CHANGELOG.md` for the prose description of each release).

<details>
<summary>Expand full M2–M519 table (425 rows)</summary>

| ID | Subject (filename-derived unless noted) | Status | Test evidence |
|----|------------------------------------------|--------|----------------|
| M2 | config set; doctor; doctor exit code; phantom; providers | Shipped | `test/m2.*.test.ts` |
| M3 | gateway; mcp install; redact args; registry; tools registry | Shipped | `test/m3.*.test.ts` |
| M4 | agent loop; budget; local first; orchestrator | Shipped | `test/m4.*.test.ts` |
| M5 | budget alert; rollup; usage source | Shipped | `test/m5.*.test.ts` |
| M6 | scaffold; ship; templates | Shipped | `test/m6.*.test.ts` |
| M7 | learn cli; recall; store | Shipped | `test/m7.*.test.ts` |
| M9 | index engine; update | Shipped | `test/m9.*.test.ts` |
| M10 | env bridge | Shipped | `test/m10.*.test.ts` |
| M11 | engines; retry; streaming; verify | Shipped | `test/m11.*.test.ts` |
| M12 | background; planner; runner; spec store; store | Shipped | `test/m12.*.test.ts` |
| M13 | dashboard; render; tui once | Shipped | `test/m13.*.test.ts` |
| M14 | api; server; static | Shipped | `test/m14.*.test.ts` |
| M15 | forecast; model manager; pulse json; router | Shipped | `test/m15.*.test.ts` |
| M16 | capture; consolidate; export; playbook | Shipped | `test/m16.*.test.ts` |
| M17 | gate; rollback; runner escalate; sign | Shipped | `test/m17.*.test.ts` |
| M18 | editors; github; identity; notify; vercel | Shipped | `test/m18.*.test.ts` |
| M19 | governance; otlp; telemetry sink | Shipped | `test/m19.*.test.ts` |
| M20 | doctor fix; onboard; self heal | Shipped | `test/m20.*.test.ts` |
| M21 | audit; policy; worktree | Shipped | `test/m21.*.test.ts` |
| M22 | backlog; scanners | Shipped | `test/m22.*.test.ts` |
| M23 | apply; gate; store | Shipped | `test/m23.*.test.ts` |
| M24 | loop; state | Shipped | `test/m24.*.test.ts` |
| M25 | ask; graph; index | Shipped | `test/m25.*.test.ts` |
| M26 | cli; dispatch; playbooks; reflect; store; tuning | Shipped | `test/m26.*.test.ts` |
| M27 | cli; conventions; fixes; health; store | Shipped | `test/m27.*.test.ts` |
| M28 | advance; cli; planner; store | Shipped | `test/m28.*.test.ts` |
| M29 | cli; deliver; digest; portfolio; surface | Shipped | `test/m29.*.test.ts` |
| M30 | ci; cli; coord identity; dispatch; seams; stores | Shipped | `test/m30.*.test.ts` |
| M31 | api; cli agent; contract lock; gateway native; native tools; orient; safety | Shipped | `test/m31.*.test.ts` |
| M32 | desktop notify; estimate; help; inbox api; knowledge progress | Shipped | `test/m32.*.test.ts` |
| M33 | plugin init; plugin manifest; plugin registry; plugin wiring; plugin wrappers; release meta; update channel | Shipped | `test/m33.*.test.ts` |
| M41 | model profile; prompts | Shipped | `test/m41.*.test.ts` |
| M42 | engineer tools | Shipped | `test/m42.*.test.ts` |
| M43 | verify commands | Shipped | `test/m43.*.test.ts` |
| M44 | eval | Shipped | `test/m44.*.test.ts` |
| M45 | foundry | Shipped | `test/m45.*.test.ts` |
| M46 | fleet | Shipped | `test/m46.*.test.ts` |
| M47 | merge | Shipped | `test/m47.*.test.ts` |
| M48 | automerge pass; fleet supervisor | Shipped | `test/m48.*.test.ts` |
| M49 | fleet status | Shipped | `test/m49.*.test.ts` |
| M50 | api client; argv; cloud gate; engine registry | Shipped | `test/m50.*.test.ts` |
| M51 | trust | Shipped | `test/m51.*.test.ts` |
| M52 | confine; profile; write allow | Shipped | `test/m52.*.test.ts` |
| M53 | intel | Shipped | `test/m53.*.test.ts` |
| M54 | self eval; self guard | Shipped | `test/m54.*.test.ts` |
| M55 | commands; conductor | Shipped | `test/m55.*.test.ts` |
| M56 | branch apply; branch gate | Shipped | `test/m56.*.test.ts` |
| M57 | foundry config | Shipped | `test/m57.*.test.ts` |
| M58 | reference plugin | Shipped | `test/m58.*.test.ts` |
| M59 | fleet init | Shipped | `test/m59.*.test.ts` |
| M60 | reference template plugin | Shipped | `test/m60.*.test.ts` |
| M61 | control | Shipped | `test/m61.*.test.ts` |
| M62 | pulse connect | Shipped | `test/m62.*.test.ts` |
| M63 | limits | Shipped | `test/m63.*.test.ts` |
| M64 | codex usage | Shipped | `test/m64.*.test.ts` |
| M65 | secrets | Shipped | `test/m65.*.test.ts` |
| M66 | mcp ecosystem | Shipped | `test/m66.*.test.ts` |
| M67 | security panel | Shipped | `test/m67.*.test.ts` |
| M68 | markdown | Shipped | `test/m68.*.test.ts` |
| M69 | stack | Shipped | `test/m69.*.test.ts` |
| M70 | md render | Shipped | `test/m70.*.test.ts` |
| M71 | onboard stack | Shipped | `test/m71.*.test.ts` |
| M73 | stack command | Shipped | `test/m73.*.test.ts` |
| M75 | fleet watch | Shipped | `test/m75.*.test.ts` |
| M76 | plan parse | Shipped | `test/m76.*.test.ts` |
| M77 | roles | Shipped | `test/m77.*.test.ts` |
| M78 | titrr | Shipped | `test/m78.*.test.ts` |
| M79 | engine run | Shipped | `test/m79.*.test.ts` |
| M80 | subscription usage | Shipped | `test/m80.*.test.ts` |
| M81 | engine readiness | Shipped | `test/m81.*.test.ts` |
| M82 | subscription panel | Shipped | `test/m82.*.test.ts` |
| M84 | goal direct | Shipped | `test/m84.*.test.ts` |
| M85 | fleet continuity | Shipped | `test/m85.*.test.ts` |
| M86 | automerge gate | Shipped | `test/m86.*.test.ts` |
| M87 | anti clog | Shipped | `test/m87.*.test.ts` |
| M88 | fleet digest | Shipped | `test/m88.*.test.ts` |
| M89 | pulse export | Shipped | `test/m89.*.test.ts` |
| M90 | fleet dashboard | Shipped | `test/m90.*.test.ts` |
| M91 | pulse bridge polish | Shipped | `test/m91.*.test.ts` |
| M92 | engines operational | Shipped | `test/m92.*.test.ts` |
| M93 | daemon service; daemon service crash recovery; daemon service install authority; daemon service launchd integration; daemon service transaction; daemon service windows integration; launchd bigint identity; service authority docs; windows file authority | Shipped | `test/m93.*.test.ts` |
| M94 | native notify | Shipped | `test/m94.*.test.ts` |
| M95 | backlog quality | Shipped | `test/m95.*.test.ts` |
| M96 | goal framing | Shipped | `test/m96.*.test.ts` |
| M97 | setup authority boundary; setup wizard; setup wizard authority isolation | Shipped | `test/m97.*.test.ts` |
| M98 | cross platform confine | Shipped | `test/m98.*.test.ts` |
| M99 | backlog actionable | Shipped | `test/m99.*.test.ts` |
| M100 | web open | Shipped | `test/m100.*.test.ts` |
| M101 | high yield scanners | Shipped | `test/m101.*.test.ts` |
| M102 | goal conductor | Shipped | `test/m102.*.test.ts` |
| M103 | desktop action | Shipped | `test/m103.*.test.ts` |
| M104 | web goals | Shipped | `test/m104.*.test.ts` |
| M105 | browser action | Shipped | `test/m105.*.test.ts` |
| M106 | correctness fixes | Shipped | `test/m106.*.test.ts` |
| M107 | security hardening | Shipped | `test/m107.*.test.ts` |
| M108 | fleet quality | Shipped | `test/m108.*.test.ts` |
| M109 | attribution | Shipped | `test/m109.*.test.ts` |
| M110 | team onboarding | Shipped | `test/m110.*.test.ts` |
| M111 | work queue | Shipped | `test/m111.*.test.ts` |
| M112 | keepawake; worker | Shipped | `test/m112.*.test.ts` |
| M113 | coordinator wire | Shipped | `test/m113.*.test.ts` |
| M114 | shared subscription | Shipped | `test/m114.*.test.ts` |
| M115 | local engine; pulse sync | Shipped | `test/m115.*.test.ts` |
| M116 | worker pool | Shipped | `test/m116.*.test.ts` |
| M117 | api model dispatch | Shipped | `test/m117.*.test.ts` |
| M118 | content toolcalls | Shipped | `test/m118.*.test.ts` |
| M119 | quality metrics | Shipped | `test/m119.*.test.ts` |
| M120 | manager | Shipped | `test/m120.*.test.ts` |
| M121 | vision | Shipped | `test/m121.*.test.ts` |
| M122 | oversight export | Shipped | `test/m122.*.test.ts` |
| M123 | judge client | Shipped | `test/m123.*.test.ts` |
| M124 | value filter | Shipped | `test/m124.*.test.ts` |
| M125 | feedback loop | Shipped | `test/m125.*.test.ts` |
| M126 | manager merge gate | Shipped | `test/m126.*.test.ts` |
| M127 | model pinning | Shipped | `test/m127.*.test.ts` |
| M128 | model router | Shipped | `test/m128.*.test.ts` |
| M129 | agent surface | Shipped | `test/m129.*.test.ts` |
| M130 | frontier judge | Shipped | `test/m130.*.test.ts` |
| M131 | routing data | Shipped | `test/m131.*.test.ts` |
| M132 | coder model | Shipped | `test/m132.*.test.ts` |
| M133 | backlog dedup | Shipped | `test/m133.*.test.ts` |
| M134 | adaptive prompts | Shipped | `test/m134.*.test.ts` |
| M135 | judge order | Shipped | `test/m135.*.test.ts` |
| M136 | scan sources | Shipped | `test/m136.*.test.ts` |
| M137 | imessage comms | Shipped | `test/m137.*.test.ts` |
| M138 | comms integration | Shipped | `test/m138.*.test.ts` |
| M139 | comms merge approval | Shipped | `test/m139.*.test.ts` |
| M140 | engine verify | Shipped | `test/m140.*.test.ts` |
| M141 | judge trace | Shipped | `test/m141.*.test.ts` |
| M142 | best of n | Shipped | `test/m142.*.test.ts` |
| M143 | swe bench eval | Shipped | `test/m143.*.test.ts` |
| M144 | llama server | Shipped | `test/m144.*.test.ts` |
| M145 | judge calibration | Shipped | `test/m145.*.test.ts` |
| M147 | telegram comms | Shipped | `test/m147.*.test.ts` |
| M148 | digest judge health | Shipped | `test/m148.*.test.ts` |
| M149 | ace playbook | Shipped | `test/m149.*.test.ts` |
| M150 | prompt optimizer | Shipped | `test/m150.*.test.ts` |
| M151 | edv feedback | Shipped | `test/m151.*.test.ts` |
| M153 | verification gate | Shipped | `test/m153.*.test.ts` |
| M154 | repo map localize | Shipped | `test/m154.*.test.ts` |
| M155 | cascade routing | Shipped | `test/m155.*.test.ts` |
| M157 | judge attestation | Shipped | `test/m157.*.test.ts` |
| M158 | diff safety | Shipped | `test/m158.*.test.ts` |
| M159 | dep safe | Shipped | `test/m159.*.test.ts` |
| M160 | work source rebalance | Shipped | `test/m160.*.test.ts` |
| M161 | backlog ranking | Shipped | `test/m161.*.test.ts` |
| M162 | elite strategist | Shipped | `test/m162.*.test.ts` |
| M163 | strategic context | Shipped | `test/m163.*.test.ts` |
| M164 | frontier routing | Shipped | `test/m164.*.test.ts` |
| M165 | self heal | Shipped | `test/m165.*.test.ts` |
| M166 | model racing | Shipped | `test/m166.*.test.ts` |
| M167 | browser verify | Shipped | `test/m167.*.test.ts` |
| M168 | phantom secrets | Shipped | `test/m168.*.test.ts` |
| M169 | mcp fleet surface | Shipped | `test/m169.*.test.ts` |
| M170 | daemon wiring | Shipped | `test/m170.*.test.ts` |
| M171 | browser verify wiring | Shipped | `test/m171.*.test.ts` |
| M172 | judge in loop | Shipped | `test/m172.*.test.ts` |
| M173 | vision approve | Shipped | `test/m173.*.test.ts` |
| M175 | verification eligibility | Shipped | `test/m175.*.test.ts` |
| M176 | judge resolver | Shipped | `test/m176.*.test.ts` |
| M177 | comms cadence | Shipped | `test/m177.*.test.ts` |
| M178 | routetask crash | Shipped | `test/m178.*.test.ts` |
| M179 | ecosystem manager | Shipped | `test/m179.*.test.ts` |
| M180 | elon dialogue; elon unit | Shipped | `test/m180.*.test.ts` |
| M181 | generative invent | Shipped | `test/m181.*.test.ts` |
| M182 | routebackend frontier | Shipped | `test/m182.*.test.ts` |
| M183 | taste critic | Shipped | `test/m183.*.test.ts` |
| M184 | ecosystem context | Shipped | `test/m184.*.test.ts` |
| M185 | ashlrcode engine | Shipped | `test/m185.*.test.ts` |
| M186 | invent cycle | Shipped | `test/m186.*.test.ts` |
| M187 | counterfactual | Shipped | `test/m187.*.test.ts` |
| M188 | blast radius | Shipped | `test/m188.*.test.ts` |
| M189 | regression sentinel | Shipped | `test/m189.*.test.ts` |
| M190 | spec contract | Shipped | `test/m190.*.test.ts` |
| M191 | red team | Shipped | `test/m191.*.test.ts` |
| M192 | daemon integration | Shipped | `test/m192.*.test.ts` |
| M193 | gate integration | Shipped | `test/m193.*.test.ts` |
| M194 | frontier usage | Shipped | `test/m194.*.test.ts` |
| M195 | nim backend | Shipped | `test/m195.*.test.ts` |
| M197 | observability | Shipped | `test/m197.*.test.ts` |
| M198 | digest store | Shipped | `test/m198.*.test.ts` |
| M199 | orchestrator | Shipped | `test/m199.*.test.ts` |
| M200 | multibackend merge | Shipped | `test/m200.*.test.ts` |
| M201 | daemon loop | Shipped | `test/m201.*.test.ts` |
| M202 | cascade browserverify edge | Shipped | `test/m202.*.test.ts` |
| M210 | dashboard | Shipped | `test/m210.*.test.ts` |
| M211 | dashboard cli; dashboard service install authority | Shipped | `test/m211.*.test.ts` |
| M212 | proactive comms | Shipped | `test/m212.*.test.ts` |
| M213 | dashboard sse | Shipped | `test/m213.*.test.ts` |
| M214 | automerge hooks; fleet pulse emit | Shipped | `test/m214.*.test.ts` |
| M215 | rich comms | Shipped | `test/m215.*.test.ts` |
| M220 | anticlog verdict feedback | Shipped | `test/m220.*.test.ts` |
| M222 | goal planner | Shipped | `test/m222.*.test.ts` |
| M223 | goal planner activation | Shipped | `test/m223.*.test.ts` |
| M224 | production panel | Shipped | `test/m224.*.test.ts` |
| M225 | sandbox cwd | Shipped | `test/m225.*.test.ts` |
| M227 | goal frontier exec | Shipped | `test/m227.*.test.ts` |
| M228 | milestone proposal link | Shipped | `test/m228.*.test.ts` |
| M229 | goal engine trio | Shipped | `test/m229.*.test.ts` |
| M230 | claude auth passthrough | Shipped | `test/m230.*.test.ts` |
| M231 | north star grounding | Shipped | `test/m231.*.test.ts` |
| M233 | partial diff on timeout | Shipped | `test/m233.*.test.ts` |
| M235 | self improve | Shipped | `test/m235.*.test.ts` |
| M236 | stall monitor | Shipped | `test/m236.*.test.ts` |
| M240 | learned routing | Shipped | `test/m240.*.test.ts` |
| M241 | event bus | Shipped | `test/m241.*.test.ts` |
| M242 | intelligence panel | Shipped | `test/m242.*.test.ts` |
| M243 | skill library | Shipped | `test/m243.*.test.ts` |
| M244 | standup | Shipped | `test/m244.*.test.ts` |
| M245 | self improve integration | Shipped | `test/m245.*.test.ts` |
| M246 | telemetry truth | Shipped | `test/m246.*.test.ts` |
| M247 | gateway equivalence | Shipped | `test/m247.*.test.ts` |
| M248 | fleet mcp | Shipped | `test/m248.*.test.ts` |
| M249 | run cache shadow | Shipped | `test/m249.*.test.ts` |
| M250 | resource control | Shipped | `test/m250.*.test.ts` |
| M253 | claude usage | Shipped | `test/m253.*.test.ts` |
| M254 | usage api | Shipped | `test/m254.*.test.ts` |
| M255 | concurrent dispatch | Shipped | `test/m255.*.test.ts` |
| M256 | workhorse dispatch | Shipped | `test/m256.*.test.ts` |
| M257 | director | Shipped | `test/m257.*.test.ts` |
| M258 | sandbox goal guard | Shipped — **collision** (see §2) | `test/m258.*.test.ts` |
| M259 | diff dedup producer credit; queue drain | Shipped — **collision** (see §2) | `test/m259.*.test.ts` |
| M260 | resolve concrete model | Shipped — **collision** (see §2) | `test/m260.*.test.ts` |
| M261 | proposal mutation lock; verify result persistence | Shipped — **collision** (see §2) | `test/m261.*.test.ts` |
| M262 | visibility | Shipped — **collision** (see §2) | `test/m262.*.test.ts` |
| M263 | drain starvation | Shipped — **collision** (see §2) | `test/m263.*.test.ts` |
| M264 | local context | Shipped — **collision** (see §2) | `test/m264.*.test.ts` |
| M270 | frontier ambition | Shipped — **collision** (see §2) | `test/m270.*.test.ts` |
| M271 | drain stall | Shipped — **collision** (see §2) | `test/m271.*.test.ts` |
| M273 | fleet drain dead zone | Shipped — **collision** (see §2) | `test/m273.*.test.ts` |
| M274 | judge reachable | Shipped — **collision** (see §2) | `test/m274.*.test.ts` |
| M275 | completeness gate | Shipped — **collision** (see §2) | `test/m275.*.test.ts` |
| M280 | simple conductor | Shipped | `test/m280.*.test.ts` |
| M281 | delta gate | Shipped | `test/m281.*.test.ts` |
| M283 | mcp exclude | Shipped | `test/m283.*.test.ts` |
| M286 | worktree verify env | Shipped | `test/m286.*.test.ts` |
| M297 | retry transient abort | Shipped | `test/m297.*.test.ts` |
| M298 | stream json+grok engine+conductor directive | Shipped | `test/m298.*.test.ts` |
| M299 | web fleet control | Shipped | `test/m299.*.test.ts` |
| M300 | resource aware dispatch | Shipped | `test/m300.*.test.ts` |
| M301 | autonomy policy | Shipped | `test/m301.*.test.ts` |
| M303 | guard health | Shipped | `test/m303.*.test.ts` |
| M304 | outcome records | Shipped | `test/m304.*.test.ts` |
| M305 | automerge readiness preflight | Shipped | `test/m305.*.test.ts` |
| M306 | resource strategy | Shipped | `test/m306.*.test.ts` |
| M307 | verify before judge | Shipped | `test/m307.*.test.ts` |
| M309 | automerge gate explainer | Shipped | `test/m309.*.test.ts` |
| M310 | queued autonomy work | Shipped | `test/m310.*.test.ts` |
| M311 | backlog cli sources | Shipped | `test/m311.*.test.ts` |
| M312 | ecosystem focus | Shipped | `test/m312.*.test.ts` |
| M313 | claude rate limit event | Shipped | `test/m313.*.test.ts` |
| M314 | repo execution profile; visual grounding | Shipped | `test/m314.*.test.ts` |
| M315 | remote handoff truth | Shipped | `test/m315.*.test.ts` |
| M320 | claude5 catalog | Shipped | `test/m320.*.test.ts` |
| M321 | claude5 routing | Shipped | `test/m321.*.test.ts` |
| M322 | model roi | Shipped | `test/m322.*.test.ts` |
| M323 | model granular routing | Shipped | `test/m323.*.test.ts` |
| M324 | claude5 safety | Shipped | `test/m324.*.test.ts` |
| M331 | verify to green | Shipped | `test/m331.*.test.ts` |
| M332 | outcome watcher | Shipped | `test/m332.*.test.ts` |
| M333 | best of n multimodel | Shipped | `test/m333.*.test.ts` |
| M334 | gateway shadow | Shipped | `test/m334.*.test.ts` |
| M335 | model stats | Shipped | `test/m335.*.test.ts` |
| M336 | swe bench gate | Shipped | `test/m336.*.test.ts` |
| M337 | sandbox cancellation | Shipped | `test/m337.*.test.ts` |
| M338 | learning graph; run cancellation compat; swarm cancellation compat | Shipped | `test/m338.*.test.ts` |
| M339 | run store integrity; swarm store integrity | Shipped | `test/m339.*.test.ts` |
| M342 | binshield scan; dispatch production ledger | Shipped | `test/m342.*.test.ts` |
| M343 | agent action ledger | Shipped | `test/m343.*.test.ts` |
| M344 | production velocity | Shipped | `test/m344.*.test.ts` |
| M345 | attempt identity; delegation scope | Shipped | `test/m345.*.test.ts` |
| M346 | eval attention | Shipped | `test/m346.*.test.ts` |
| M347 | phantom readiness | Shipped | `test/m347.*.test.ts` |
| M348 | fleet phantom | Shipped | `test/m348.*.test.ts` |
| M349 | secret safety invariants | Shipped | `test/m349.*.test.ts` |
| M350 | triviality | Shipped | `test/m350.*.test.ts` |
| M351 | action counts | Shipped | `test/m351.*.test.ts` |
| M352 | attempt records | Shipped | `test/m352.*.test.ts` |
| M353 | dispatch manifest | Shipped | `test/m353.*.test.ts` |
| M354 | trajectory records | Shipped | `test/m354.*.test.ts` |
| M355 | skill records | Shipped | `test/m355.*.test.ts` |
| M356 | skill retrieval | Shipped | `test/m356.*.test.ts` |
| M357 | skill card attestation; skill shadow observer | Shipped | `test/m357.*.test.ts` |
| M358 | skill use identity | Shipped | `test/m358.*.test.ts` |
| M359 | skill selection equivalence | Shipped | `test/m359.*.test.ts` |
| M360 | generated repair lifecycle | Shipped | `test/m360.*.test.ts` |
| M361 | agent diagnostics | Shipped | `test/m361.*.test.ts` |
| M362 | repair handoff journal | Shipped | `test/m362.*.test.ts` |
| M363 | work item objective | Shipped | `test/m363.*.test.ts` |
| M364 | source base digest | Shipped | `test/m364.*.test.ts` |
| M365 | resolution witness ledger | Shipped | `test/m365.*.test.ts` |
| M366 | merge contract resolution witness | Shipped | `test/m366.*.test.ts` |
| M367 | daemon observer scheduler; resolution observer | Shipped | `test/m367.*.test.ts` |
| M368 | provenance key filesystem; resolution observer hardening; scanner observation digest | Shipped | `test/m368.*.test.ts` |
| M369 | context rollup; daemon context rollup | Shipped | `test/m369.*.test.ts` |
| M370 | best of n ledger; branch protection attestation | Shipped | `test/m370.*.test.ts` |
| M371 | evidence doctor; post merge observations | Shipped | `test/m371.*.test.ts` |
| M372 | test ci watchdog | Shipped | `test/m372.*.test.ts` |
| M373 | directory durability | Shipped | `test/m373.*.test.ts` |
| M374 | monitoring cursor; post merge stability; proposal source quality | Shipped | `test/m374.*.test.ts` |
| M375 | post merge window | Shipped | `test/m375.*.test.ts` |
| M376 | post merge stability producer | Shipped | `test/m376.*.test.ts` |
| M377 | post merge stability observer | Shipped | `test/m377.*.test.ts` |
| M378 | remote handoff attestation | Shipped | `test/m378.*.test.ts` |
| M379 | private storage | Shipped | `test/m379.*.test.ts` |
| M380 | reconciliation key windows | Shipped | `test/m380.*.test.ts` |
| M381 | post merge population v2 | Shipped | `test/m381.*.test.ts` |
| M382 | enrollment cutoff snapshot | Shipped | `test/m382.*.test.ts` |
| M383 | cutoff observation checkpoints | Shipped | `test/m383.*.test.ts` |
| M384 | cutoff observation status | Shipped | `test/m384.*.test.ts` |
| M385 | cutoff checkpoint scheduler; cutoff checkpoint windows | Shipped | `test/m385.*.test.ts` |
| M386 | daemon activity | Shipped | `test/m386.*.test.ts` |
| M387 | origin authority | Shipped | `test/m387.*.test.ts` |
| M388 | stable file read | Shipped | `test/m388.*.test.ts` |
| M389 | persistence generation cas | Shipped | `test/m389.*.test.ts` |
| M390 | persistence ownership recovery | Shipped | `test/m390.*.test.ts` |
| M391 | execution lifecycle authority | Shipped | `test/m391.*.test.ts` |
| M392 | queue lease epochs | Shipped | `test/m392.*.test.ts` |
| M394 | effect journal integration | Shipped | `test/m394.*.test.ts` |
| M395 | effect terminal retention | Shipped | `test/m395.*.test.ts` |
| M396 | automerge canary classifier | Shipped | `test/m396.*.test.ts` |
| M397 | automerge canary store | Shipped | `test/m397.*.test.ts` |
| M398 | merge decision truth | Shipped | `test/m398.*.test.ts` |
| M399 | automerge canary cli; feedback merge truth | Shipped | `test/m399.*.test.ts` |
| M401 | automerge canary status | Shipped | `test/m401.*.test.ts` |
| M402 | automerge canary shadow hook | Shipped | `test/m402.*.test.ts` |
| M403 | automerge mutation fence | Shipped | `test/m403.*.test.ts` |
| M404 | policy result surfaces | Shipped | `test/m404.*.test.ts` |
| M405 | apply mutation fence | Shipped | `test/m405.*.test.ts` |
| M406 | daemon stop quiescence | Shipped | `test/m406.*.test.ts` |
| M407 | verification mutation fence | Shipped | `test/m407.*.test.ts` |
| M408 | sandbox creation mutation fence | Shipped | `test/m408.*.test.ts` |
| M409 | engine execution mutation fence | Shipped | `test/m409.*.test.ts` |
| M410 | policy opposing race | Shipped | `test/m410.*.test.ts` |
| M411 | local merge reconciliation | Shipped | `test/m411.*.test.ts` |
| M412 | sandbox pre effect recovery | Shipped | `test/m412.*.test.ts` |
| M413 | engineer run mutation fence | Shipped | `test/m413.*.test.ts` |
| M414 | local store lock unknown owner | Shipped | `test/m414.*.test.ts` |
| M415 | policy durability races | Shipped | `test/m415.*.test.ts` |
| M416 | local store lock handoff | Shipped | `test/m416.*.test.ts` |
| M417 | sandbox cleanup quiescence | Shipped | `test/m417.*.test.ts` |
| M418 | pulse quiescence | Shipped | `test/m418.*.test.ts` |
| M419 | remote handoff intent | Shipped | `test/m419.*.test.ts` |
| M420 | remote handoff recovery | Shipped | `test/m420.*.test.ts` |
| M421 | legacy pulse quiescence | Shipped | `test/m421.*.test.ts` |
| M422 | policy transaction recovery | Shipped | `test/m422.*.test.ts` |
| M423 | control plane lock order | Shipped | `test/m423.*.test.ts` |
| M424 | legacy swarm mutation fence | Shipped | `test/m424.*.test.ts` |
| M425 | persistence private temp; policy startup recovery | Shipped | `test/m425.*.test.ts` |
| M426 | sandbox reservation identity | Shipped | `test/m426.*.test.ts` |
| M428 | goal source quality | Shipped | `test/m428.*.test.ts` |
| M429 | judge free remote policy | Shipped | `test/m429.*.test.ts` |
| M430 | signed evidence pack | Shipped | `test/m430.*.test.ts` |
| M431 | evidence signing key | Shipped | `test/m431.*.test.ts` |
| M432 | operational membership; operational projection | Shipped | `test/m432.*.test.ts` |
| M433 | operational projection transaction | Shipped | `test/m433.*.test.ts` |
| M434 | operational projection replay ledger | Shipped | `test/m434.*.test.ts` |
| M435 | agent semantic events | Shipped | `test/m435.*.test.ts` |
| M436 | reviewer independence | Shipped | `test/m436.*.test.ts` |
| M437 | post merge credit firewall | Shipped | `test/m437.*.test.ts` |
| M438 | learning eligibility | Shipped | `test/m438.*.test.ts` |
| M439 | proposal dedup authority | Shipped | `test/m439.*.test.ts` |
| M440 | dependency audit ci; runtime release manifest; trajectory join quality | Shipped | `test/m440.*.test.ts` |
| M441 | runtime release evidence envelope | Shipped | `test/m441.*.test.ts` |
| M442 | runtime release launch revalidation | Shipped | `test/m442.*.test.ts` |
| M443 | runtime release launch admission | Shipped | `test/m443.*.test.ts` |
| M444 | external skill audit | Shipped | `test/m444.*.test.ts` |
| M445 | external skill shadow eval | Shipped | `test/m445.*.test.ts` |
| M446 | external skill git capture | Shipped | `test/m446.*.test.ts` |
| M447 | external skill custody attestation | Shipped | `test/m447.*.test.ts` |
| M450 | skill routing calibration | Shipped | `test/m450.*.test.ts` |
| M451 | external skill audit receipt | Shipped | `test/m451.*.test.ts` |
| M453 | skill routing calibration snapshot | Shipped | `test/m453.*.test.ts` |
| M454 | agent skills generator; agent skills routing challenge | Shipped | `test/m454.*.test.ts` |
| M455 | external skill maturity | Shipped | `test/m455.*.test.ts` |
| M456 | skill retrieval calibration | Shipped | `test/m456.*.test.ts` |
| M457 | external skill artifact firewall | Shipped | `test/m457.*.test.ts` |
| M460 | policy assignment receipts | Shipped | `test/m460.*.test.ts` |
| M461 | activation integration; activation permit; demo activation refusal | Shipped | `test/m461.*.test.ts` |
| M463 | claimed batch admission | Shipped | `test/m463.*.test.ts` |
| M464 | Agent work-transition audit trail (metadata-only phase/transition/trigger vocab) | Shipped | `test/m464.*.test.ts` |
| M465 | Automerge canary promotion readiness — observation-only evidence check | Shipped | `test/m465.*.test.ts` |
| M466 | Auto-merge diff-scope measurement (fail-closed) + durable host-merge revocation protocol | Shipped | `test/m466.*.test.ts` |
| M467 | Detached post-merge verification cohorts (signed, immutable, observation-only) | Shipped | `test/m467.*.test.ts` |
| M468 | Detached post-merge runner + release-desktop workflow supply-chain policy + resident-service readiness diagnostics | Shipped | `test/m468.*.test.ts` |
| M469 | Proposal funnel observability (attempt/capture/policy/gate metrics, scrubbed) | Shipped | `test/m469.*.test.ts` |
| M470 | **Collision, see §2.** Proposal capture candidate identity (original); Daemon activation authority (added 2026-08-16, unrelated) | Shipped (both) | `test/m470.*.test.ts` (two files, two features) |
| M471 | Simple-conductor transactional settlement (claim/settle/reconcile, CAS) | Shipped | `test/m471.*.test.ts` |
| M472 | Detached post-merge orchestrator (observation-only scheduler) | Shipped | `test/m472.*.test.ts` |
| M473 | Verifier execution authority (signed capsule admission, data-only) | Shipped | `test/m473.*.test.ts` |
| M475 | Verifier execution policy approval (crypto-only approval observation) | Shipped | `test/m475.*.test.ts` |
| M476 | Release current-tip store (immutable no-clobber sequence ledger) | Shipped | `test/m476.*.test.ts` |
| M477 | Public JSON readiness (secret/path scrubbing for dashboard/API payloads) | Shipped | `test/m477.*.test.ts` |
| M478 | Root verification contract (repo execution-profile detection, observational) | Shipped | `test/m478.*.test.ts` |
| M479 | npm release workflow supply-chain admission (action pinning, branch gating) | Shipped | `test/m479.*.test.ts` |
| M480 | Mobile navigation (dashboard responsive shell) | Shipped | `test/m480.*.test.ts` |
| M481 | CI workflow action trust chain (pinned action commits) | Shipped | `test/m481.*.test.ts` |
| M482 | Release artifact contract (dependency inventory + manifest integrity) | Shipped | `test/m482.*.test.ts` |
| M484 | PR topology shadow observation (stack linearity, read-only) | Shipped | `test/m484.*.test.ts` |
| M485 | Mission compiler + operator briefing (goal reconciliation from briefings, read-only UI) | Shipped | `test/m485.*.test.ts` |
| M486 | Daemon spend durability (fsync power-loss barriers for accounting) | Shipped | `test/m486.*.test.ts` |
| M487 | Daemon state quarantine (authorized atomic hard-link evidence publication) | Shipped | `test/m487.*.test.ts` |
| M488 | Runtime release canary + rollback evidence (observation-only signed-pair verification) | Shipped | `test/m488.*.test.ts` |
| M490 | Daemon state recovery CLI (quarantine + resolution wiring) | Shipped | `test/m490.*.test.ts` |
| M491 | Ecosystem mission graph compilation (deterministic, cycle-checked, digested) | Shipped | `test/m491.*.test.ts` |
| M492 | Mission outcome room (fail-closed planning-only projection) | Shipped | `test/m492.*.test.ts` |
| M493 | Mission observation receipt (signed, durable, no execution authority) | Shipped | `test/m493.*.test.ts` |
| M494 | Mission reconcile shadow (bounded zero-effect goal-creation suggestions) | Shipped | `test/m494.*.test.ts` |
| M495 | Ecosystem evidence envelope (Cortex mission candidate + Locus identity validation) | Shipped | `test/m495.*.test.ts` |
| M496 | Mission observation capture (authenticated realized-merge filtering) | Shipped | `test/m496.*.test.ts` |
| M497 | Vision shadow CLI (evidence-only shadow reconciliation) | Shipped | `test/m497.*.test.ts` |
| M498 | Best-of-N CLI count boundary validation | Shipped | `test/m498.*.test.ts` |
| M501 | Daemon state resolution (post-quarantine fresh-state production) | Shipped | `test/m501.*.test.ts` |
| M502 | Mission shadow observer (read-only zero-effect suggestion) | Shipped | `test/m502.*.test.ts` |
| M503 | Dashboard read-only auth mode (SSE + reads permitted, mutation blocked) | Shipped | `test/m503.*.test.ts` |
| M504 | Automerge scope ceiling; goal direct authority; Ollama identity (three unrelated test files, one number, see §6) | Shipped | `test/m504.*.test.ts` |
| M505 | Host auto-merge (`hostAutoMerge` config flag, defaults off) | Shipped | `test/m505.host-auto-merge.test.ts` |
| M506 | Host auto-merge E2E; signed release canary (two unrelated test files, one number) | Shipped | `test/m506.*.test.ts` |
| M513 | Verified protected PR handoff | Shipped | `test/m513.*.test.ts` |
| M514 | Release canary workflow | Shipped | `test/m514.*.test.ts` |
| M515 | Release publish authority split; runtime activation launch handoff (two unrelated test files, one number) | Shipped | `test/m515.*.test.ts` |
| M516 | Fleet-status cache; goal-conductor activation permit; goal-conductor CAS; goal-conductor one-shot (four test files, one number, see §6) | Shipped | `test/m516.*.test.ts` |
| M517 | Goal-conductor quota bridge (provider quota tickets) | Shipped | `test/m517.*.test.ts` |
| M518 | Goal-conductor permit operator (cold-custody conductor-permit CLI, incl. the reachability guard replacing the old filename-ban test); goal timestamp repair | Shipped | `test/m518.*.test.ts` |
| M519 | Release candidate supersession | Shipped | `test/m519.*.test.ts` |
</details>

---

## 5. M464–M503 — the range missing from every other doc

These 35 milestone numbers (M464–M503, minus gaps at M474, M483, M489, M499,
M500 which have no test file) had zero references anywhere in `docs/`,
`CHANGELOG.md`, or `README.md` before this pass. See `CHANGELOG.md`
`[Unreleased]` for grouped release notes, and `docs/contracts/` for the
milestones substantial enough to warrant a standalone contract
(M486, M487, M493, M501).

## 6. M504–M519 — dates checked with `git log --diff-filter=A`, not assumed

**Not all of these landed 2026-08-16 — an earlier draft of this section
claimed that and was wrong.** Per-file creation dates
(`git log --diff-filter=A --format='%ad' -- <file>`), because assuming "next
number after M503" means "landed today" is exactly the kind of unverified
claim this index exists to prevent:

| ID | Test file | Created |
|----|-----------|---------|
| M504 | `automerge-scope-ceiling` | **2026-08-16** |
| M504 | `goal-direct-authority` | 2026-08-12 |
| M504 | `ollama-identity` | 2026-08-12 |
| M505 | `host-auto-merge` | **2026-08-16** |
| M506 | `host-auto-merge-e2e` | **2026-08-16** |
| M506 | `signed-release-canary` | 2026-08-14 |
| M513 | `verified-protected-pr-handoff` | 2026-08-14 |
| M514 | `release-canary-workflow` | 2026-08-15 |
| M515 | `release-publish-authority-split` | 2026-08-15 |
| M515 | `runtime-activation-launch-handoff` | pre-2026-08-14 (`CONTRACT-M515`) |
| M516 | `fleet-status-cache` | **2026-08-16** |
| M516 | `goal-conductor-activation-permit` / `-cas` / `-one-shot` | **2026-08-16** |
| M517 | `goal-conductor-quota-bridge` | **2026-08-16** |
| M518 | `goal-conductor-permit-operator` | **2026-08-16** |
| M518 | `goal-timestamp-repair(-faults)` | **2026-08-16** |
| M519 | `release-candidate-supersession` | **2026-08-16** |

So: **M505, M517, M519, and the second (unrelated) half of M470 are wholly
today's work.** M504, M506, M516, and M518 each mix a 2026-08-16 addition
with pre-existing work from the same number. M513, M514, and M515 predate
today entirely (2026-08-14/15) and were simply never added to this index
before now — their presence here is a backlog fix, not new work.

None of M504–M519 were previously documented anywhere in `docs/` or
`CHANGELOG.md` (this appendix stopped at M503), so unlike M470 none of these
collisions were *silently reused over an existing description* — they just
were never checked against each other. M507–M512 are unused, not a gap in
this doc.

- **M504** — three unrelated features: automerge scope ceiling (today),
  goal direct authority, and Ollama identity (both 2026-08-12).
- **M505** — host auto-merge only. Not a collision.
- **M506** — host auto-merge E2E (today) and signed release canary
  (2026-08-14) — unrelated.
- **M515** — release publish authority split (2026-08-15) and runtime
  activation launch handoff (the `CONTRACT-M515` dormant proof-child
  observer described in `docs/RUNTIME_ACTIVATION_AUTHORITY.md`'s "Dormant
  activation-bound handoff observation" section, predating both) —
  unrelated.
- **M516** — fleet-status cache (today) and three goal-conductor pieces
  (activation permit, CAS, one-shot; all today). The cache is unrelated to
  the other three; the three goal-conductor pieces are plausibly one
  feature split across test files rather than three separate collisions,
  but that grouping was not independently re-verified against source —
  treat it as a hint, not a confirmed claim.
- **M518** — the conductor-permit-operator CLI (including the reachability
  guard test described in the CHANGELOG's "Fleet activation unblocked"
  entry) and goal-timestamp-repair — both today, unrelated to each other.

Hand-verified against source (file:line citations exist in the CHANGELOG's
2026-08-16 entry and in §2 above): M470 (both halves), M504
(`automerge-scope-ceiling` half only), M505, M516 (`fleet-status-cache` half
only), M518 (`goal-conductor-permit-operator` half only). Every other
subject in this section — including all of M513/M514/M515 — is
filename-derived only, matching the rest of §4's stated methodology;
re-verify before citing as fact.

## Maintenance

When you build the next milestone: **check this file before picking its
number.** If the number already appears in §4, either the ID is taken
(pick the next free one) or you are intentionally continuing a series
(say so in the CHANGELOG entry). Add the new row to §4 and, if the milestone
is substantial (changes behavior, adds an authority boundary, or is
independently testable), add a `docs/contracts/CONTRACT-Mxx.md`.

M470 shipped two unrelated features on the same number *within one day* of
each other because this exact check was skipped — this is not a hypothetical
risk the doc is warning about, it is what happened today. Grep this file for
your candidate number before writing the first line of a new test.
