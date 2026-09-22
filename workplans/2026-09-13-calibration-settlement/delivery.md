# Delivery evidence

165 tests passed in preparation-calibration-driver, universe-preparation-measurement-capture and universe-preparation-measurement-calibration. These are targeted driver/receipt tests, not a completed full calibration or production acceptance. Native qualification remains running separately at its frozen source identity.

ESLint on both changed code files, Node syntax validation, strict TypeScript validation of the driver test, documentation checks, real-I/O lane checks and git diff --check passed.

Branch: codex/calibration-settlement-receipt, based on 18e26e7d0d6fe0eb48bbb896bcef3cb1918929b1. The qualification worktree remains clean at that base with matching clean build identity. This branch changes only the retained calibration driver, its isolated tests and these planning records. No runtime schema, account policy, mission shutdown behavior or production state changed. Entire found no checkpoint to resume.

Before calibration: finish the existing native qualification, integrate this driver fix deliberately, build and pin the resulting source/evaluator identity, and prepare a fresh capture root. The historical held calibration cannot be promoted. The old external launcher still pins the old primary source, evaluator, qualification session and driver checksum and must not be reused unchanged.
