# Inspect Phantom companions

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
