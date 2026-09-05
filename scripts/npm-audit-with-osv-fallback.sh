#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: $0 <label> <lockfile> [--omit=dev]" >&2
  exit 64
fi

audit_label=$1
lockfile=$2
omit_arg=${3:-}
if [[ -n "${omit_arg}" && "${omit_arg}" != "--omit=dev" ]]; then
  echo "unsupported npm audit argument: ${omit_arg}" >&2
  exit 64
fi
if [[ ! -f "${lockfile}" ]]; then
  echo "npm audit lockfile is missing: ${lockfile}" >&2
  exit 66
fi

npm_command=("${AUDIT_NODE_BIN:-${AUDIT_NPM_BIN:-npm}}")
if [[ -n "${AUDIT_NPM_CLI:-}" ]]; then
  npm_command+=("${AUDIT_NPM_CLI}")
fi
osv_bin=${AUDIT_OSV_BIN:-osv-scanner}
timeout_bin=${AUDIT_TIMEOUT_BIN:-timeout}
audit_tmp=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ashlr-npm-audit.XXXXXX")
cleanup() {
  cleanup_rc=$?
  trap - EXIT
  if ! rm -rf -- "${audit_tmp}" && [[ ${cleanup_rc} -eq 0 ]]; then
    cleanup_rc=74
  fi
  exit "${cleanup_rc}"
}
trap cleanup EXIT
osv_config="${audit_tmp}/osv-scanner.toml"
: > "${osv_config}"
chmod 0600 "${osv_config}"

write_summary() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf -- '- %s\n' "$1" >> "${GITHUB_STEP_SUMMARY}"
  fi
}

is_valid_npm_report() {
  node -e '
    const fs = require("node:fs");
    try {
      const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const counts = report?.metadata?.vulnerabilities;
      if (report?.auditReportVersion !== 2 || typeof counts !== "object") process.exit(1);
      for (const severity of ["info", "low", "moderate", "high", "critical", "total"]) {
        if (!Number.isInteger(counts[severity]) || counts[severity] < 0) process.exit(1);
      }
    } catch {
      process.exit(1);
    }
  ' "$1"
}

is_clean_npm_report() {
  node -e '
    const fs = require("node:fs");
    try {
      const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const counts = report?.metadata?.vulnerabilities;
      for (const severity of ["info", "low", "moderate", "high", "critical", "total"]) {
        if (counts?.[severity] !== 0) process.exit(1);
      }
    } catch {
      process.exit(1);
    }
  ' "$1"
}

npm_args=(audit --json --ignore-scripts --audit-level=low --fetch-retries=0 --fetch-timeout=30000)
if [[ -n "${omit_arg}" ]]; then
  npm_args+=("${omit_arg}")
fi

transport_pattern='network timeout|service unavailable|ECONN|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|socket hang up|audit endpoint returned an error|request to .* failed|HTTP (408|429|5[0-9]{2})'
for attempt in 1 2 3; do
  stdout_file="${audit_tmp}/npm-${attempt}.json"
  stderr_file="${audit_tmp}/npm-${attempt}.stderr"
  if "${timeout_bin}" --signal=TERM --kill-after=5s 40s \
    "${npm_command[@]}" "${npm_args[@]}" > "${stdout_file}" 2> "${stderr_file}"; then
    audit_rc=0
  else
    audit_rc=$?
  fi

  cat "${stdout_file}"
  cat "${stderr_file}" >&2

  if [[ ${audit_rc} -eq 0 ]]; then
    if ! is_valid_npm_report "${stdout_file}"; then
      write_summary "${audit_label}: npm returned success without a valid audit v2 report; failed closed."
      exit 70
    fi
    if ! is_clean_npm_report "${stdout_file}"; then
      write_summary "${audit_label}: npm returned success with nonzero vulnerability counts; failed closed."
      exit 1
    fi
    write_summary "${audit_label}: primary npm audit passed with a valid audit v2 report."
    exit 0
  fi

  # A valid nonzero audit report is a vulnerability result, not a transport
  # failure. Never route it through the fallback provider.
  if is_valid_npm_report "${stdout_file}"; then
    write_summary "${audit_label}: primary npm audit reported vulnerabilities; failed closed."
    exit "${audit_rc}"
  fi

  if [[ ${audit_rc} -ne 124 && ${audit_rc} -ne 137 ]] &&
    ! grep -Eiq "${transport_pattern}" "${stdout_file}" "${stderr_file}"; then
    write_summary "${audit_label}: npm failed for a non-transport reason; fallback was not authorized."
    exit "${audit_rc}"
  fi

  if [[ ${attempt} -lt 3 ]]; then
    sleep "$((attempt * 5))"
  fi
done

write_summary "${audit_label}: npm transport failed after 3 bounded attempts; invoking pinned OSV-Scanner."
if "${timeout_bin}" --signal=TERM --kill-after=5s 60s \
  "${osv_bin}" scan source --config "${osv_config}" --lockfile "${lockfile}" --format table; then
  write_summary "${audit_label}: pinned OSV-Scanner fallback passed for ${lockfile}."
  exit 0
else
  audit_rc=$?
  write_summary "${audit_label}: pinned OSV-Scanner fallback failed; no provider returned a clean result."
  exit "${audit_rc}"
fi
