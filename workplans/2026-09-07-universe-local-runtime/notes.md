# Local runtime findings

- PR361 source is merged; its exact unpublished candidate was independently tested.
  Source completion did not activate services or publish npm.
- `install.sh` installs dependencies/builds a mutable checkout, then points the
  user's global local-bin symlink at it. It is not a pinned package installation.
- Existing `ashlr serve` binds loopback and supports explicit foreground launch
  and graceful SIGINT/SIGTERM shutdown. Its startup output contains local access
  tokens; test tooling must not expose these as general progress output.
- The selected implementation is a pinned local candidate installer, not a new
  activation service. Existing unsigned manifests cover runtime code, the bundled
  dependency tree and the observed Node executable. They do not attest publisher
  authenticity or production qualification.
- The maintained node-tar 7.5.22 Header reader parses USTAR headers. The installer
  admits only bounded regular entries with canonical portable paths, then writes
  verified bytes exclusively into an empty private stage. The official API and
  security guidance were checked at https://github.com/isaacs/node-tar.
- PR361's 9,088,577-byte baseline archive was read and extracted successfully:
  5,713 regular entries; SHA256
  `05b523868db8a7f54e53e405746bae98145abc321c854d09b83b5b5db675e46c`.
  This is an input compatibility check, not the new increment's release artifact.
- Initial independent acceptance passed 16/16. Production-only npm audit reported
  zero vulnerabilities after adding the pinned parser and five bundled transitives.
- Review corrections: verify current and previous independently; allow recovery
  from a damaged current package; catch post-publication finalization failures;
  never override HOME for smoke; bound child cancellation without broad signals.
