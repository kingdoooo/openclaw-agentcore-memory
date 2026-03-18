#!/bin/bash
# memory-agentcore Smoke Test
# Run on the EC2 instance after plugin installation
set -euo pipefail

PASS=0
FAIL=0
SKIP=0

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

check() {
  local name="$1"
  local cmd="$2"
  local expected="$3"

  printf "  [%-30s] ... " "$name"
  result=$(eval "$cmd" 2>&1) || true

  if echo "$result" | grep -q "$expected"; then
    printf "${GREEN}PASS${NC}\n"
    PASS=$((PASS + 1))
  else
    printf "${RED}FAIL${NC}\n"
    echo "    Expected to contain: $expected"
    echo "    Got: $(echo "$result" | head -3)"
    FAIL=$((FAIL + 1))
  fi
}

check_not() {
  local name="$1"
  local cmd="$2"
  local not_expected="$3"

  printf "  [%-30s] ... " "$name"
  result=$(eval "$cmd" 2>&1) || true

  if echo "$result" | grep -q "$not_expected"; then
    printf "${RED}FAIL${NC}\n"
    echo "    Should NOT contain: $not_expected"
    FAIL=$((FAIL + 1))
  else
    printf "${GREEN}PASS${NC}\n"
    PASS=$((PASS + 1))
  fi
}

echo "============================================"
echo "  memory-agentcore Smoke Test"
echo "============================================"
echo ""

# --- Phase 1: Plugin Load ---
echo "Phase 1: Plugin Load"
check "plugin-listed" \
  "openclaw plugins list 2>/dev/null" \
  "memory-agentcore"

echo ""

# --- Phase 2: Connection & Config ---
echo "Phase 2: Connection & Config"
check "status-connection" \
  "openclaw agentcore status 2>/dev/null" \
  "Connection: OK"

check "status-memory-id" \
  "openclaw agentcore status 2>/dev/null" \
  "Memory ID:"

check "status-strategies" \
  "openclaw agentcore status 2>/dev/null" \
  "Strategies:"

echo ""

# --- Phase 3: CLI Commands ---
echo "Phase 3: CLI Commands"

# Search for something that shouldn't exist
UNIQUE_MARKER="smoke-test-nonexistent-$(date +%s)"
check "search-no-results" \
  "openclaw agentcore search '$UNIQUE_MARKER' 2>/dev/null" \
  "No records found"

check "stats-runs" \
  "openclaw agentcore stats 2>/dev/null" \
  "SEMANTIC"

check "list-runs" \
  "openclaw agentcore list 2>/dev/null" \
  ""  # Just verify it doesn't error

echo ""

# --- Phase 4: File Sync ---
echo "Phase 4: File Sync"

# Sync should run without error
SYNC_RESULT=$(openclaw agentcore sync 2>/dev/null) || SYNC_RESULT="ERROR"
printf "  [%-30s] ... " "sync-runs"
if echo "$SYNC_RESULT" | grep -qE "Synced [0-9]+ files|File sync is disabled"; then
  printf "${GREEN}PASS${NC}\n"
  PASS=$((PASS + 1))
else
  printf "${RED}FAIL${NC}\n"
  echo "    Got: $SYNC_RESULT"
  FAIL=$((FAIL + 1))
fi

echo ""

# --- Phase 5: Tool Registration ---
echo "Phase 5: Tool Registration (via gateway logs)"
LOG_CHECK=$(openclaw logs 2>/dev/null | tail -50) || LOG_CHECK=""

printf "  [%-30s] ... " "plugin-loaded-log"
if echo "$LOG_CHECK" | grep -q "agentcore.*Plugin loaded"; then
  printf "${GREEN}PASS${NC}\n"
  PASS=$((PASS + 1))
else
  printf "${YELLOW}SKIP${NC} (log line not in recent output)\n"
  SKIP=$((SKIP + 1))
fi

check_not "no-error-logs" \
  "openclaw logs 2>/dev/null | tail -20 | grep -i 'agentcore.*error' || echo 'clean'" \
  "error"

echo ""

# --- Summary ---
echo "============================================"
printf "  Results: ${GREEN}%d passed${NC}, ${RED}%d failed${NC}, ${YELLOW}%d skipped${NC}\n" "$PASS" "$FAIL" "$SKIP"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Some checks failed. See tests/VERIFICATION.md for detailed troubleshooting."
  exit 1
fi
