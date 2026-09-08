# Findings

PR372 forwards one explicit runtime path across portfolio campaigns. It does not
refresh quota observations or turn capacity withholding into an automatic queue.
Investigate existing quota refresh and supervisor contracts before implementation.
# Selected contract

Optional private quotaConfigPath, no portable schema changes. One sequential
metadata attempt per configured alias before one unchanged resource admission.
Shared console lease and pending marker; cleanup confirmed before admission.
File denials remain separate vetoes; failed managed reads never fall back to
older readiness. All elapsed time counts against the existing generation budget.
Existing task receipts skip new probes. Parallel same-root collectors refuse,
not queue; maxParallel 1 is the recommended initial portfolio configuration.
