# CONTRACT-M446: External Skill Git-Object Quarantine Capture

## Objective

M446 captures one exact external-skill tree from an already-fetched bare Git
object database into a bounded, private, content-addressed quarantine store. It
reads and verifies Git objects directly and publishes an inert canonical
bundle plus a commit-last receipt. It does not fetch, check out, extract,
execute, activate, qualify, or promote external content.

Successful capture proves that the bytes installed in the local store matched
the selected, physically present Git objects and the expected M444 portable
tree digest when M446 observed them. It does **not** prove publisher identity,
content safety, trial readiness, or immutability against a process running as
the same OS principal. That principal can rewrite store bytes and local keys;
strong custody requires a separate principal or external write-once authority.
The initial implementation is POSIX-only. Windows returns
`platform-unsupported` until Git executable identity and source/store ancestry
can be enforced by a dedicated ACL-backed custody adapter.

## Internal Preview Interface

```ts
captureExternalSkillGitObject({
  repoPath,                    // absolute path to an existing bare repository
  commitOid,                   // full lowercase SHA-1 or SHA-256 commit OID
  packSubdir,                  // "." or one portable relative tree path
  expectedPortablePackDigest, // M444 portablePackDigest
}, options?)
```

The input is structured-cloned and closed-schema validated. Refs, branch or
tag names, abbreviated OIDs, revision expressions, unknown fields, unsafe
subdirectories, and malformed digests are rejected. M446 accepts no URL and
contains no network acquisition path.
The function is intentionally not exported from Ashlr's runtime package API.
Only its closed result/input types are exposed through `@ashlr/hub/types`; an
AST import guard permits that type-only edge and rejects direct runtime import,
export, require, and literal dynamic-import edges. It is a regression guard,
not a same-principal security boundary against deliberately obfuscated code.

`ExternalSkillGitCaptureResult` version 1 returns only bounded metadata:

- `state: captured|replayed|withheld` and a fixed `reason` enum;
- `captureDigest`, `captureReceiptDigest`, `portablePackDigest`, and opaque
  `sourceIdentity` when capture succeeds;
- file, symlink, and byte counts;
- `custody.localIntegrity: verified|unavailable` and
  `custody.authenticated: false`; and
- fixed false execution, policy, and promotion authority fields.

Every result states:

```text
mode: git-object-quarantine
authority: observation-only
executionEligible: false
policyEligible: false
promotionEligible: false
```

## Authority Firewall

M446 MUST NOT:

- fetch or clone a repository, resolve a mutable ref, or accept a remote URL;
- create a checkout, index, archive, or materialized executable tree;
- invoke hooks, filters, credential helpers, remote helpers, Git LFS,
  submodule commands, scripts, fixtures, model calls, or pack content;
- authorize or record trial exposure, routing, learning, proposals,
  verification, decisions, evidence, merges, or promotion; or
- reinterpret a M444 audit, a matching digest, or local capture success as
  trust in the content.

The fixed blockers are `capture-custody-authentication-required`,
`sandbox-runner-required`, `exposure-verifier-required`, and
`outcome-attestation-required`. M445 remains only an observation-only paired
experiment protocol; M446 does not satisfy its runner, key, receipt, or
attestation omissions.

## Source Boundary

The source must be an existing, caller-supplied bare repository directory. M446
requires that directory to be owned by the current user and rejects symlinked
roots, non-bare layouts, common-directory redirects, worktree-local config, Git
alternates, HTTP alternates, grafts, shallow state, replace refs, and detected
promisor packs. It records the source directory's
physical identity before reading and requires the same identity and safety
checks after object traversal. Canonical source ancestors must be owned by the
current user or root and cannot be group-writable or non-sticky world-writable;
the repository root itself is current-user-owned and mode-private. A bounded
walk rejects symlinks, special files, foreign ownership, and mutable-by-others
permissions anywhere under `objects` both before and after traversal.

Git is resolved to the first absolute regular executable whose canonical
ancestry passes the same cross-principal mutation checks. Every invocation
must match the original device, inode, owner, mode, link count, size,
modification time, and change time before and after execution. Git runs without
a shell, with replacement objects and lazy fetch disabled, system/global
configuration redirected or disabled, prompts and pagers disabled, and stderr
discarded. The source must therefore already contain every required object.
This reduces ambient Git interpretation; it does not make an attacker-owned
repository or executable trustworthy against a same-principal race.

M446 supports Git `sha1` and `sha256` object formats. It reads the supplied
commit, its root tree, the selected subtree, and reachable blobs with bounded
`git cat-file` calls. It independently recomputes every `commit`, `tree`, and
`blob` OID using the repository's object format. The commit must contain
exactly one valid `tree` header. Malformed, missing, type-confused, unavailable,
or hash-mismatched objects fail closed and publish no successful receipt.

The compile-time source and expansion ceilings are:

