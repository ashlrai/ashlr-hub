# Publish Phantom MCP Registry metadata

The manual `Publish Phantom MCP Registry metadata` workflow publishes discovery metadata for the already-published `phantom-secrets-mcp` npm release. It does not publish npm, execute Phantom code, install software, start services, or authorize the resident fleet.

Run it from the reviewed `ashlrai/ashlr-hub` **master** branch after the workflow is merged. It requires an immutable Phantom source commit, source-manifest SHA-256, supported-field payload SHA-256, version, and accepted npm SHA-512 integrity. Defaults are the reviewed 0.7.9 release. Future releases require new reviewed values; do not substitute current HEAD or latest npm. Inputs enter environment variables, never shell code.

The workflow downloads the exact `mcp-registry/server.json` Git blob and omits only its unsupported `tools` field. Both original bytes and resulting supported-field JSON are pinned. The 0.7.9 source contains 54 tools; published-native tool annotations have a separately recorded variance, so this metadata publication does not claim strict runtime catalog parity.

Before contact, the helper checks the exact npm package name/version/mcpName/integrity and hashes the whole anonymously downloaded tarball without installing it. Only a structured exact-version Registry JSON 404 permits publication. An existing active exact match is success without another publish only when latest also matches and is marked latest; mismatched, deleted, deprecated, malformed, forbidden, or unreachable records hold.

Authentication uses the official publisher 1.8.1, with pinned Linux archive/checksum-manifest digests. GitHub Actions owner OIDC grants `io.github.ashlrai/*`; it does not require the interactive GitHub App or an organization-membership lookup. The registry itself does not enforce a branch or repository restriction, so the manual owner/repository/master job guard is essential. Normal repository review/dispatch access controls still apply. No PAT or npm token is used.

All checks run again after login. A single publish command is followed by bounded public exact-version and latest readback. Uncertain command outcomes are reconciled through GET only, never blind POST retries. If confirmation fails, inspect the public record before a new dispatch. Child output is discarded because auth errors may contain credentials. The workflow logs only public digests/state and removes only its owned private authentication HOME/cwd; it does not read ambient saved tokens. Cancelling or timing out an owned child terminates its process group before cleanup.

Offline checks, requiring Node 22 and no dependency installation:

```sh
node --test .github/tests/mcp-registry-publication.test.mjs
```

Source capability and offline checks do not establish a successful OIDC exchange or public Registry publication. Only the actual workflow exit and exact official readback establish that layer.

Primary references: [official OIDC namespace implementation](https://github.com/modelcontextprotocol/registry/blob/v1.8.1/internal/api/handlers/v0/auth/github_oidc.go), [publisher OIDC client](https://github.com/modelcontextprotocol/registry/blob/v1.8.1/cmd/publisher/auth/github-oidc.go), [Actions publishing guidance](https://github.com/modelcontextprotocol/registry/blob/v1.8.1/docs/modelcontextprotocol-io/github-actions.mdx), [pinned release checksums](https://github.com/modelcontextprotocol/registry/releases/download/v1.8.1/registry_1.8.1_checksums.txt).
