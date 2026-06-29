#!/usr/bin/env bash
# ashlr-menubar.1m.sh — SwiftBar / xbar plugin for ashlr fleet dashboard
#
# INSTALL (one-liner):
#   cp "$(npm root -g)/ashlr/scripts/ashlr-menubar.1m.sh" \
#      "$HOME/Library/Application Support/SwiftBar/Plugins/"
#   chmod +x "$HOME/Library/Application Support/SwiftBar/Plugins/ashlr-menubar.1m.sh"
#
# For a locally-cloned repo:
#   cp /path/to/ashlr-hub/scripts/ashlr-menubar.1m.sh \
#      "$HOME/Library/Application Support/SwiftBar/Plugins/"
#   chmod +x "$HOME/Library/Application Support/SwiftBar/Plugins/ashlr-menubar.1m.sh"
#
# The filename suffix ".1m" tells SwiftBar to refresh every 1 minute.
# Change to ".5m" for 5-minute polling, ".30s" for 30-second polling, etc.
#
# REQUIREMENTS:
#   - SwiftBar (https://swiftbar.app) OR xbar (https://xbarapp.com) installed
#   - ashlr installed (npm install -g ashlr or local build)
#
# GRACEFUL DEGRADATION:
#   If SwiftBar is not installed this script has no effect.
#   The web dashboard (ashlr dashboard) and `ashlr serve` work independently.
#
# FORMAT NOTES (SwiftBar / xbar plugin protocol):
#   - First line printed = menu-bar title
#   - Lines after "---" = dropdown items
#   - Lines with "| href=URL" are clickable links
#   - Lines with "| bash=CMD param1=A ..." are clickable shell commands
#   - Lines with "| color=..." set item color
#   - Lines with "| font=..." set item font
# ---------------------------------------------------------------------------

# ── Locate ashlr ────────────────────────────────────────────────────────────

ASHLR=""
for candidate in \
    "$(command -v ashlr 2>/dev/null)" \
    "$HOME/.local/bin/ashlr" \
    "/opt/homebrew/bin/ashlr" \
    "/usr/local/bin/ashlr"; do
  if [[ -x "$candidate" ]]; then
    ASHLR="$candidate"
    break
  fi
done

DASHBOARD_URL="http://127.0.0.1:4317"

# ── Fallback: ashlr not found ───────────────────────────────────────────────

if [[ -z "$ASHLR" ]]; then
  echo "⚫ ashlr"
  echo "---"
  echo "ashlr not found in PATH | color=red"
  echo "Install: npm install -g ashlr | color=gray"
  exit 0
fi

# ── Collect data ─────────────────────────────────────────────────────────────
# Use `ashlr usage --json` for frontier usage and `ashlr dashboard --status
# --json` for the serve service state. Both degrade gracefully on cold start.

USAGE_JSON=""
USAGE_JSON=$("$ASHLR" usage --json 2>/dev/null) || USAGE_JSON=""

STATUS_JSON=""
STATUS_JSON=$("$ASHLR" dashboard --status --json 2>/dev/null) || STATUS_JSON=""

# ── Parse JSON (pure bash — no jq dependency) ────────────────────────────────
# Extracts the first numeric value for a key from a flat JSON object.

json_num() {
  local json="$1" key="$2"
  echo "$json" | grep -oE "\"${key}\"[[:space:]]*:[[:space:]]*[0-9.]+" \
    | head -1 \
    | grep -oE '[0-9.]+$'
}

json_str() {
  local json="$1" key="$2"
  echo "$json" | grep -oE "\"${key}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -1 \
    | sed 's/.*": *"//' \
    | tr -d '"'
}

json_bool() {
  local json="$1" key="$2"
  echo "$json" | grep -oE "\"${key}\"[[:space:]]*:[[:space:]]*(true|false)" \
    | head -1 \
    | grep -oE '(true|false)$'
}

# ── Derive menu-bar summary ───────────────────────────────────────────────────

SERVE_RUNNING="$(json_bool "$STATUS_JSON" running)"

if [[ "$SERVE_RUNNING" == "true" ]]; then
  STATUS_ICON="🟢"
  STATUS_LABEL="fleet"
else
  STATUS_ICON="🔴"
  STATUS_LABEL="fleet (off)"
fi

# Parse engines array: extract usedPct values and find the max
MAX_USED_PCT=0
if [[ -n "$USAGE_JSON" ]]; then
  while IFS= read -r pct; do
    pct="${pct//[[:space:]]/}"
    if [[ -n "$pct" ]] && (( pct > MAX_USED_PCT )); then
      MAX_USED_PCT=$pct
    fi
  done < <(echo "$USAGE_JSON" | grep -oE '"usedPct"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+$')
fi

# Count frontier engines (engines with callsToday > 0 or any data)
FRONTIER_COUNT=0
if [[ -n "$USAGE_JSON" ]]; then
  FRONTIER_COUNT=$(echo "$USAGE_JSON" | grep -o '"engine"' | wc -l | tr -d ' ')
fi

# Build one-liner menu bar title
MENUBAR_TITLE="${STATUS_ICON} ${STATUS_LABEL}"
if [[ $FRONTIER_COUNT -gt 0 ]]; then
  MENUBAR_TITLE="${MENUBAR_TITLE} · ${FRONTIER_COUNT} frontier · ${MAX_USED_PCT}% quota"
fi

echo "$MENUBAR_TITLE"
echo "---"

# ── Dropdown items ────────────────────────────────────────────────────────────

# Dashboard link
echo "Open Dashboard | href=${DASHBOARD_URL} color=#0078d4"

echo "---"

# Service state
if [[ "$SERVE_RUNNING" == "true" ]]; then
  echo "Dashboard: Running on port 4317 | color=green"
else
  echo "Dashboard: Not running | color=red"
  echo "Start Dashboard | bash=$ASHLR param1=dashboard terminal=false refresh=true"
fi

echo "---"

# Per-engine frontier usage
if [[ -n "$USAGE_JSON" && $FRONTIER_COUNT -gt 0 ]]; then
  echo "Frontier Usage"

  # Extract engine names
  while IFS= read -r engine_name; do
    engine_name="${engine_name//\"/}"
    echo "  ${engine_name} | color=gray"
  done < <(echo "$USAGE_JSON" | grep -oE '"engine"[[:space:]]*:[[:space:]]*"[^"]+"' | sed 's/.*: *//' | tr -d '"' | head -6)
else
  echo "No frontier usage data | color=gray"
fi

echo "---"

# Pending proposals
PENDING_PROPOSALS=""
PENDING_PROPOSALS=$("$ASHLR" daemon status --json 2>/dev/null | grep -oE '"pendingProposals"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+$') || PENDING_PROPOSALS=""

if [[ -n "$PENDING_PROPOSALS" && "$PENDING_PROPOSALS" != "0" ]]; then
  echo "⚠ ${PENDING_PROPOSALS} pending proposal(s) | color=orange"
  echo "Review Inbox | bash=$ASHLR param1=inbox terminal=true"
else
  echo "No pending proposals | color=gray"
fi

echo "---"

# Quick actions
echo "Stop Dashboard | bash=$ASHLR param1=dashboard param2=--stop terminal=false refresh=true"
echo "Refresh | refresh=true"