- 32 MiB per source object-store file, 64 MiB across the complete object store,
  and 8,192 total source entries before any Git object parsing;
- 64 KiB local repository config, 4 KiB `HEAD`, and 8 MiB `packed-refs`,
  each stable-read from one owned non-writable regular file; common-directory
  redirects, worktree-local config, local includes, worktreeConfig, and
  promisor/partial-clone settings are rejected;
- 1 MiB per commit object and per tree object;
- 256 KiB per blob and 16 MiB total blob bytes;
- 2,048 parsed ancestor entries and 2,048 expanded paths, depth 12, and 4,096
  UTF-8 bytes per path; shared Git tree objects count at every expanded path;
- at most `MAX_ENTRIES + 64` Git invocations;
- a 30-second pre-commit computation deadline and at most 5 seconds per Git
  invocation; and
- a 24 MiB canonical bundle.

Callers cannot relax these limits through the public options.

## Tree Semantics

Tree names are parsed from raw NUL-delimited Git tree bytes and decoded with
fatal UTF-8 validation. Each path segment must already be NFC, be at most 255
UTF-8 bytes, and exclude empty/dot segments, `.git`, slash, backslash, control
characters, Windows-reserved characters and device names, and trailing dots or
spaces. Per-directory NFC plus deterministic lowercase collisions fail closed rather
than being silently normalized.

Only tree mode `040000`, regular-file modes `100644` and `100755`, and symlink
mode `120000` are represented. Gitlinks (`160000`) and every other mode are
rejected. Executable mode is bound as metadata and bytes are never executed.

Symlinks remain inert blob bytes. M446 never creates or follows a filesystem
symlink. It resolves the relative target only against the captured in-memory
tree and binds both the raw target and final in-tree target into the portable
digest. Empty, invalid-UTF-8, absolute, backslash, escaping traversal, `.git`,
missing, or cyclic targets fail closed. Safe `..` components that remain inside
the captured tree are normalized and bound to their final target.

Git LFS pointer blobs are rejected as `lfs-pointer`; M446 does not fetch or
claim custody of the referenced payload. Gitlinks are likewise rejected
without recursion. Supporting either requires a separate protocol that binds
and verifies all external payload bytes.

## M444 Digest Bridge

M444's `packDigest` binds live-filesystem metadata and is intentionally not a
portable Git-tree identity. Its `portablePackDigest` uses the same canonical
tree construction as M446: regular files bind bytes with mode normalized to
`644`, directories use normalized mode `755` and bind ordered raw names and
child digests, and safe symlinks bind raw target bytes plus their resolved
in-tree target. The private M446 bundle separately binds each actual Git mode.
M446 deliberately accepts a narrower cross-platform path subset than M444 can
hash on a live POSIX filesystem. An M444 digest containing a non-NFC,
Windows-reserved, case-colliding, or otherwise non-portable name remains audit
metadata but cannot be consumed by M446 and fails closed before capture.

M446 recomputes that portable digest exclusively from verified Git objects and
requires exact equality with `expectedPortablePackDigest`. A mismatch is
`audit-digest-mismatch`. Equality connects the M444 audited snapshot to the
captured Git tree; it does not cure M444's live-path race, authenticate the
expected digest, or establish that the pack is structurally or behaviorally
eligible.

The private bundle additionally binds object format, full commit OID, commit
tree OID, selected pack tree OID, a hash of the selected subdirectory, ordered
entry paths and modes, Git OIDs, independent SHA-256 content digests, and the
captured bytes. `sourceIdentity` binds the Git provenance tuple, while
`captureDigest` domain-separates and binds the canonical bundle bytes.
After constructing the canonical receipt bytes, M446 derives
`captureReceiptDigest` as
`SHA-256("ashlr:external-skill-capture-receipt:v1\\0" || receiptBytes)`.
The digest is not stored inside the receipt because that would be
self-referential. It is returned only after the exact bytes have been
published and durably reread.

## Store And Publication

The default store is
`~/.ashlr/fleet/external-skill-quarantine/v1`. Its root, `objects`, `receipts`,
`staging`, and `locks` directories must pass private-storage checks. M446 uses
an exact-private local-store lock and publishes files with private modes,
no-follow/exclusive staging, descriptor identity checks, file durability, and
stable rereads. The canonical anchor and every store directory are protected
from cross-principal replacement, and their device/inode identities remain
pinned across lock acquisition, publication, and final verification.

Publication is no-clobber and commit-last:

1. write and durably stage the canonical bundle;
2. hard-link it to `objects/<captureDigest>.bundle` without replacement and
   fsync the containing directory;
3. publish `receipts/<captureDigest>.json` by the same no-clobber procedure;
4. reopen and byte-compare both installed files before returning success.

