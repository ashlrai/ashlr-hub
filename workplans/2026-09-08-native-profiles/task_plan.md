# Native account activation

Goal: make separate subscription launchers operational without copying credentials
or altering desktop authentication; advance the verified Grok adapter path.

- [x] Map reusable enrollment and native integration patterns with agents.
- [x] Build and test isolated profile preparation using supported native settings.
- [x] Prepare actual local profiles and establish where native login is required.
- [x] Verify scoped source and record exact activation state.
- [ ] Publish source and verify its exact offline package (external release receipt).

Preserve independent products and existing work. No Actions, paid API fallback,
quota resets or fabricated account/quota evidence. Native sign-in may require user
interaction; do not perform it against an unintended browser account.

Status: implementation and source checks complete. Based on merged PR377.
Errors: initial directory metadata check confirmed native-profiles did not yet
exist. A documentation patch context missed a wrapped line; reapplied with exact
context. Agent test fixtures initially omitted fixed Codex args; corrected without
weakening the production contract. No native login was attempted during discovery.
The initial full typecheck found a widened provider return type in the new CLI;
fixed with a const-qualified parse result. Final typecheck/build passed.

Activation update: two fresh Codex profiles were prepared under the selected
private native-profiles parent, plus one isolated Claude profile. Native help
checks passed; Codex created its own tmp subdirectories there. First native
Codex browser login was started separately;
user interaction is required and is not equivalent to successful authentication.
