# Inspect Phantom companions

`phm companions` inspects separately installed Phantom Secrets, Locus and Lexicon.

Phantom Secrets, Locus and Lexicon are separate tools with existing workbench
clients. They are not bundled into this workbench package. Inspect installed
executables without reading project configuration or starting a service:

```sh
phm companions
phm companions --json
```

The inventory runs only `--version` and `--help`, using disposable working and
configuration roots with a scrubbed environment. It never invokes a package
manager, reads vault or identity state, registers MCP, accepts project trust,
starts a listener or enables resident authority. Selected executables must be
trusted: a version/help probe executes their code; this is not a sandbox.

| Product | Executable | Reviewed release | Source commit |
| --- | --- | --- | --- |
| Phantom Secrets | `phantom` | [0.7.9](https://github.com/ashlrai/phantom-secrets/releases/tag/v0.7.9) | `7a51ce512ec4aee12cc29ff859036af63fbe93db` |
| Locus | `locus` | [0.5.0](https://github.com/ashlrai/locus/releases/tag/v0.5.0) | `e7bced3cd4cb4adf08bbba020f2e05f163b55941` |
| Lexicon | `lexicon` | [0.5.4](https://github.com/ashlrai/lexicon/releases/tag/v0.5.4) | `6ebc0721e33de2dafafbb54d89a6af50a362046a` |

These pins describe reviewed CLI identity/version surfaces. They do not prove
artifact provenance, runtime contract support or installed readiness. Verify
the selected release artifacts before a separate manual installation. The
workbench command is `phm` (compatible `ashlr`); `phantom` belongs to Secrets.

## Select an installation explicitly

Default discovery examines absolute directories in PATH. Empty/relative PATH
entries are ignored; the current project directory is not searched implicitly.
An explicit absolute PATH entry can select it. Multiple distinct
executables are reported as ambiguous and are not run. Symlinks to the same
physical executable count once. Explicit paths replace discovery for that tool:

```sh
phm companions --secrets-bin /absolute/private/bin/phantom --json
phm companions --bin-dir "/absolute/installation with spaces/bin" --json
phm companions --root /absolute/installation --json
```

`--root` searches only its `bin` directory. Repeated `--bin-dir` and `--root`
options build an explicit search list instead of PATH. `--locus-bin` and
`--lexicon-bin` select the other tools; explicit missing paths remain missing,
with no fallback to another executable. Relative paths are usage errors.
Secrets and Locus probes require a native ELF, Mach-O or PE executable; Node/npm
shims and shell wrappers are refused even with an explicit path. Lexicon's
installed Node CLI entrypoint can be probed. Windows native executables can be discovered, but `.cmd` launchers are not
executed through a shell; select a native executable or review the unsupported
launcher separately. Known legacy npm bootstrap scripts that download/install
on first invocation are also refused; select their already installed native
binary. This recognition is not a proof that arbitrary executable code is safe.
Cross-platform qualification is still required.

## Interpret the report

JSON carries `schemaVersion: 1`, `bundled: false` and `probe: "version-help-only"`.
Each tool reports its path, candidates, product identity, version, reviewed
release and guidance. No raw subprocess output is included.

| Status | Meaning and next step |
| --- | --- |
| `missing` | No executable candidate; review the release's installation guide separately. |
| `ambiguous` | Multiple physical candidates; choose a trusted absolute executable path. |
| `unsupported-launcher` | Secrets/Locus is not native, or the launcher is unsupported/bootstrap code; select an already installed executable. |
| `probe-failed` | Version/help failed, timed out, exceeded bounds or uses an unsupported launcher. |
| `wrong-product` | The version/help identity does not match the expected companion. |
| `unsupported-version` | Product identified, but its version has no reviewed contract in this inventory. |
| `known-interface` | Exact version and help identity match; only the CLI surface is known. |

`installed: true` means the executable identifies the intended product, including
unsupported versions. `compatibility: "known-cli-surface"` means the pinned
identity/version matched. `runtimeCapability` remains `"not-inspected"` for
every result. Neither field establishes Secrets injection, Locus tenant or MCP
session readiness, Lexicon service/project trust, or authority to run agents.
Exit 0 means the inventory completed, including missing/incompatible tools;
exit 2 means invalid arguments. Use the per-tool status for first-run decisions.

See [product names](PHANTOM-BRAND.md) and [first-run guidance](QUICKSTART.md#open-verse).

## Verify a local provisioning plan

The following commands are implemented in this unreleased source change. The
published 3.29.4 package still provides inventory only.

An operator can review an expanded local artifact file set against an
independently verified manifest SHA256 before planning installation:

```sh
phm companions plan --artifacts /absolute/reviewed-artifacts \
  --manifest manifest.json --sha256 VERIFIED_MANIFEST_SHA256 \
  --root /absolute/existing-destination-parent --json
```

Both roots must already exist as canonical absolute directories without
symlink components. The manifest path is relative to the artifact root. Obtain
the complete manifest digest from a separately reviewed release record; taking
it from the unverified artifact directory itself provides no independent trust.
The manifest must bind the exact reviewed product version/source/release URL,
host platform, explicit file names, sizes, SHA256 values and intended modes.
It must mark the artifact qualified; a declaration alone is not release evidence.
No manifest or qualification assertion is generated from installed versions.

The command checks complete file bytes, refuses unsafe links and unexpected
destination contents, and reports `create`, `replace` or `retain` observations.
Existing file hashes describe before images; no backup or installation occurs.
`installed:false`, `runtimeCapability:"not-inspected"`, `effects:[]` and required
revalidation remain explicit. Exit 0 means a verified plan, exit 1 a blocked
plan, and exit 2 bad usage. There is no download, archive extraction, source-build
fallback or apply flag. A plan does not authorize applying its observations.
The separate explicit installer below accepts only a fresh destination slot.

Locus 0.5.0 release archives lack published checksum sidecars. Do not invent a
qualified manifest or execute its unpinned source fallback to fill that gap.
Cross-platform artifacts, installation and clean-machine MCP acceptance remain
separate qualification steps.

## Install verified local files explicitly

This installer is implemented in the unreleased source change. It does not
download companions or run a package manager. Review an expanded local file set,
its independent complete manifest digest, the target root and an existing Python
runtime before authorizing this filesystem mutation:

```sh
phm companions install --artifacts /absolute/reviewed-artifacts \
  --manifest manifest.json --sha256 VERIFIED_MANIFEST_SHA256 \
  --root /absolute/private-companions \
  --python /absolute/canonical/python3 --json
```

The destination root must already exist, belong to the invoking user, and have
no group or other permissions. The runtime must be a canonical absolute regular
executable with no group/other write permission. Additional hard links are
accepted only for a root-owned system runtime. No runtime is selected from PATH
or installed automatically. macOS and Linux
require the corresponding exclusive native rename operation. Unsupported
runtimes, platforms and filesystems are blocked without a fallback.

The installer rechecks the pinned manifest and complete source bytes/modes,
copies files into private staging using descriptor-relative operations, and
publishes a complete fresh `<tool>-<version>-<platform>` directory exclusively.
It never overlays, updates or removes an existing installation. Another process
publishing the same slot wins or loses without overwriting the winner. Files
remain data throughout installation: no version/help probe, configuration write,
credential retrieval, trust grant, MCP handshake or service startup occurs.

The returned anchor identifies the destination directory inode. This protects
operations from pathname redirection; it is not a sandbox against a hostile
process with the same user identity that can relocate or mutate owned files.
`installed:true` establishes the copied file set only, and
`runtimeCapability:"not-inspected"` remains explicit. Exit 0 means installed,
exit 1 blocked, exit 2 bad usage and exit 3 uncertain completion. For uncertain
completion, inspect the destination and preserved staging evidence before
retrying; no automatic rollback removes a possibly published directory.

A manifest may select a reviewed component such as a bundled MCP server rather
than the complete companion CLI. Record that distinction in its independent
qualification evidence. A synthetic test manifest or the manifest's own
`qualified` declaration cannot establish public artifact provenance. A shipped
qualified artifact catalog and platform-wide clean-install acceptance are still
required for automatic out-of-box provisioning.

## Register Lexicon for one project and client

Read-only ecosystem discovery now includes Lexicon. It reports service state
as unverified and does not register Lexicon into global workbench settings.
Select an existing project and an intended client explicitly:

```sh
phm mcp ecosystem --only lexicon --project /absolute/project \
  --client intended-client --config /absolute/project/.mcp.json
```

After reviewing the selected installed executable and project binding, adding
`--write` creates or extends only that project-local config. Existing unrelated
entries are preserved. Malformed, mismatched, escaping or dangling symlinked,
or multiply linked configurations are refused. An existing in-project symlink
resolves to its canonical target; repeating the same registration makes no write.
The direct `lexicon-mcp` entry uses no arguments, while a selected `lexicon`
CLI uses `mcp`. The entry has explicit `LEXICON_CWD` and a project/client-scoped
`LEXICON_PATH` under `.phantom/lexicon`. No vocabulary is opened, project trust
granted or MCP server started by registration.

Point the intended MCP client at that project config. Registration alone does
not prove client identity, MCP initialize/tools discovery, vocabulary acceptance
or provider availability. No identity is re-pinned and no resident grant is
changed.

## Consume the selected Lexicon config through Phantom

Use the same explicit project, client and config for gateway discovery:

```sh
phm mcp list --project /absolute/project --client intended-client \
  --config /absolute/project/.mcp.json --json
phm mcp --project /absolute/project --client intended-client \
  --config /absolute/project/.mcp.json
```

The first command validates metadata without starting Lexicon. The second starts
the gateway and selected downstream stdio process when invoked by an MCP client.
`phm mcp doctor` accepts the same binding flags and performs a real bounded
initialize/tools-list probe. These commands read only that selected Lexicon
registration, with no fallback to home configs. The exact installed executable,
launch arguments and project/client vocabulary paths must match; extra server
environment variables, including Lexicon's trust-bypass option, are refused.
For the reviewed Lexicon 0.5.x contract, the selected project must have its own
existing `.git` file or directory: Lexicon otherwise searches ancestor folders
for vocabulary before checking trust. Vocabulary and client trust/hit-state
paths must remain regular single-link files inside their selected scope;
redirecting state symlinks are refused without reading those files.
The downstream receives scoped HOME/XDG paths, an explicit project working
directory and a narrow runtime PATH, without provider configuration bridging.

This selects Lexicon's downstream binding. Native Phantom tools remain exposed
by the gateway under their existing authority rules; the binding does not create
an overall project authorization sandbox. A handshake or tools listing does not
grant vocabulary trust or prove a correction/provider workflow.