Captured and replayed results derive the same `captureReceiptDigest` from the
same canonical receipt bytes. Reordered keys, alternate whitespace, appended
bytes, or any other semantically equivalent but byte-distinct encoding is not
canonical and causes replay to fail as `store-conflict`; M446 never reparses or
normalizes an installed receipt into a new identity.

The computation deadline is checked before receipt publication begins. Once
the commit-marker critical section starts, synchronous link, fsync, reread,
and lock-release operations finish atomically or fail closed; Ashlr does not
claim that the operating system can hard-interrupt a blocked fsync at 30 seconds.

An exact existing bundle and receipt produce `replayed`. Existing bytes that
do not match produce `store-conflict`; M446 never overwrites or repairs them in
place. A bundle without its receipt is an inert crash artifact because the
receipt is the completion marker. Publication uses one deterministic candidate
per target. Replay fsyncs both pinned directories before accepting a visible
target; if target and candidate are the only two links to the exact bytes, it
durably collapses them back to one canonical link. Any uncertain state remains
non-authoritative and fails closed.

This is local content-addressed integrity, not authenticated immutable custody.
The receipt explicitly records `custodyAuthenticated: false`; it is unsigned
and lives under the same principal as the bundle. File modes, hard links,
hashes, stable reads, and fsync protect against accidental corruption and many
path/race failures, but they cannot stop that principal, root, the kernel, or
the storage service from replacing content after verification. Trial admission
must reopen and rehash content and must add an independent custody authority.

## Metadata Privacy

The public result contains fixed enums, hashes, and counts only. It omits the
repository path, selected subdirectory, commit message, author data, filenames,
symlink targets, blob contents, Git output, stderr, prompts, fixtures,
environment values, and commands.

The private bundle necessarily contains relative paths and base64-encoded pack
bytes, and its hashes are linkable. It belongs only in private quarantine
storage and must never be projected into learning ledgers or Fleet OS. M446
does not claim that external content is secret-safe; it only prevents that
content from appearing in its public result.

## Blockers And Non-Goals

M446 does not provide:

- network acquisition, independently authenticated repository identity or
  commit provenance, signed tags, publisher authentication, or license review;
- same-principal immutability, a separate capture UID, hardware-backed keys,
  signed receipts, external object lock, or append-only custody history;
- semantic content safety, prompt-injection analysis, correctness, usefulness,
  structural M444 eligibility, or behavioral M445 evidence;
- an execution sandbox, materializer, exposure verifier, outcome attestor,
  sequential testing, policy activation, or production integration;
- Git LFS payloads, submodules, working-tree filters, archive attributes,
  checkout semantics, or complete repository history; or
- protection after compromise of the capture principal, Git executable,
  signer, root, kernel, filesystem, or storage service.

Before any real external-skill trial, Ashlr still requires authenticated
immutable acquisition, separated custody and attestation keys, append-only
receipts, a disposable no-network sandbox, exact mount/exposure verification,
deterministic outcome evidence, and an independently trial-ready pack.

## Verification

`test/m446.external-skill-git-capture.test.ts` contains focused cases for:

- exact bare-repository capture into the private CAS with false authority;
- metadata-only public output and omission of private paths/text;
- idempotent replay with stable canonical receipt identity;
- full commit-OID enforcement, SHA-1/SHA-256 object formats, exact subtree
  selection, duplicate-ancestor rejection, and rejection of refs or non-commit
  object identities;
- rejection of unknown fields, non-bare sources, portable-digest mismatch,
  Git LFS pointers, gitlinks, alternate stores, and case-fold collisions;
- inert binding of direct and intermediate internal symlinks and rejection of
  broken, escaping, or `.git` targets;
- preservation of executable mode as inert bundle metadata; and
- detection of tampered bundle or non-canonical receipt bytes without repair
  or overwrite;
- rejection of oversized individual and aggregate object stores, oversized
  repository control files, and externally including local Git config before
  invoking Git object parsing;
- recovery of an interrupted hard-link handoff; and
- a TypeScript-AST import-graph assertion that permits only the public
  type-only export and rejects runtime authority edges. The supplemental fence
  scans TypeScript and JavaScript string literals so a module path first stored
  in a variable is also visible; it is still not a same-principal security
  boundary against deliberately obfuscated source construction.

M444 tests separately verify that `portablePackDigest` is stable across local
permission changes while its forensic `packDigest` still changes. M446's
private capture envelope separately binds executable Git modes.

The current focused suite is necessary but not sufficient evidence for hostile
custody. Before M446 can support a real trial, verification must add malformed
raw commit/tree/blob fixtures, OID corruption, replace/graft/promisor rejection,
Unicode-normalization and reserved-name collisions, symlink cycles, every
limit boundary, executable replacement fault injection, source and destination swap races,
concurrent publication, crash/fault injection at each durability step, replay
conflicts, Windows ACL/reparse behavior, and privacy canaries in remaining Git
error and symlink fields. Windows capture must remain withheld until those ACL
and executable-custody tests exist.
