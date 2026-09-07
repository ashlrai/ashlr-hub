# Verification record

Current local checks: full web suite 457/457 across 43 files; backend/web
typecheck; full lint (0 errors, 105 existing warnings); real-IO lane classification;
8-entrypoint offline docs navigation and git diff --check. Backend integration,
clean artifact identity, installed acceptance and browser verification follow.

Broad resource selection: 1,142 passing tests in 26 files, with a separate final
97-test native probe pass after the notification-timestamp patch. These overlap
and must not be added together. Independent agents reviewed the storage envelope,
compatibility classifier and protocol change. This is selected verification, not
the exhaustive production release gate.

Actual native diagnosis: one old-CLI task failed due to a structured CLI/model
compatibility rejection. The first newer bundled-CLI attempt stopped at metadata
validation, with zero model calls. These are negative evidence, not completion
or accepted engineering yield. Private captures and receipts live outside Git.

One new public-boundary test initially omitted mandatory assignment snapshot
counts; the fixture was corrected and all 56 tests in that file passed. No
production guard was weakened to satisfy the test.
