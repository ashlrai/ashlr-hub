# CONTRACT-M444: External Skill Pack Quarantine Audit

## Objective

Ashlr can inspect a local third-party agent-skill pack and produce bounded,
content-addressed evidence about its structure and deterministic trigger
routing without executing, importing, persisting, or trusting pack content.

## Public Interface

```text
ashlr skills audit <pack-path> [--json]
```

The JSON result is `ExternalSkillAuditReport` version 2. Exit code `0` means
only that the exact audited snapshot is ready for a later isolated trial. Exit
code `1` means the snapshot is not trial-ready. Exit code `2` means bad usage,
including help flags; therefore exit code `0` has exactly one meaning. With
`--json`, usage failures also return bounded JSON rather than human help text.

Every result has:

- `mode: "quarantine"`
- `promotion.eligible: false`
- fixed promotion blockers requiring isolation, behavioral evidence, and
  verified outcomes, including immutable source reacquisition
- a SHA-256 digest over the complete non-Git pack tree
- a portable SHA-256 digest over the same names, types, and bytes with
  checkout-only read/write permission bits normalized
- bounded structural, routing, collision, fixture, issue-code, and per-skill
  hash metadata

## Authority Firewall

This command MUST NOT:

- execute scripts, commands, hooks, fixtures, or model calls from the pack
- write `SkillCard`, `SkillUseEvent`, genome, learning, proposal, decision,
  evidence, agent-action, or merge records
- return raw descriptions, prompts, expectations, fixture bytes, skill bodies,
  command output, paths, environment values, or file contents
- set `selectedSkillIds`, active skill mode, route/model/budget/tool policy,
  proposal status, verification status, approval, or merge authority
- treat declared behavioral cases as executed or passing evidence

No later caller may reinterpret `trialReady` as production trust. External
qualification, Ashlr-native skill authoring, shadow selection, active prompt
use, and merge policy are separate future contracts.

## Snapshot Rules

`packDigest` commits to the bounded names, metadata, and bytes observed in one
in-memory audit pass. Portable Node filesystem APIs cannot promise an atomic
snapshot against an actively racing same-principal writer. The CLI therefore
runs the pass in a killable process with a 30-second deadline, detects observed
mutation, and blocks on timeout or worker failure. A later trial MUST reacquire
the digest into separate immutable content-addressed storage and MUST NOT reuse
the audited live path.

`portablePackDigest` is a separate transport identity for that reacquisition.
It normalizes regular files to `0644` and directories to `0755`, so clone
umasks, Windows executable-bit loss, and later read-only sealing cannot change
content identity. Git executable modes remain separately bound by M446's
capture envelope. `packDigest` remains the forensic live-snapshot digest
and continues to bind the exact observed permission bits. Neither digest grants
trial, execution, routing, learning, proposal, verification, or merge authority.

- Ignore `.git` metadata only when the root entry is a real directory; reject a
  symlink or special entry there. Hash every other supported entry by relative
  name, type, and content.
- Read directory names and symlink targets as raw bytes, reject invalid UTF-8,
  and use length-prefixed hashing so byte-distinct trees cannot share identity
  through replacement decoding or delimiter ambiguity. Bun runtimes whose
  directory APIs do not preserve buffer names reject replacement-decoded paths.
- Bind UTF-8 skill definitions, eval contracts, supporting files, scripts,
  licenses, commands, and behavioral fixtures.
- Bind safe relative symlinks only when their resolved target remains inside
  the pack and outside the excluded root `.git` tree. Never follow them while
  constructing a second tree.
- Never accept a symlink as or beneath a referenced behavioral fixture tree;
  later trial runners must not consume bytes outside the bound fixture snapshot.
- Reject absolute/external symlinks, hardlinks, special files, traversal,
  a symlinked pack root, special permission bits, invalid UTF-8 in names, links,
  or parsed text, mutation during reads, and file/tree/depth/byte limits. Enumerate directories
  incrementally and stop at the entry cap.
- Build inventory, parsing, fixture validation, and routing evidence only from
  the bounded in-memory snapshot used for the reported digest; never re-read a
  live directory or file to compute the verdict.
- Require one matching eval contract per skill and reject orphan case files,
  ambiguous or duplicate manifest keys, routing-vector-equivalent trigger
  prompts within or across skills, duplicate behavioral IDs or fixture references,
  empty behavioral oracles, unknown negative owners, oversized case
  arrays/text, and `top_k` above five.
- Require each skill to declare when-to-use, process/workflow, and verification
  sections with substantive visible content. Headings inside fenced code or
  HTML comments and non-rendered raw HTML blocks do not count; tag/entity-only
  bodies and content inside raw HTML containers are not substantive.
  Any top-level raw-HTML token disqualifies structural section evidence for the
  document; raw HTML is never accepted as trust evidence.
  Adversarial/rationalization sections remain advisory warnings.
- Positive routing credit requires a nonzero lexical score. Negative owner
  credit requires a strictly greater score; ownerless negative credit likewise
  requires a strictly stronger competing score, so alphabetical ties never pass.
- Rank-one credit requires a strict score win over every competing skill.
  Top-k credit requires every equal-scoring candidate to fit inside the allowed
  boundary; alphabetical ordering never turns a boundary tie into evidence.
  Duplicate detection canonicalizes token order and proportional term counts,
  matching cosine-vector direction rather than surface punctuation.
- Enforce top-k, negative, and 80% rank-one thresholds independently for every
  skill as well as across the pack; strong skills cannot mask a failed skill.

## Verification

`test/m444.external-skill-audit.test.ts` covers:

- trial-ready but never promotable semantics
- full-tree, eval-contract, and fixture content binding
- no raw external text in reports
- symlink, hardlink, malformed or duplicate-key contract, orphan case, duplicate, inflated
  `top_k`, lexical-zero, unavailable pack, and CLI usage behavior
- stable JSON output and help/completion discoverability

The pinned `addyosmani/agent-skills` snapshot at commit `fefc4075` is a runtime
smoke fixture only. Its current deterministic result is not hard-coded into CI
and grants no Ashlr authority.
